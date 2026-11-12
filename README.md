# Quick Start Home

A personal home server in one command: a web control panel that installs, runs
and publishes the things you actually want on your own machine.

```bash
curl -fsSL https://raw.githubusercontent.com/Shudan10/Home/main/install.sh | bash
```

It installs Docker if it is missing, sets up the control panel, prints a
password, and stops. Nothing else is installed until you ask for it.

Today it carries **Nextcloud**, **Jellyfin**, **Family Hub** (the family board that grew out of Meal Plan) and a **Minecraft**
server, and puts the web apps on your own domain through a **Cloudflare Tunnel**.
More apps will be added.

---

## What you get

**The panel** — one page for the whole machine. How much disk is left, what is
running, and a switch for each thing. It holds the Docker socket, so it is
password-protected and that is not optional.

**Nextcloud** — your own cloud for files, photos, calendars and contacts, with
its own database, Redis cache and preview generator. The panel switches the
preview providers on for you every time Nextcloud starts, so video thumbnails
(via ffmpeg), PDFs and the whole image set including iPhone HEIC and HEIF, TIFF
and SVG (via Imaginary) work without touching a config file. Nextcloud's own
default covers the common web image formats (PNG, JPEG, GIF, BMP, WebP) plus
text, Markdown, MP3 covers and OpenDocument files, with no HEIC, no video and
no PDF. Its background jobs (clean-up, preview pre-generation, notifications)
run from the panel every five minutes, through Nextcloud's own `cron.php` in
its container, so there is no cron entry to set up on this machine.

**Jellyfin** — your own media server for films, TV and music, streamed to
phones, browsers, smart TVs, Roku, Fire TV and Kodi. You give the panel the
folders your media is in and it mounts them **read-only**, so nothing here can
alter or delete your library. It checks each folder exists before saving —
Docker's own response to a path that is not there is to create an empty one and
mount that, which turns a typo into an empty library and a stray root-owned
directory. If the machine has a GPU, one checkbox hands it over for transcoding.

**Minecraft** — one world that Java Edition and Bedrock Edition (phones,
tablets, Windows, consoles) join together. It is a Paper server with Geyser and
Floodgate, so Bedrock players sign in with their Xbox account and need no Java
one. The panel holds the settings worth having (game mode, difficulty, PvP,
memory, version, world seed) and manages who can play: an allow list,
operators, bans and kicks, by Java name or Bedrock gamertag, whether or not the
server is running. Add your own Java Edition worlds by uploading them or from a
folder on this machine, and switch between them under Worlds; the one you leave
is kept. The Log tab shows what the server says and takes commands. Paper and
Geyser are fetched fresh on every start, so a restart is also the update.

Xbox, PlayStation and Switch have no Add Server button, so one switch under
Settings adds [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster):
the server signs in to a Microsoft account of its own (use a spare one, with an
Xbox profile made at xbox.com first), and
anyone who adds that account as a friend sees the server under Minecraft's
Friends tab and joins from there. Joins are relayed through Xbox Live, so this
needs no port forwarding. The panel shows the sign-in code and, once it has
worked, the gamertag to give console players.

**Tunnel and domains** — your apps on a domain you own, like
`meals.yourdomain.com`, through a Cloudflare Tunnel. A small connector on this
machine dials out to Cloudflare and visitors come back in through it, so there
are no ports to open on your router, no certificates to renew (Cloudflare serves
HTTPS), and it works even when your internet provider never gave you an address
of your own. You paste one Cloudflare API token; the panel makes the tunnel and
the DNS record for each name, and will not overwrite a DNS record it did not
make. Anything else on your network with a web page can be published the same
way, by its address and port.

**Tailscale** — if this machine is on a tailnet, the panel notices and lists
an "over Tailscale" address for every app next to the home-network and public
ones, using the machine's MagicDNS name. It also adds that name to Nextcloud's
trusted domains, which would otherwise turn it away. Minecraft gets Tailscale
join addresses too, so friends on your tailnet can play with no port forwarding.
The Tailscale page under Network shows this machine's status and every device
on the tailnet, walks through installing Tailscale on Windows, macOS, iPhone,
Android and Linux, and turns on HTTPS addresses for the apps with
`tailscale serve` (Nextcloud on 443, Jellyfin 8443, Meal Plan 8444, the panel
8445). It works through the Tailscale daemon already on this machine, so there
is no Tailscale token to make; HTTPS certificates have to be switched on once
in Tailscale's admin console first, and the page says where.

