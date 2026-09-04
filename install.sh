#!/usr/bin/env bash
#
# One-command installer for a personal home server with a web control panel.
#
#   curl -fsSL https://raw.githubusercontent.com/Shudan10/Home/main/install.sh | bash
#
# Installs Docker if it is missing, fetches the stack, and starts the control
# panel. Nothing else is installed here: apps are installed from the panel, by
# somebody who has seen what they are and asked for them.
#
# Everything it creates lives in one directory and a handful of docker objects,
# all removable with uninstall.sh.

set -euo pipefail

# ------------------------------------------------------------------ config --

STACK_REPO="${QSH_STACK_REPO:-Shudan10/Home}"
STACK_REF="${QSH_STACK_REF:-main}"
STACK_DIR="${QSH_STACK_DIR:-$HOME/.quickstart-home}"
# Not 8080. That is the first port anyone reaches for when 80 belongs to
# something else, and only one thing on a machine can hold it -- a control panel
# sitting there is a panel in the way of the job it exists to do. Nothing
# expects one on 8420, which is the point. --gui-port changes it, and so does
# the panel itself once it is running.
GUI_PORT="${QSH_GUI_PORT:-8420}"
HTTP_PORT="${QSH_HTTP_PORT:-80}"
HTTPS_PORT="${QSH_HTTPS_PORT:-443}"
# Every interface, because a home server is a thing you open from the sofa. That
# is also why the password below is not optional: this panel holds the Docker
# socket, which is root on the host.
MANAGER_BIND="${QSH_MANAGER_BIND:-0.0.0.0}"
ADMIN_PASSWORD="${QSH_ADMIN_PASSWORD:-}"
ASSUME_YES="${QSH_YES:-0}"
SKIP_DOCKER_INSTALL="${QSH_SKIP_DOCKER_INSTALL:-0}"

# Set when this run generated the password, so the summary knows to print it.
GENERATED_PASSWORD=0

MANAGER_IMAGE="quickstart-home/manager:1"

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) STACK_DIR="$2"; shift 2 ;;
        --gui-port) GUI_PORT="$2"; shift 2 ;;
        --http-port) HTTP_PORT="$2"; shift 2 ;;
        --https-port) HTTPS_PORT="$2"; shift 2 ;;
        --bind) MANAGER_BIND="$2"; shift 2 ;;
        --password) ADMIN_PASSWORD="$2"; shift 2 ;;
        --stack-repo) STACK_REPO="$2"; shift 2 ;;
        --stack-ref) STACK_REF="$2"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift ;;
        --help|-h)
            cat <<'USAGE'
Usage: install.sh [options]

  --dir <path>          Where to install (default: ~/.quickstart-home)
  --gui-port <port>     Web control panel port (default: 8420)
  --http-port <port>    nginx http port (default: 80)
  --https-port <port>   nginx https port (default: 443)
  --bind <address>      Address the panel listens on (default: 0.0.0.0)
  --password <pass>     Password for the panel. One is generated and printed
                        if you do not supply one.
  --stack-repo <o/r>    Repo to fetch this stack from
  --stack-ref <ref>     Branch or tag of that repo
  --yes, -y             Do not ask for confirmation
  --skip-docker-install Fail instead of installing Docker
USAGE
            exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

# ------------------------------------------------------------------ output --

if [ -t 1 ]; then
    B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; R=$'\033[0m'
else
    B=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; R=""
fi

say()  { printf '%s==>%s %s\n' "$CYN" "$R" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$R" "$*" >&2; }
die()  { printf '%sfail%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

confirm() {
    [ "$ASSUME_YES" = "1" ] && return 0
    # When piped from curl, stdin is the script itself -- read from the tty.
    [ -e /dev/tty ] || return 0
    printf '%s [Y/n] ' "$1" > /dev/tty
    local reply; read -r reply < /dev/tty || reply=""
    case "$reply" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ------------------------------------------------------------- environment --

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
    Linux)  PLATFORM=linux ;;
    Darwin) PLATFORM=macos ;;
    *) die "Unsupported system: $OS. This installer supports Linux and macOS." ;;
esac
case "$ARCH" in
    x86_64|amd64) DOCKER_ARCH=amd64 ;;
    arm64|aarch64) DOCKER_ARCH=arm64 ;;
    *) die "Unsupported CPU architecture: $ARCH" ;;
