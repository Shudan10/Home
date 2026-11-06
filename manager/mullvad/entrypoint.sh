#!/bin/sh
# Brings up the Mullvad tunnel, the routing that sends the tailnet's internet
# traffic into it and nowhere else, and then Tailscale as an exit node.
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

log() { echo "mullvad-exit: $*"; }

# ---------------------------------------------------------------- tunnel ---
ip link del wg0 2>/dev/null || true
ip link add wg0 type wireguard
umask 077
printf '%s\n' "$WG_PRIVATE_KEY" > /run/wg.key
wg set wg0 private-key /run/wg.key \
    peer "$WG_PEER_PUBLIC_KEY" endpoint "$WG_ENDPOINT" allowed-ips 0.0.0.0/0,::/0 persistent-keepalive 25
rm -f /run/wg.key
ip address add "$WG_ADDRESS" dev wg0
[ -n "${WG_ADDRESS6:-}" ] && ip -6 address add "$WG_ADDRESS6" dev wg0 2>/dev/null || true
# Room for WireGuard's own headers inside Mullvad's 1420, with some to spare.
ip link set wg0 mtu 1380 up
log "tunnel to ${WG_ENDPOINT} is up"

# --------------------------------------------------------------- routing ---
# The main table keeps the container's normal default route, so tailscaled's
# own traffic still goes out through the home connection. Only packets that
# arrive from the tailnet are looked up in a table of their own, whose only
# way out is wg0. The unreachable route behind it is the kill switch: if wg0
# ever goes, that traffic stops rather than falling back to the home address.
ip route replace default dev wg0 table "$TABLE"
ip route replace unreachable default metric 4000 table "$TABLE"
ip rule del priority 100 2>/dev/null || true
ip rule add iif tailscale0 lookup "$TABLE" priority 100
if [ -n "${WG_ADDRESS6:-}" ]; then
    ip -6 route replace default dev wg0 table "$TABLE" 2>/dev/null || true
fi
ip -6 route replace unreachable default metric 4000 table "$TABLE" 2>/dev/null || true
ip -6 rule del priority 100 2>/dev/null || true
ip -6 rule add iif tailscale0 lookup "$TABLE" priority 100 2>/dev/null || true

ip route replace "$MULLVAD_DNS/32" dev wg0
echo "nameserver $MULLVAD_DNS" > /etc/resolv.conf

# What leaves through Mullvad leaves as this tunnel's address, and TCP is told
# the smaller packet size up front rather than finding it out by losing packets.
iptables -t nat -C POSTROUTING -o wg0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE
iptables -t mangle -C FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null \
    || iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
ip6tables -t nat -C POSTROUTING -o wg0 -j MASQUERADE 2>/dev/null || ip6tables -t nat -A POSTROUTING -o wg0 -j MASQUERADE 2>/dev/null || true

# ------------------------------------------------------------- tailscale ---
mkdir -p /var/lib/tailscale /var/run/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --tun=tailscale0 &
TSD=$!
trap 'kill -TERM "$TSD" 2>/dev/null; wait "$TSD"; exit 0' TERM INT

for _ in $(seq 1 50); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 0.2
done

# Signs in the first time -- the panel shows the link this prints -- and on
# every later start just reapplies the settings. --accept-dns=false keeps
# Mullvad's resolver above, rather than MagicDNS, in charge of this machine.
tailscale up --hostname="$TS_HOSTNAME" --advertise-exit-node --accept-dns=false --accept-routes=false \
    || log "tailscale up did not finish; the panel shows why"

wait "$TSD"
