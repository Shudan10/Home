#!/usr/bin/env bash
#
# Removes everything install.sh created.
#
#   curl -fsSL https://raw.githubusercontent.com/Shudan10/Home/main/uninstall.sh | bash
#
# This removes what the installer added: the containers, images, the app data
# volumes, the networks and the install directory, and turns off the HTTPS
# addresses the panel set up with `tailscale serve`.
#
# Docker itself is deliberately never touched. It is shared machine-wide, and
# uninstalling it would take every unrelated container, image and volume with
# it. Remove Docker yourself if you want it gone.
#
# Pass --keep-data to preserve everything stored in your apps: the data
# volumes, and .env and conf/ in the install directory, which hold the
# passwords that data is locked with. A Nextcloud database kept without its
# password is a database nobody can open.
#
# What this cannot remove is what lives in other people's systems: the
# Cloudflare tunnel and its DNS records, and the Mullvad device. The panel's
# Remove everything does those, signed in as you; this only says where they are.

set -euo pipefail

# The installer copies this script into the install directory, so a copy that
# is sitting in one should remove that one -- not whatever ~/.quickstart-home
# happens to be. Someone who installed with --dir otherwise runs the copy inside
# their install and watches it leave the directory behind, having removed the
# containers by name from underneath it.
#
# Only trusted when the directory really looks like an install, so a checkout of
# this repository (which has no .env) still falls through to the default.
self_dir() {
    [ -n "${BASH_SOURCE[0]:-}" ] || return 1
    local dir
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || return 1
    [ -f "$dir/docker-compose.yml" ] && [ -f "$dir/.env" ] || return 1
    printf '%s\n' "$dir"
}

STACK_DIR="${QSH_STACK_DIR:-$(self_dir || echo "$HOME/.quickstart-home")}"
ASSUME_YES="${QSH_YES:-0}"
KEEP_DATA=0
KEEP_BASE_IMAGES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) STACK_DIR="$2"; shift 2 ;;
        --keep-data) KEEP_DATA=1; shift ;;
        --keep-base-images) KEEP_BASE_IMAGES=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h)
            cat <<'USAGE'
Usage: uninstall.sh [options]

  --dir <path>          Install directory (default: ~/.quickstart-home)
  --keep-data           Keep the app data volumes (Nextcloud files, Jellyfin's library, Family Hub's calendar, chores and meals,
                        the Minecraft world), plus .env and conf/ with the passwords they need
  --keep-base-images    Keep node / alpine / cloudflared and the other pulled base images
  --yes, -y             Do not ask for confirmation
USAGE
            exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

if [ -t 1 ]; then
    B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; R=$'\033[0m'
else
    B=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; R=""