esac

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."; }
need curl
need tar

# ---------------------------------------------------------------- docker ----

# Docker may be installed but only reachable as root (fresh Linux install, user
# not yet in the docker group). Track that once and reuse it everywhere.
DOCKER_SUDO=""

# `docker info` is not guaranteed to come back. Docker Desktop accepts a
# connection long before it can answer one, so the call can block for minutes
# while the VM boots, which turns a bounded "180 tries" wait into an open one.
DOCKER_PROBE_TIMEOUT="${QSH_DOCKER_PROBE_TIMEOUT:-10}"

# Runs a command quietly and kills it after DOCKER_PROBE_TIMEOUT seconds.
# macOS ships no timeout(1), hence the hand-rolled one.
#
# The subshell earns its keep separately: when a child dies on a signal, bash
# announces it ("Killed: 9") on its own stderr rather than the child's, so
# redirecting the command alone does not hide it. macOS does SIGKILL a binary
# whose app bundle was replaced underneath it, which is precisely what a Docker
# Desktop upgrade does to the docker CLI moments before this probe runs.
run_probe() {
    (
        "$@" >/dev/null 2>&1 &
        probe_pid=$!
        probe_waited=0
        while kill -0 "$probe_pid" 2>/dev/null; do
            if [ "$probe_waited" -ge "$DOCKER_PROBE_TIMEOUT" ]; then
                kill -9 "$probe_pid" 2>/dev/null || true
                wait "$probe_pid" 2>/dev/null || true
                exit 1
            fi
            sleep 1
            probe_waited=$((probe_waited + 1))
        done
        wait "$probe_pid"
    ) 2>/dev/null
}

docker_ok() {
    # The sudo probe must not race the timeout: sudo may be sitting on a
    # password prompt, and a person needs longer than ten seconds to type.
    if [ -n "$DOCKER_SUDO" ]; then
        ( $DOCKER_SUDO docker info >/dev/null 2>&1 ) 2>/dev/null
        return
    fi
    run_probe docker info
}

resolve_docker_access() {
    command -v docker >/dev/null 2>&1 || return 1
    DOCKER_SUDO=""
    docker_ok && return 0
    # Only Linux has a root-owned daemon socket a plain user may not reach yet.
    # On macOS the daemon belongs to the user, so sudo cannot help. Asking
    # anyway would leave sudo waiting on a password prompt whose output the
    # probe throws away, once every two seconds, with nothing on screen.
    if [ "$PLATFORM" = linux ] && [ -n "$SUDO" ]; then
        DOCKER_SUDO="$SUDO"
        docker_ok && return 0
    fi
    DOCKER_SUDO=""
    return 1
}

# Works out which Docker apt repository this machine should actually use.
#
# get.docker.com cannot be trusted here: on Ubuntu derivatives such as Linux
# Mint it has been observed picking `debian trixie`, whose packages cannot
# satisfy their dependencies against an Ubuntu base -- apt then reports
# "held broken packages" and the install dies half-way. Derivatives carry the
# codename of the distribution they are actually built on, so use that.
#
# Echoes "<ubuntu|debian> <codename>", or nothing if this is not apt-based.
detect_apt_repo() {
    command -v apt-get >/dev/null 2>&1 || return 0
    [ -r /etc/os-release ] || return 0

    # shellcheck disable=SC1091
    . /etc/os-release

    case "${ID:-}" in
        ubuntu) printf 'ubuntu %s\n' "${VERSION_CODENAME:-}" ;;
        debian) printf 'debian %s\n' "${VERSION_CODENAME:-}" ;;
        *)
            # Mint, Pop!_OS, elementary, Zorin, KDE neon ... all set this.
            if [ -n "${UBUNTU_CODENAME:-}" ]; then
                printf 'ubuntu %s\n' "$UBUNTU_CODENAME"
            elif [ -n "${DEBIAN_CODENAME:-}" ]; then
                printf 'debian %s\n' "$DEBIAN_CODENAME"
            # Mint keeps its Ubuntu base here on older releases.
            elif [ -r /etc/upstream-release/lsb-release ]; then
                printf 'ubuntu %s\n' "$(sed -n 's/^DISTRIB_CODENAME=//p' /etc/upstream-release/lsb-release)"
            fi
            ;;
    esac
}

