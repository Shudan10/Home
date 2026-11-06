#!/bin/sh
# Brings up the Mullvad tunnel, the routing that sends the tailnet's internet
# traffic into it and nowhere else, and then Tailscale as an exit node.
#
# Two kinds of step, and they fail differently. The tunnel, the IPv4
# masquerade and the routing that is the kill switch are the whole point: if
# any of them cannot be set up, this exits non-zero with a line saying which,
# rather than run as an exit node whose traffic might leave by the home
# connection. Everything else -- the MSS clamp, IPv6 through the tunnel -- is
# better to have than not, and a failure there is logged and lived with.
#
# Every step is safe to run again. A restart normally gets a fresh network
# namespace and nothing is left over, but "normally" is not a kill switch, so
# each rule is checked before it is added and nothing is ever added twice.
set -eu

: "${WG_PRIVATE_KEY:?the Mullvad WireGuard key is missing}"
: "${WG_ADDRESS:?the Mullvad tunnel address is missing}"
: "${WG_PEER_PUBLIC_KEY:?the Mullvad server key is missing}"
: "${WG_ENDPOINT:?the Mullvad server address is missing}"
TS_HOSTNAME="${TS_HOSTNAME:-home-mullvad}"

# Mullvad's resolver, reached through the tunnel. Exit-node clients have their
# DNS answered by this machine, so this is also what keeps their lookups from
# leaking out to the home connection's DNS.
MULLVAD_DNS=10.64.0.1
TABLE=51820
PRIORITY=100

log() { echo "mullvad-exit: $*"; }
warn() { echo "mullvad-exit: warning: $*" >&2; }
die() {
    echo "mullvad-exit: FATAL: $*" >&2
    echo "mullvad-exit: stopping rather than run an exit node that is only half set up." >&2
    exit 1
}

# ------------------------------------------------------------- firewall ---
# nftables, not the legacy iptables. Tailscale's image points plain
# `iptables` at the legacy backend, and on a current kernel legacy ip6tables
# cannot even load its nat table -- ip6table_nat is not built in and nothing
# loads it -- so the IPv6 masquerade below used to fail every time, with the
# error swallowed. The nft backend needs only nf_tables, which every kernel
# Docker runs on has. The legacy pair is kept as a fallback for a kernel that
# genuinely lacks nf_tables.
#
# tailscaled has to be told the same thing: it writes its own forwarding and
# masquerade rules, and rules split across both backends are evaluated in an
# order neither of them knows about.
if command -v iptables-nft >/dev/null 2>&1 && iptables-nft -t nat -L -n >/dev/null 2>&1; then
    IPT=iptables-nft
    IP6T=ip6tables-nft
    TS_DEBUG_FIREWALL_MODE=nftables
else
    IPT=iptables-legacy
    IP6T=ip6tables-legacy
    TS_DEBUG_FIREWALL_MODE=iptables
    warn "nftables is not usable here, so falling back to legacy iptables"
fi
export TS_DEBUG_FIREWALL_MODE
log "firewall: $TS_DEBUG_FIREWALL_MODE ($IPT, $IP6T)"

# Adds a rule unless it is already there. `-C` exits non-zero both when the
# rule is absent and when the table cannot be used, and the add that follows
# tells those two apart.
ensure_rule() {
    tool="$1"; table="$2"; shift 2
    "$tool" -t "$table" -C "$@" 2>/dev/null || "$tool" -t "$table" -A "$@"
}

# IPv6 is only there if the kernel has it. Without it nothing on the tailnet
# can reach this over v6 either, so there is nothing to route or to leak.
HAVE_V6=0
[ -d /proc/sys/net/ipv6 ] && HAVE_V6=1

# ---------------------------------------------------------------- tunnel ---
ip link del wg0 2>/dev/null || true
ip link add wg0 type wireguard || die "could not create the WireGuard interface (is /dev/net/tun passed in, with NET_ADMIN?)"
umask 077
printf '%s\n' "$WG_PRIVATE_KEY" > /run/wg.key
if ! wg set wg0 private-key /run/wg.key \
    peer "$WG_PEER_PUBLIC_KEY" endpoint "$WG_ENDPOINT" allowed-ips 0.0.0.0/0,::/0 persistent-keepalive 25; then
    rm -f /run/wg.key
    die "WireGuard did not accept the key or the server; set the exit node up again from the panel"
fi
rm -f /run/wg.key
ip address add "$WG_ADDRESS" dev wg0 || die "could not give the tunnel its address $WG_ADDRESS"

# IPv6 through the tunnel needs three things: an address on wg0, a route into
# it, and a masquerade on the way out. Any one missing and v6 is not carried.
V6_OK=0
if [ "$HAVE_V6" = 1 ] && [ -n "${WG_ADDRESS6:-}" ]; then
    if ip -6 address add "$WG_ADDRESS6" dev wg0; then
        V6_OK=1
    else
        warn "could not give the tunnel its IPv6 address $WG_ADDRESS6"
    fi