fi
say()  { printf '%s==>%s %s\n' "$CYN" "$R" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$R" "$*" >&2; }

# Everything that was there and could not be removed, for the last word.
LEFT=()
left() { LEFT+=("$*"); warn "could not remove $*"; }

# `[ -e /dev/tty ]` is true in containers, cron and CI too, where opening it
# fails; only an actual open says whether there is anyone to ask.
have_tty() { ( : </dev/tty ) 2>/dev/null; }

confirm() {
    [ "$ASSUME_YES" = "1" ] && return 0
    if ! have_tty; then
        warn "No terminal to ask on. Re-run with --yes to remove without asking."
        return 1
    fi
    printf '%s [y/N] ' "$1" > /dev/tty
    local reply; read -r reply < /dev/tty || reply=""
    case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

DOCKER_SUDO=""
if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || DOCKER_SUDO="$SUDO"
fi
d() { $DOCKER_SUDO docker "$@"; }

# One value from the install's .env, or the default the compose file falls
# back to. Read up front, while the file is still there.
env_get() {
    local v=""
    [ -f "$STACK_DIR/.env" ] && v="$(sed -n "s/^$1=//p" "$STACK_DIR/.env" 2>/dev/null | tail -n 1)"
    # Quoted the way install.sh and the panel quote anything beyond plain
    # characters; the values read here never need more than the quotes off.
    case "$v" in
        \'*\') v="${v#\'}"; v="${v%\'}" ;;
        \"*\") v="${v#\"}"; v="${v%\"}" ;;
    esac
    printf '%s\n' "${v:-$2}"
}

# An image tag from .env, refused unless it is plainly a tag, so a stray
# character cannot turn `docker rmi` into something else.
tag_from_env() {
    local v; v="$(env_get "$1" "$2")"
    case "$v" in *[!A-Za-z0-9._-]*) v="$2" ;; esac
    printf '%s\n' "$v"
}

# A string field from one of the panel's JSON files; enough for the few flat
# fields read here, so this needs neither jq nor the panel.
json_field() {
    [ -f "$2" ] || return 0
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$2" 2>/dev/null | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'
}

printf '\n%sRemove Quick Start Home%s\n' "$B" "$R"
printf '%s  directory %s%s\n' "$DIM" "$STACK_DIR" "$R"
if [ "$KEEP_DATA" = "1" ]; then
    printf '%s  app data will be KEPT: the volumes, and .env and conf/ with their passwords%s\n\n' "$DIM" "$R"
else
    printf '%s  app data will be DELETED, including every file in Nextcloud%s\n\n' "$YLW" "$R"
fi

confirm "Proceed?" || { echo "Nothing was removed."; exit 0; }

# Everything below that depends on the install's own settings reads them now,
# before any of it is removed.
JELLYFIN_TAG="$(tag_from_env JELLYFIN_VERSION latest)"
MINECRAFT_TAG="$(tag_from_env MINECRAFT_IMAGE_VERSION latest)"
ADGUARD_TAG="$(tag_from_env ADGUARD_VERSION latest)"
TUNNEL_TAG="$(tag_from_env TUNNEL_VERSION 2026.10.7)"
NEXTCLOUD_TAG="$(tag_from_env NEXTCLOUD_TAG stable)"
GUI_PORT_IN_USE="$(env_get GUI_PORT 8420)"
CF_CONNECTED=0
[ -n "$(env_get CLOUDFLARE_API_TOKEN '')$(env_get CLOUDFLARE_TUNNEL_TOKEN '')" ] && CF_CONNECTED=1
CF_INSTALL_ID="$(json_field installId "$STACK_DIR/conf/manager.json")"
CF_TUNNEL_ID="$(json_field tunnelId "$STACK_DIR/conf/manager.json")"
MULLVAD_CONNECTED=0
[ -n "$(env_get MULLVAD_ACCOUNT '')$(env_get MULLVAD_WG_PRIVATE_KEY '')" ] && MULLVAD_CONNECTED=1
MULLVAD_DEVICE="$(json_field deviceName "$STACK_DIR/conf/manager.json")"
MULLVAD_TS_NAME="$(env_get MULLVAD_TS_HOSTNAME home-mullvad)"

# -------------------------------------------------------- tailscale serve ----

# The panel's HTTPS addresses live in the host's Tailscale, not in Docker, and
# survive everything below: left alone, https://<this machine>.ts.net would go
# on answering with a proxy error to a port nothing listens on any more.
#
# Only an address the panel would have made is turned off -- one of its four
# ports, proxying nothing but http://127.0.0.1:<a port this stack uses>.
# Anything else on those ports was set up by hand and is left as it is, which
# is the same line the panel itself draws.
serve_off() {
    command -v tailscale >/dev/null 2>&1 || return 0
    local json ts=(tailscale) ports p target port mine
    json="$(tailscale serve status --json 2>/dev/null)" || json=""
    if [ -z "$json" ] && [ -n "$SUDO" ]; then
        json="$($SUDO tailscale serve status --json 2>/dev/null)" || json=""
        [ -n "$json" ] && ts=("$SUDO" tailscale)
    fi
    [ -n "$json" ] || return 0
    json="$(printf '%s' "$json" | tr -d ' \t\r\n')"

    # The ports the panel would have pointed them at: its own, and each app's
    # web port as recorded in conf/apps.json.
    ports=" $GUI_PORT_IN_USE "
    if [ -f "$STACK_DIR/conf/apps.json" ]; then
        while read -r p; do
            [ -n "$p" ] && ports="$ports$p "
        done < <(grep -o '"hostPort"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$STACK_DIR/conf/apps.json" | grep -o '[0-9][0-9]*$' || true)
    fi

    for p in 443 8443 8444 8445; do
        # One handler, at /, proxying to loopback: exactly what `tailscale
        # serve --https=<p> http://127.0.0.1:<port>` writes, and nothing more.
        target="$(printf '%s' "$json" \
            | grep -o "\"[^\"]*:$p\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127\\.0\\.0\\.1:[0-9]*\"}}}" \
            | head -n 1 | grep -o '127\.0\.0\.1:[0-9]*' || true)"
        [ -n "$target" ] || continue
        port="${target##*:}"
        mine=0
        case "$ports" in *" $port "*) mine=1 ;; esac
        if [ "$mine" = 0 ]; then
            say "Leaving Tailscale HTTPS on port $p alone: it points at $target, which is not this stack's"
            continue
        fi
        if "${ts[@]}" serve --https="$p" off >/dev/null 2>&1 \
            || { [ -n "$SUDO" ] && [ "${ts[0]}" != "$SUDO" ] && $SUDO tailscale serve --https="$p" off >/dev/null 2>&1; }; then
            ok "turned off Tailscale HTTPS on port $p (was $target)"
        else
            left "the Tailscale HTTPS address on port $p (run: sudo tailscale serve --https=$p off)"
        fi
    done
}

say "Turning off the panel's Tailscale HTTPS addresses, if any"
serve_off

# ------------------------------------------------------------- containers ----

if command -v docker >/dev/null 2>&1 && d info >/dev/null 2>&1; then
    if [ -f "$STACK_DIR/docker-compose.yml" ]; then
        say "Stopping the stack"
        compose_files=(-f "$STACK_DIR/docker-compose.yml")
        [ -f "$STACK_DIR/conf/apps-ports.yml" ] && compose_files+=(-f "$STACK_DIR/conf/apps-ports.yml")
        # Every profile is named, or the services behind them are invisible to
        # compose and their containers and volumes are left behind as orphans.
        # Jellyfin and Meal Plan were missing here, so an uninstall left both
        # running, with their data. Minecraft is in the list for the same reason.
        down=(--profile nextcloud --profile jellyfin --profile mealplan --profile minecraft --profile adguard --profile tunnel --profile mullvad --profile kachat down --remove-orphans --rmi local)
        [ "$KEEP_DATA" = "1" ] || down+=(--volumes)
        d compose "${compose_files[@]}" --project-directory "$STACK_DIR" "${down[@]}" 2>/dev/null \
            || warn "compose down reported an error; removing objects individually."
    fi

    say "Removing leftover containers"
    # Every container the stack runs, by name, for when compose could not
    # (no compose file, or one from a different version). quickstart-home-proxy
    # is the nginx container from before the tunnel, for installs that never
    # updated far enough to have it retired. The last three are the panel's
    # own short-lived helpers, which remove themselves and are only here for
    # one that died part-way and still holds its name.
    #
    # -v takes the container's anonymous volumes with it -- never a named
    # one, so this is safe with --keep-data. Redis used to get a fresh one on
    # every recreate, and nothing else would ever remove them.
    for name in quickstart-home-manager quickstart-home-tunnel quickstart-home-mullvad \
               quickstart-home-kachat-nextcloud quickstart-home-kachat-db quickstart-home-kachat-redis \
               quickstart-home-nextcloud quickstart-home-nextcloud-db \
               quickstart-home-nextcloud-redis quickstart-home-nextcloud-imaginary \
               quickstart-home-jellyfin quickstart-home-mealplan quickstart-home-minecraft quickstart-home-adguard \
               quickstart-home-proxy \
               quickstart-home-panel-update quickstart-home-panel-restart quickstart-home-teardown; do
        d container inspect "$name" >/dev/null 2>&1 || continue
        if d rm -fv "$name" >/dev/null 2>&1; then ok "removed container $name"; else left "container $name"; fi
    done

    say "Removing images"
    # Images this stack built.
    while read -r image; do
        [ -n "$image" ] || continue
        if d rmi -f "$image" >/dev/null 2>&1; then ok "removed image $image"; else left "image $image"; fi
    done < <(d images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^quickstart-home/' || true)

    if [ "$KEEP_BASE_IMAGES" = "0" ]; then
        # Base images the stack pulled, at the tags this install uses. Several
        # come from .env, so they are read from it rather than assumed: `docker
        # rmi jellyfin/jellyfin` means :latest and never matches a pinned one.
        # These may be shared with other projects, so a refusal here is
        # expected and harmless, and not counted as something left behind.
        #
        # nginx, certbot and the unpinned docker:cli are from older versions
        # (the proxy before the tunnel, and the teardown helper before it was
        # pinned), so an upgraded install is cleaned up too.
        # Keep in step with BASE_IMAGES in manager/lib/selfservice.js.
        for image in "cloudflare/cloudflared:$TUNNEL_TAG" tailscale/tailscale:v1.104 \
                     node:22-alpine alpine:3.21 docker:29.9.3-cli \
                     mariadb:10.11 redis:7-alpine nextcloud/aio-imaginary:latest "nextcloud:$NEXTCLOUD_TAG" \
                     "jellyfin/jellyfin:$JELLYFIN_TAG" "itzg/minecraft-server:$MINECRAFT_TAG" "adguard/adguardhome:$ADGUARD_TAG" \
                     nginx:1.27-alpine certbot/certbot:latest docker:cli; do
            d image inspect "$image" >/dev/null 2>&1 || continue
            if d rmi "$image" >/dev/null 2>&1; then
                ok "removed image $image"
            else
                printf '%s  kept%s %s, something else uses it\n' "$DIM" "$R" "$image"
            fi
        done
    fi

    if [ "$KEEP_DATA" = "0" ]; then
        say "Removing volumes"
        # Every named volume in docker-compose.yml, plus whatever compose
        # labelled as this project's -- so one added later is not missed here
        # the way Jellyfin's, Meal Plan's and Minecraft's once were.
        # Keep in step with VOLUMES in manager/lib/selfservice.js.
        volumes=" quickstart-home-nextcloud-db-data quickstart-home-nextcloud-data \
quickstart-home-jellyfin-config quickstart-home-jellyfin-cache quickstart-home-mealplan-data \
quickstart-home-minecraft-data quickstart-home-adguard-data quickstart-home-mullvad-tailscale \
quickstart-home-kachat-data quickstart-home-kachat-db-data "
        while read -r v; do
            [ -n "$v" ] || continue
            case "$volumes" in *" $v "*) ;; *) volumes="$volumes$v " ;; esac
        done < <(d volume ls -q --filter label=com.docker.compose.project=quickstart-home 2>/dev/null || true)
        for volume in $volumes; do
            d volume inspect "$volume" >/dev/null 2>&1 || continue
            if d volume rm -f "$volume" >/dev/null 2>&1; then ok "removed volume $volume"; else left "volume $volume"; fi
        done
    fi

    say "Removing the networks"
    for net in quickstart-home-net quickstart-home-vpn; do
        d network inspect "$net" >/dev/null 2>&1 || continue
        if d network rm "$net" >/dev/null 2>&1; then ok "removed network $net"; else left "network $net (a container outside this stack is still on it)"; fi
    done

    # Our images are gone by this point, so their build cache is now dangling
    # and this reclaims it. Plain
    # `prune` without -a leaves cache that other projects' images still
    # reference, which is the point -- nothing unrelated gets touched.
    d builder prune -f >/dev/null 2>&1 || true