install_docker_apt() {
    local flavour="$1" codename="$2"
    local list=/etc/apt/sources.list.d/docker.list
    local line="deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$flavour $codename stable"

    say "Installing Docker Engine from the $flavour '$codename' repository"

    # A previous run (or get.docker.com) may have left a repository for the
    # wrong distribution behind, with partially installed packages from it.
    # Clear those out first, otherwise apt keeps reporting broken dependencies.
    if [ -f "$list" ] && [ "$(cat "$list")" != "$line" ]; then
        warn "Replacing an existing Docker apt source that points somewhere else."
        warn "  was: $(head -n1 "$list")"
        $SUDO apt-get purge -y -qq docker-ce docker-ce-cli containerd.io \
            docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras \
            docker-model-plugin >/dev/null 2>&1 || true
    fi

    $SUDO install -m 0755 -d /etc/apt/keyrings || die "Could not create /etc/apt/keyrings."
    $SUDO curl -fsSL "https://download.docker.com/linux/$flavour/gpg" -o /etc/apt/keyrings/docker.asc \
        || die "Could not download the Docker signing key."
    $SUDO chmod a+r /etc/apt/keyrings/docker.asc

    printf '%s\n' "$line" | $SUDO tee "$list" >/dev/null || die "Could not write $list."

    $SUDO apt-get -qq update >/dev/null || die "apt-get update failed after adding the Docker repository."
    # `env` rather than a VAR=value prefix: sudo rejects inline assignments
    # unless sudoers grants setenv.
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        || die "Installing the Docker packages failed. Run 'sudo apt-get install docker-ce' to see the full error."
}

install_docker_generic() {
    say "Installing Docker Engine (get.docker.com)"
    local script; script="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$script" || die "Could not download the Docker install script."
    $SUDO sh "$script" || die "The Docker install script failed. Install Docker manually, then re-run this."
    rm -f "$script"
}

install_docker_linux() {
    [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ] || die "Installing Docker needs root. Install sudo, or run this script as root."

    local repo flavour codename
    repo="$(detect_apt_repo)"
    flavour="${repo%% *}"
    codename="${repo##* }"

    if [ -n "$flavour" ] && [ -n "$codename" ] && [ "$flavour" != "$codename" ]; then
        install_docker_apt "$flavour" "$codename"
    else
        # Fedora, RHEL, Arch, SUSE and anything else apt-less.
        install_docker_generic
    fi

    if command -v systemctl >/dev/null 2>&1; then
        $SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "Could not enable the docker service automatically."
    fi
    if [ "$(id -u)" -ne 0 ]; then
        $SUDO usermod -aG docker "$USER" >/dev/null 2>&1 \
            && warn "Added $USER to the 'docker' group. Log out and back in to use docker without sudo."
    fi
}

install_docker_macos() {
    say "Installing Docker Desktop for macOS"
    if command -v brew >/dev/null 2>&1; then
        brew install --cask docker || die "brew install --cask docker failed."
    else
        local dmg url
        url="https://desktop.docker.com/mac/main/${DOCKER_ARCH}/Docker.dmg"
        dmg="$(mktemp -d)/Docker.dmg"
        say "Downloading $url"
        curl -fsSL "$url" -o "$dmg" || die "Could not download Docker Desktop."
        say "Mounting the disk image (this needs your password)"
        hdiutil attach "$dmg" -nobrowse -quiet || die "Could not mount Docker.dmg"
        $SUDO /Volumes/Docker/Docker.app/Contents/MacOS/install --accept-license \
            || { hdiutil detach /Volumes/Docker -quiet || true; die "Docker Desktop installation failed."; }
        hdiutil detach /Volumes/Docker -quiet || true
        rm -f "$dmg"
    fi

    say "Starting Docker Desktop"
    open -a Docker || warn "Could not start Docker Desktop automatically. Open it from Applications."
}

# Takes a budget in seconds, not a number of attempts: a probe can now cost
# anything from an instant to DOCKER_PROBE_TIMEOUT, so counting attempts says
# nothing about how long the caller is actually going to sit here.
wait_for_docker() {
    local limit="${1:-240}"
    say "Waiting for the Docker daemon (up to $(( (limit + 59) / 60 )) min)"
    if [ "$PLATFORM" = macos ]; then
        say "Keep an eye on the Docker Desktop window while this runs. A fresh"
        say "install, and every upgrade, asks you to accept the licence and to"
        say "grant privileged access. The daemon stays down until you do."
    fi
    local deadline=$((SECONDS + limit)) i=0
    while [ "$SECONDS" -lt "$deadline" ]; do
        if resolve_docker_access; then ok "Docker is running${DOCKER_SUDO:+ (via sudo)}"; return 0; fi
        i=$((i + 1))
        # Minutes of silence read as a hang, so say it is still alive.
        if [ $((i % 8)) -eq 0 ]; then say "Still waiting, $((deadline - SECONDS))s left"; fi
        sleep 2
    done
    return 1
}

