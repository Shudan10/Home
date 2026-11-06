# A Tailscale exit node whose internet side is a Mullvad WireGuard tunnel.
#
# Devices on the tailnet pick this as their exit node; what they send to the
# internet arrives here on tailscale0 and leaves through wg0, to Mullvad.
# Everything else in this container -- Tailscale's own connections to the
# phone and the laptop -- goes out through the home connection as usual, so
# those stay direct rather than being squeezed through Mullvad as well.
#
# Kept under manager/ rather than a folder of its own so it travels with the
# panel's code: Update copies a fixed list of folders, and a new one would not
# arrive until the panel doing the copying already knew its name.
#
# On Tailscale's own image, pinned to a minor version, so the tailscale and
# tailscaled here always match and an update is a decision.
FROM tailscale/tailscale:v1.104

# iptables and ip6tables carry both backends, iptables-nft and the legacy one.
# The entrypoint uses nft (and tells tailscaled to), keeping legacy only for a
# kernel without nf_tables; plain `iptables` here is the legacy one.
RUN apk add --no-cache wireguard-tools-wg iproute2 iptables ip6tables curl

COPY entrypoint.sh /usr/local/bin/mullvad-exit

ENTRYPOINT ["/bin/sh", "/usr/local/bin/mullvad-exit"]