fi
# Room for WireGuard's own headers inside Mullvad's 1420, with some to spare.
ip link set wg0 mtu 1380 up || die "could not bring the tunnel up"
log "tunnel to ${WG_ENDPOINT} is up"

# --------------------------------------------------------------- routing ---
# The main table keeps the container's normal default route, so tailscaled's
# own traffic still goes out through the home connection. Only packets that
# arrive from the tailnet are looked up in a table of their own, whose only
# way out is wg0. The unreachable route behind it is the kill switch: if wg0
# ever goes, that traffic stops rather than falling back to the home address.
#
# `replace` is idempotent by itself. Rules are not -- `ip rule add` happily
# adds a second copy -- so every rule at our priority is cleared first.
ip route replace default dev wg0 table "$TABLE" || die "could not route the tailnet's traffic into the tunnel"
ip route replace unreachable default metric 4000 table "$TABLE" || die "could not add the IPv4 kill switch route"
while ip rule del priority "$PRIORITY" 2>/dev/null; do :; done
ip rule add iif tailscale0 lookup "$TABLE" priority "$PRIORITY" || die "could not add the IPv4 routing rule for tailnet traffic"

if [ "$HAVE_V6" = 1 ]; then
    # The v6 kill switch goes in whether or not v6 is carried: with no route
    # into wg0, the unreachable route is the only answer, and it answers at
    # once. A phone then falls back to IPv4 in milliseconds instead of waiting
    # out a timeout, and nothing ever goes out by the home connection's v6.
    ip -6 route replace unreachable default metric 4000 table "$TABLE" || die "could not add the IPv6 kill switch route"
    while ip -6 rule del priority "$PRIORITY" 2>/dev/null; do :; done
    ip -6 rule add iif tailscale0 lookup "$TABLE" priority "$PRIORITY" || die "could not add the IPv6 routing rule for tailnet traffic"
fi

ip route replace "$MULLVAD_DNS/32" dev wg0 || die "could not route DNS to Mullvad's resolver"
echo "nameserver $MULLVAD_DNS" > /etc/resolv.conf || die "could not point DNS at Mullvad's resolver"

# What leaves through Mullvad leaves as this tunnel's address. Required: a
# packet that left with its tailnet source address would be dropped by
# Mullvad, so without this the exit node carries nothing.
ensure_rule "$IPT" nat POSTROUTING -o wg0 -j MASQUERADE || die "could not set up the IPv4 masquerade on the tunnel ($IPT)"
# TCP is told the smaller packet size up front rather than finding it out by
# losing packets. Optional: without it, some sites stall now and then.
ensure_rule "$IPT" mangle FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu \
    || warn "could not clamp the IPv4 TCP packet size; a few sites may stall"

if [ "$V6_OK" = 1 ]; then
    if ensure_rule "$IP6T" nat POSTROUTING -o wg0 -j MASQUERADE; then
        ensure_rule "$IP6T" mangle FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu \
            || warn "could not clamp the IPv6 TCP packet size; a few sites may stall"
        ip -6 route replace default dev wg0 table "$TABLE" || { warn "could not route IPv6 into the tunnel"; V6_OK=0; }
    else
        V6_OK=0
        warn "could not set up the IPv6 masquerade ($IP6T)"
    fi
fi
if [ "$V6_OK" = 1 ]; then
    log "IPv6 is carried through the tunnel"
else
    # --advertise-exit-node always offers ::/0 alongside 0.0.0.0/0; there is
    # no IPv4-only form of it. So devices will still send v6 here, and the
    # unreachable route above turns it away at once.
    ip -6 route del default dev wg0 table "$TABLE" 2>/dev/null || true
    warn "IPv6 is NOT carried: tailnet devices using this exit node get IPv4 only, and their IPv6 is refused here rather than leaked"
fi

# ------------------------------------------------------------- tailscale ---
mkdir -p /var/lib/tailscale /var/run/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --tun=tailscale0 &
TSD=$!
UP=""
# `docker stop` sends TERM and waits ten seconds before it kills. The trap only
# runs while the shell is waiting on something it can be interrupted from,
# which is why nothing below runs in the foreground for long.
trap 'kill -TERM "$TSD" 2>/dev/null; [ -n "$UP" ] && kill "$UP" 2>/dev/null; wait "$TSD" 2>/dev/null; exit 0' TERM INT

for _ in $(seq 1 50); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 0.2
done

# Signs in the first time -- the panel shows the link this prints -- and on
# every later start just reapplies the settings. --accept-dns=false keeps
# Mullvad's resolver above, rather than MagicDNS, in charge of this machine.
#
# In the background, because the first time it blocks until somebody signs in,
# which may be days. In the foreground that also held off the TERM trap, so a
# `docker stop` always sat out its full timeout and then killed tailscaled
# without letting it close down.
(
    tailscale up --hostname="$TS_HOSTNAME" --advertise-exit-node --accept-dns=false --accept-routes=false \
        || log "tailscale up did not finish; the panel shows why"
) &
UP=$!

wait "$TSD"