ensure_docker() {
    if resolve_docker_access; then
        ok "Docker is already installed and running${DOCKER_SUDO:+ (via sudo)}"
    else
        if command -v docker >/dev/null 2>&1; then
            say "Docker is installed but not responding, so trying to start it"
            if [ "$PLATFORM" = macos ]; then
                open -a Docker >/dev/null 2>&1 || true
            elif command -v systemctl >/dev/null 2>&1; then
                $SUDO systemctl start docker >/dev/null 2>&1 || true
            fi
            wait_for_docker 120 || true
        fi

        if ! resolve_docker_access; then
            [ "$SKIP_DOCKER_INSTALL" = "1" ] && die "Docker is not available and --skip-docker-install was given."
            confirm "Docker is not installed. Install it now?" || die "Docker is required."
            if [ "$PLATFORM" = linux ]; then install_docker_linux; else install_docker_macos; fi
            wait_for_docker 360 || die "Docker did not start. Start Docker manually and re-run this script."
        fi
    fi

    $DOCKER_SUDO docker compose version >/dev/null 2>&1 \
        || die "'docker compose' (v2) is missing. Update Docker, or install the docker-compose-plugin package."
    ok "docker compose $($DOCKER_SUDO docker compose version --short 2>/dev/null || echo v2)"
}

# The generated port override is merged when it exists. It does not on a first
# install -- the panel writes it on its first boot -- and compose refuses a -f
# naming a file that is not there, so it is added conditionally.
dc() {
    local files=(-f "$STACK_DIR/docker-compose.yml")
    [ -f "$STACK_DIR/conf/apps-ports.yml" ] && files+=(-f "$STACK_DIR/conf/apps-ports.yml")
    $DOCKER_SUDO docker compose "${files[@]}" --project-directory "$STACK_DIR" "$@"
}

# ------------------------------------------------------------------ stack ----

fetch_stack() {
    local src_dir="" tmp
    # Running from a checkout? Use the files next to this script.
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/docker-compose.yml" ]; then
        src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        say "Using the stack files next to this script ($src_dir)"
    else
        tmp="$(mktemp -d)"
        say "Downloading the stack from $STACK_REPO@$STACK_REF"
        # GitHub wraps the archive in a <repo>-<ref>/ directory; --strip-components
        # peels it off so the stack lands directly in $tmp.
        curl -fsSL "https://codeload.github.com/$STACK_REPO/tar.gz/$STACK_REF" \
            | tar -xz -C "$tmp" --strip-components=1 \
            || die "Could not download the stack from $STACK_REPO@$STACK_REF."
        src_dir="$tmp"
        [ -f "$src_dir/docker-compose.yml" ] || die "The downloaded archive did not contain the stack."
    fi

    mkdir -p "$STACK_DIR"
    # Only these are replaced wholesale on a re-install. conf/ holds generated
    # state (manager.json, proxies.json, apps.json) and proxy/ holds issued
    # certificates and generated vhosts -- wiping either would cost real work.
    for item in docker-compose.yml manager nextcloud uninstall.sh dev.sh README.md; do
        [ -e "$src_dir/$item" ] || continue
        rm -rf "$STACK_DIR/${item:?}"
        cp -R "$src_dir/$item" "$STACK_DIR/$item"
    done
    chmod +x "$STACK_DIR/uninstall.sh" "$STACK_DIR/dev.sh" 2>/dev/null || true

    mkdir -p "$STACK_DIR/conf" "$STACK_DIR/proxy/conf.d" "$STACK_DIR/proxy/snippets" \
             "$STACK_DIR/proxy/letsencrypt" "$STACK_DIR/proxy/webroot"
    cp "$src_dir/proxy/nginx-base.conf" "$STACK_DIR/proxy/nginx-base.conf"

    # nginx needs a valid config the moment it starts; the manager regenerates
    # this file (and the per-host ones) as soon as it boots.
    [ -f "$STACK_DIR/proxy/conf.d/00-default.conf" ] \
        || cp "$STACK_DIR/proxy/nginx-base.conf" "$STACK_DIR/proxy/conf.d/00-default.conf"

    ok "Stack files are in $STACK_DIR"
}