**Mullvad exit node** — on the same page, the panel can turn this machine into
a Tailscale exit node that sends what it carries through Mullvad, on your own
Mullvad account. A phone or laptop that picks it stays on the tailnet, so the
apps keep working, while its web traffic leaves through Mullvad; neither needs
the Mullvad app. It runs in its own container (`manager/mullvad/`), and only
traffic from the tailnet goes through Mullvad: this machine, its apps and the
Cloudflare tunnel keep using the home connection. If the tunnel to Mullvad
drops, tailnet traffic stops rather than falling back to the home address, and
the container stops rather than run if that kill switch cannot be set up.
IPv6 goes through Mullvad too; on a host where it cannot be routed that way,
devices get IPv4 only and their IPv6 is refused at once rather than sent out
the home connection. The `net.ipv6` settings it runs with need IPv6 enabled in
the host's kernel (see the comment on the service in `docker-compose.yml`).

**KaChat Nextcloud** — a second Nextcloud, separate from the personal one, for
the KaChat and KaPay apps: the photo, video and voice messages KaChat sends as
links, the contacts backup both apps share (encrypted on the phone), and
KaPay's portfolio files. It has no Nextcloud Talk, so KaChat calls do not go
through it. KaChat's web app at https://desktop.kachat.app connects to it
straight from the browser: Apache in its container sends CORS headers for that
one site, on only what KaChat calls, and answers the preflight itself. It installs, switches on and off, and
uninstalls like every other app; the first time its switch starts it, it sets
itself up and makes the account the apps sign in to. Its page has the rest:
accounts, app passwords to paste into the apps, the links that have been
shared with a Stop sharing button, and the KaChat folder (every file the
two apps have backed up, read live, each one downloadable). Published
through the tunnel, its name lets through only what the two apps use
(`ALLOWED_PATHS` in `manager/lib/kachat.js`); Nextcloud's web login and pages
are not on the internet.

**Backups** — one page, in the top bar, for everything worth keeping, all on one
drive plugged into the machine. Each app's own data (both Nextclouds' databases
and settings, KaChat's files, Jellyfin's users and watch history, Meal Plan,
the Minecraft worlds, and the panel's own `.env` and `conf/`) is copied as a
dated archive every night at 3 AM, in the machine's timezone, and the last few
are kept (three unless changed) in `Home Server backups/` on the drive.
Lowering that number lists the copies it would remove and asks first; at 0 no
dated copies are made or kept, and only Nextcloud's files are mirrored.
Nextcloud has two rows, each switched on or off by itself: its database and
settings (dated copies, like the other apps), and its files (the mirror). The
files row's "Choose what is mirrored" lists each user's folders, their old
versions and trash, and Nextcloud's own working files, with sizes; anything
unticked is left on the drive as it is, neither updated nor removed.
Nextcloud's files are mirrored in the same run, straight after its database,
as an ordinary folder kept exactly in step with what Nextcloud has on the
machine: only what changed is copied, and what is no longer in Nextcloud is
removed from it. More than 250 removals in one night are held on the Backups
page for confirmation instead, since that many at once usually means
something went wrong rather than that someone deleted them. Office lock
files like `~lock.*#` are left out. Nothing runs during the day. Each backup
and restore keeps its whole log in `logs/backups/` in the install directory. The Restore tab lists what is on the drive and puts any copy back from
the panel: it saves the app as it is first, so a restore can be undone the same
way, then stops the app, replaces its data and starts it again. Nextcloud can
also have files missing from it copied back from the drive. The panel-settings
copy holds passwords, so anyone with the drive can read them.

## Installing

```bash
curl -fsSL https://raw.githubusercontent.com/Shudan10/Home/main/install.sh | bash
```

Or from a checkout, which uses the files next to the script rather than
downloading them:

```bash
git clone https://github.com/Shudan10/Home.git && cd Home && ./install.sh
```

Then open `http://localhost:8420`, or the same port on this machine's address
from any other device on your network.

### Options

`install.sh`:

| Flag | Environment variable | Default | What it does |
|---|---|---|---|
| `--dir <path>` | `QSH_STACK_DIR` | `~/.quickstart-home` | Where everything lives |
| `--gui-port <port>` | `QSH_GUI_PORT` | `8420` | The panel's port |
| `--bind <address>` | `QSH_MANAGER_BIND` | `0.0.0.0` | What the panel listens on |
| `--password <pass>` | `QSH_ADMIN_PASSWORD` | generated | The panel password |
| `--stack-repo <owner/repo>` | `QSH_STACK_REPO` | `Shudan10/Home` | The GitHub repository to fetch the stack from (ignored when run from a checkout) |
| `--stack-ref <ref>` | `QSH_STACK_REF` | `main` | The branch or tag of that repository |
| `--yes, -y` | `QSH_YES=1` | | Do not ask anything: install Docker if it is missing, and generate a password if none is given |
| `--skip-docker-install` | `QSH_SKIP_DOCKER_INSTALL=1` | | Stop with an error instead of installing Docker |

`QSH_DOCKER_PROBE_TIMEOUT` (default `10`, seconds) is how long one check of
the Docker daemon may take before it counts as not answering.

With no terminal to ask on — a CI job, `ssh host 'bash -s'`, a container
without `-t` — the installer cannot ask for a password or for permission to
install Docker, so it stops before doing anything and says so. Give it
`--password` (and `--yes` if Docker may need installing), or `--yes` alone to
have a password generated and printed.

Re-running the installer is safe: it replaces the code, keeps `conf/`, and in
`.env` changes only its own settings (the directory, repository, port and
bind address, the session secret and the password hash), keeping everything
the panel wrote there.

`uninstall.sh`:

| Flag | Environment variable | What it does |
|---|---|---|
| `--dir <path>` | `QSH_STACK_DIR` | The install to remove (default: the directory the script is in, if that is an install, else `~/.quickstart-home`) |
| `--keep-data` | | Keep the app data volumes, and `.env` and `conf/` with the passwords they need |
| `--keep-base-images` | | Keep the pulled base images (node, alpine, mariadb, cloudflared, …), which other projects may share |
| `--yes, -y` | `QSH_YES=1` | Do not ask for confirmation |

### About the password

The panel drives the Docker daemon, which is root on the machine. It also binds
every interface by default, because a home server is a thing you want to open
from your phone. Those two facts together mean a password is required, so the
installer generates one and prints it if you do not supply one. Only a scrambled
copy is stored — it cannot be read back out of the files, so write it down. You
can change it any time under Global settings.

If you would rather it were reachable only from the machine itself, install with
`--bind 127.0.0.1`; the panel will then let you remove the password entirely.

## First run

Only the panel is installed. Open it and press **Install** on an app: it fetches
or builds the image and creates the containers, then leaves them **stopped**.
The switch in the sidebar is what starts things, and stopping keeps everything —
the container, the data, and the image. Throwing something away is its own tab,
and it says what it will delete.

For Minecraft, accept Mojang's EULA under its Settings tab first; the server
will not start without it. People on your network join with the address on its
Overview. To let friends elsewhere in, forward TCP 25565 and UDP 19132 on your
router to this machine (the tunnel carries web pages, not games), and turn on
**Only players on this list can join** before you do.

For Jellyfin, add your media folders under Settings before starting it, or it
will come up with an empty library. Give the paths as *this* machine sees them
(`/srv/media/Films`), not as another computer sees them over the network.

To put an app on your own domain, open **Tunnel & domains**. You need a domain
on Cloudflare and an API token with three permissions — Account › Cloudflare
Tunnel › Edit, Zone › DNS › Edit and Zone › Zone › Read — and the page walks
you through making it. Then pick the app and a name.

Two limits worth knowing before you start. Names are one level deep
(`meals.example.com`, not `meals.home.example.com`), because Cloudflare's free
certificate only covers that. And Cloudflare's terms limit serving a lot of
video through it on the free plan, so Jellyfin through a tunnel works but is
the kind of use Cloudflare reserves the right to slow down.

## Staying up to date

The panel checks once an hour whether it, or any app you have installed, has a
newer version, and shows a banner along the top when one does. Nothing updates
by itself: See update goes to the page that does it, and Later hides the banner
in that browser until a newer version comes along. Checking asks GitHub and
Docker Hub and sends them nothing about your server beyond the request itself.

Global settings → Updates has the panel's own update and, under it, every
app's: Check all apps, an Update button per app, and Update all, which lines
them up in the Update Queue one after another (and says first if one of them
is a new major version, which cannot be rolled back).

## Where things live

Everything is in one directory (`~/.quickstart-home` by default):

```
docker-compose.yml     the stack
manager/               the control panel (Node, no dependencies)
nextcloud/             the Nextcloud image build
conf/                  generated state: settings, port and mount overrides,
                       build records
.env                   generated secrets, app passwords and tokens, and the
                       panel password hash
```