elif command -v docker >/dev/null 2>&1; then
    warn "Docker is installed but not answering, so nothing in it could be removed."
    LEFT+=("every container, image, volume and network of this stack (Docker was not answering; start it and run this again)")
else
    warn "Docker is not installed, so there are no containers, images or volumes to remove."
fi

# -------------------------------------------------------------- directory ----

# rm -rf, then the same with sudo if that is what it takes. An Update from the
# panel before this version left manager/, nextcloud/ and the rest owned by
# root, and a plain rm -rf could not get into them -- which under set -e ended
# the uninstall right here, after the volumes were already gone, with the
# directory half-deleted and no word about what was left.
remove_path() {
    rm -rf "$1" 2>/dev/null || true
    if [ -e "$1" ] && [ -n "$SUDO" ]; then
        warn "Some of $1 belongs to root (an earlier Update from the panel wrote it), so removing it with sudo"
        $SUDO rm -rf "$1" 2>/dev/null || true
    fi
    [ -e "$1" ] && left "$1 (run: sudo rm -rf \"$1\")"
    return 0
}

# Piece by piece, and the two files that mark this as an install last. If
# anything cannot be removed, those stay -- so that running this again, once
# sudo works, still recognises the directory and finishes the job, rather than
# refusing a half-emptied folder as "not an install".
remove_install_dir() {
    local before="${#LEFT[@]}" entry
    shopt -s nullglob dotglob
    for entry in "$STACK_DIR"/*; do
        case "${entry##*/}" in
            .env|docker-compose.yml) continue ;;
            conf) [ "$KEEP_DATA" = "1" ] && continue ;;
        esac
        remove_path "$entry"
    done
    shopt -u nullglob dotglob
    if [ "${#LEFT[@]}" -gt "$before" ]; then
        warn "Left .env and docker-compose.yml in $STACK_DIR, so running this again still finds the install."
        return 0
    fi
    if [ "$KEEP_DATA" = "1" ]; then
        remove_path "$STACK_DIR/docker-compose.yml"
        ok "kept $STACK_DIR/.env and $STACK_DIR/conf"
    else
        remove_path "${STACK_DIR:?}"
        [ -e "$STACK_DIR" ] || ok "removed $STACK_DIR"
    fi
}