random_hex() { head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

write_env() {
    local env_file="$STACK_DIR/.env"
    local existing_hash="" existing_secret=""
    if [ -f "$env_file" ]; then
        existing_hash="$(sed -n 's/^ADMIN_PASSWORD_HASH=//p' "$env_file" | head -n1)"
        existing_secret="$(sed -n 's/^SESSION_SECRET=//p' "$env_file" | head -n1)"
    fi
    [ -n "$existing_secret" ] || existing_secret="$(random_hex 32)"

    cat > "$env_file" <<ENVFILE
# Generated by install.sh. Delete this file only if you also remove the stack.
STACK_DIR=$STACK_DIR
STACK_REPO=$STACK_REPO
GUI_PORT=$GUI_PORT
MANAGER_BIND=$MANAGER_BIND
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
SESSION_SECRET=$existing_secret
ADMIN_PASSWORD_HASH=$existing_hash
ENVFILE
    chmod 600 "$env_file"
    ENV_HAD_PASSWORD=$([ -n "$existing_hash" ] && echo 1 || echo 0)
}

# The hash is computed by the manager image itself so the installer and the
# server agree on the algorithm. The password goes in over stdin so it never
# appears in a process listing.
write_password_hash() {
    # sed -i differs between GNU and BSD; rewrite the file instead.
    local tmp; tmp="$(mktemp)"
    grep -v '^ADMIN_PASSWORD_HASH=' "$STACK_DIR/.env" > "$tmp"
    printf 'ADMIN_PASSWORD_HASH=%s\n' "${1:-}" >> "$tmp"
    cat "$tmp" > "$STACK_DIR/.env"
    rm -f "$tmp"
    chmod 600 "$STACK_DIR/.env"
}

set_password() {
    local hash
    hash="$(printf '%s' "$ADMIN_PASSWORD" \
        | $DOCKER_SUDO docker run --rm -i "$MANAGER_IMAGE" node lib/hash-password.js)" \
        || die "Could not hash the admin password."
    [ -n "$hash" ] || die "Password hashing produced no output."
    write_password_hash "$hash"
}

is_loopback_bind() {
    case "$MANAGER_BIND" in
        127.*|::1|localhost) return 0 ;;
        *) return 1 ;;
    esac
}

# A password is not optional here.
#
# The panel binds every interface so it can be opened from a phone, and it holds
# the Docker socket, which is root on this machine. "No password" and "on the
# network" together is a full compromise waiting to be found, so this asks, and
# generates one rather than accept an empty answer.
#
# Asked before the build rather than after: a question at the end of a long
# install is a question nobody is there to answer.
random_password() {
    # base64 of 18 random bytes, with the awkward characters removed. Long
    # enough that the remaining alphabet does not matter.
    head -c 18 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-20
}

prompt_for_password() {
    [ -n "$ADMIN_PASSWORD" ] && return 0
    [ "$ENV_HAD_PASSWORD" = "1" ] && return 0

    # No terminal to ask at (piped from curl with no tty, or --yes): generate
    # one and print it in the summary. Better than leaving the panel open.
    if [ "$ASSUME_YES" = "1" ] || [ ! -e /dev/tty ]; then
        ADMIN_PASSWORD="$(random_password)"
        GENERATED_PASSWORD=1
        return 0
    fi

    printf '\n%sThis panel controls the Docker daemon on this machine.%s\n' "$B" "$R" > /dev/tty
    printf '%sIt listens on %s so you can open it from another device, so it needs\n' "$DIM" "$MANAGER_BIND" > /dev/tty
    printf 'a password. Leave it empty and one will be generated for you.%s\n' "$R" > /dev/tty

    local first second
    while :; do
        printf 'Panel password (empty to generate one): ' > /dev/tty
        # -s so it is not echoed; the newline it swallows is printed back.
        read -rs first < /dev/tty || first=""
        printf '\n' > /dev/tty

        if [ -z "$first" ]; then
            ADMIN_PASSWORD="$(random_password)"
            GENERATED_PASSWORD=1
            ok "Generated a password. It is printed at the end of this install."
            return 0
        fi
        if [ "${#first}" -lt 8 ]; then
            warn "Use at least 8 characters."
            continue
        fi

        printf 'Repeat it: ' > /dev/tty
        read -rs second < /dev/tty || second=""
        printf '\n' > /dev/tty
        [ "$first" = "$second" ] || { warn "Those did not match."; continue; }

        ADMIN_PASSWORD="$first"
        ok "Password set. You will be asked for it when you open the panel."
        return 0
    done
}