App data lives in Docker volumes (`quickstart-home-nextcloud-data` and friends),
not in that directory, so removing the directory does not remove your files.
`uninstall.sh` removes both.

Your **Jellyfin media is neither**: it stays wherever it already lives on your
disk and is only ever mounted into the container read-only. Nothing in this
project — not uninstalling Jellyfin, not `uninstall.sh`, not Remove everything —
can touch it.

## Removing it

```bash
bash ~/.quickstart-home/uninstall.sh
```

It removes the containers, images, volumes and networks, the install
directory, and the panel's `tailscale serve` HTTPS addresses (only the ones it
made: ports 443, 8443, 8444 and 8445, pointing at this stack's own ports). If
something cannot be removed, it says what, and running it again picks up where
it stopped. Files an older in-panel Update left owned by root are removed with
`sudo`.

`--keep-data` keeps the volumes and, in the install directory, `.env` and
`conf/`: the Nextcloud database and the rest are no use without the passwords
in `.env`. Installing again with the same `--dir` picks all of it back up.

Docker itself is never touched: it is shared machine-wide, and removing it
would take every unrelated container with it.

The panel has the same thing under Global settings → Remove everything, and
that one also tidies up what lives outside this machine, which `uninstall.sh`
cannot: the Cloudflare tunnel and its DNS records, and the Mullvad device. If
you used either and uninstall from the command line, the script reminds you;
remove them by hand at dash.cloudflare.com (Zero Trust → Networks → Tunnels,
and each domain's DNS records) and at mullvad.net (Account → Devices), and the
exit node's machine at login.tailscale.com/admin/machines. Remove everything
leaves one thing of its own behind, the small `docker:29.9.3-cli` image it runs
in, since Docker will not delete an image while it is running; it says so, and
`docker rmi docker:29.9.3-cli` takes it away afterwards.

## Adding another app

Apps are wired in explicitly rather than generated, so adding one means editing
six places. Nextcloud and Jellyfin are worth reading as a pair first: Nextcloud
is built here from a Dockerfile, Jellyfin is pulled as a published image
(`tracksRepo: false`), and between them they show both shapes. In rough order:

1. **`docker-compose.yml`** — the services, behind a `profiles:` of their own so
   they do not exist until installed. Remember the two rules at the top of that
   file: `volumes:` take `${STACK_DIR}` host paths, `build.context:` stays
   relative. Publish no ports here; the panel writes those into
   `conf/apps-ports.yml`, along with any host folders and devices.
2. **`manager/lib/apps.js`** — an entry in `APPS` (services, container name,
   its hostname and port on the stack network) and one in `DEFAULT_APPS_CONFIG`,
   plus a branch in `validateAppsConfig`. If it needs host folders or a device, add them to
   `renderAppsPortsOverride` too — compose merges `volumes` by target path, so
   the base file's own volumes survive.
3. **`manager/lib/lifecycle.js`** — a `UNITS` entry naming its containers,
   volumes and images, with `buildable` or `pullable` depending on where the
   image comes from. Volume names are the real Docker ones, because getting
   them wrong deletes something else's data.
4. **`manager/lib/tunnel.js`** — a `SERVICES` entry so it can be put on a
   domain. Its address comes from the `publish` hostname and port in `APPS`.
5. **The container lists** — `STACK_CONTAINERS` in `manager/lib/dockerctl.js`,
   and the teardown lists in `manager/lib/selfservice.js` and `uninstall.sh`:
   containers, named volumes, and the base image at the tag it is pulled at.
   Miss these and "remove everything" quietly leaves the app running with its
   data, which is how Jellyfin and Meal Plan went unremoved for a while.
6. **`manager/public/`** — a sidebar row and a `<section id="tab-...">`, and add
   its key to `APP_KEYS` in `app.js`.

## Developing

`dev.sh` mounts your checkout over the files baked into the running image, so
edits show up without a rebuild:

```bash
./dev.sh link      # serve straight from this repo
./dev.sh watch     # same, and restart the panel on every change
./dev.sh unlink    # back to the image
./dev.sh sync      # copy the repo in and rebuild for real
./dev.sh status    # which copy is actually live
```

The panel reloads the open browser tab by itself when the server restarts, so
`watch` is generally the one you want.

There is a pre-commit hook that refuses commits carrying secrets or generated
state. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## Credit

The panel and installer began as
[Kaspa Quick Start](https://github.com/KaspaSilver/Quick-Start-Kaspa) and were
stripped down and rebuilt around a home server rather than a node.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