if [ -d "$STACK_DIR" ]; then
    # Refuse to delete anything that is not recognisably our install directory.
    if [ -f "$STACK_DIR/docker-compose.yml" ] || [ -f "$STACK_DIR/.env" ]; then
        if [ "$KEEP_DATA" = "1" ]; then
            say "Removing the install directory's code, keeping .env and conf/"
        else
            say "Removing $STACK_DIR"
        fi
        remove_install_dir
    else
        warn "$STACK_DIR does not look like a Quick Start Home install, so leaving it alone."
    fi
fi

# -------------------------------------------------------- outside this box ----

# Held by Cloudflare and Mullvad, not by anything on this machine. The panel's
# Global settings -> Remove everything signs in to both and removes them; this
# script holds no session with either, so it says where they are instead.
if [ "$CF_CONNECTED" = "1" ] || [ "$MULLVAD_CONNECTED" = "1" ]; then
    printf '\n%sStill set up outside this machine%s\n' "$B" "$R"
    printf '%sRemove everything in the panel takes these away too; uninstall.sh cannot.%s\n' "$DIM" "$R"
fi
if [ "$CF_CONNECTED" = "1" ]; then
    printf '  Cloudflare  the tunnel%s and a DNS record for each name you published\n' \
        "${CF_INSTALL_ID:+ \"quickstart-home-$CF_INSTALL_ID\"}"
    printf '              %s(CNAMEs to %s.cfargotunnel.com). Remove them at dash.cloudflare.com:%s\n' \
        "$DIM" "${CF_TUNNEL_ID:-<tunnel id>}" "$R"
    printf '              %sZero Trust > Networks > Tunnels, and each domain'"'"'s DNS > Records.%s\n' "$DIM" "$R"