# ------------------------------------------------------------------- main ----

printf '\n%sQuick Start Home%s\n' "$B" "$R"
printf '%sinstall dir%s %s\n' "$DIM" "$R" "$STACK_DIR"
printf '%spanel%s       http://localhost:%s\n\n' "$DIM" "$R" "$GUI_PORT"

ensure_docker
fetch_stack
write_env

# Docker accepts a duplicate mapping and then fails to start the container, with
# an error naming neither of the two things fighting over the port.
if [ "$GUI_PORT" = "$HTTP_PORT" ] || [ "$GUI_PORT" = "$HTTPS_PORT" ]; then
    die "The panel and the reverse proxy cannot both use port $GUI_PORT. Pass --gui-port with something else."
fi
if [ "$HTTP_PORT" = "$HTTPS_PORT" ]; then
    die "http and https cannot share port $HTTP_PORT."
fi

prompt_for_password

# One image, and it is the panel's. Nothing else is built here.
#
# Everything the stack can run is installed from the panel, by somebody who has
# seen what it is and asked for it. What this script installs is the thing that
# installs the rest.
say "Building the control panel"
dc build manager || die "Could not build the manager image."

# After the build: hashing runs inside the manager image, so the image has to
# exist first.
if [ -n "$ADMIN_PASSWORD" ]; then
    set_password
    AUTH_STATE=set
else
    AUTH_STATE=kept
fi

say "Starting the control panel"
dc up -d manager || die "Could not start the control panel."

# ----------------------------------------------------------------- summary ---

printf '\n%s─────────────────────────────────────────────────%s\n' "$DIM" "$R"
printf '%sYour home server control panel is running.%s\n\n' "$GRN$B" "$R"
printf '  Control panel   %shttp://localhost:%s%s\n' "$B" "$GUI_PORT" "$R"
if ! is_loopback_bind; then
    printf '                  %sand on this machine'"'"'s address on your network, same port%s\n' "$DIM" "$R"
fi
printf '  Installed       %sthe panel only. Nextcloud and the proxy are installed from it%s\n' "$DIM" "$R"

if [ "$GENERATED_PASSWORD" = "1" ]; then
    printf '\n  %sPassword%s        %s%s%s\n' "$B" "$R" "$B$GRN" "$ADMIN_PASSWORD" "$R"
    printf '                  %swrite this down now: only a scrambled copy is stored, so it%s\n' "$YLW" "$R"
    printf '                  %scannot be read back. Change it under Global settings.%s\n' "$YLW" "$R"
elif [ "$AUTH_STATE" = "set" ]; then
    printf '  Sign in         %swith the password you supplied%s\n' "$DIM" "$R"
else
    printf '  Sign in         %swith the password from your previous install%s\n' "$DIM" "$R"
fi

cat <<SUMMARY

  First run        Open the panel and press Install on Nextcloud. It builds the
                   image and creates the containers, then leaves them stopped;
                   its switch in the sidebar starts it. Every service works the
                   same way, and each has an Uninstall tab that takes its data
                   with it.

  A web address    Proxy & domains sets one up end to end: a free DuckDNS name,
                   the nginx configuration, and an HTTPS certificate from Let's
                   Encrypt. It needs ports 80 and 443 forwarded to this machine
                   on your router, and says so before it starts.

  Everything lives in ${STACK_DIR}
  Remove it all with:
      bash ${STACK_DIR}/uninstall.sh

SUMMARY
printf '%s─────────────────────────────────────────────────%s\n\n' "$DIM" "$R"

say "First lines from the control panel"
sleep 3
$DOCKER_SUDO docker logs --tail 25 quickstart-home-manager 2>&1 || true
printf '\n%sFollow along with:%s docker logs -f quickstart-home-manager\n\n' "$DIM" "$R"