fi
if [ "$MULLVAD_CONNECTED" = "1" ]; then
    printf '  Mullvad     the device%s, one of your account'"'"'s five.\n' "${MULLVAD_DEVICE:+ \"$MULLVAD_DEVICE\"}"
    printf '              %sRemove it at mullvad.net > Account > Devices.%s\n' "$DIM" "$R"
    printf '  Tailscale   the exit node "%s" in your tailnet.\n' "$MULLVAD_TS_NAME"
    printf '              %sRemove it at login.tailscale.com/admin/machines.%s\n' "$DIM" "$R"
fi

# ------------------------------------------------------------------ done ----

if [ "${#LEFT[@]}" -eq 0 ]; then
    if [ "$KEEP_DATA" = "1" ]; then
        printf '\n%sDone.%s Every container, image and network this stack created is gone.\n' "$GRN$B" "$R"
        printf 'Your app data volumes are kept, and so are %s/.env and conf/, which hold the\n' "$STACK_DIR"
        printf 'passwords that data needs. Installing again with --dir "%s" picks them back up.\n' "$STACK_DIR"
    else
        printf '\n%sDone.%s Every container, image, volume and file this stack created is gone.\n' "$GRN$B" "$R"
    fi
else
    printf '\n%sFinished, but some of it is still here:%s\n' "$YLW$B" "$R"
    for item in "${LEFT[@]}"; do printf '  - %s\n' "$item"; done
    printf '%sRunning this again removes whatever it can reach.%s\n' "$DIM" "$R"
fi
printf '%sDocker itself was left installed.%s\n\n' "$DIM" "$R"
[ "${#LEFT[@]}" -eq 0 ]
