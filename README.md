# Quick Start Home

A personal home server in one command: a web control panel that installs, runs
and publishes the things you actually want on your own machine.

```bash
curl -fsSL https://raw.githubusercontent.com/Shudan10/Home/main/install.sh | bash
```

It installs Docker if it is missing, sets up the control panel, prints a
password, and stops. Nothing else is installed until you ask for it.

Today it carries **Nextcloud**, **Jellyfin** and **Meal Plan**, and puts any of
them on your own domain through a **Cloudflare Tunnel**. More apps will be added.

---

## What you get

**The panel** — one page for the whole machine. How much disk is left, what is
running, and a switch for each thing. It holds the Docker socket, so it is
password-protected and that is not optional.

**Nextcloud** — your own cloud for files, photos, calendars and contacts, with
its own database, Redis cache and preview generator. The panel switches the
preview providers on for you every time Nextcloud starts, so video thumbnails
(via ffmpeg) and the whole image set including iPhone HEIC and HEIF (via
Imaginary) work without touching a config file. Nextcloud's own default covers
only PNG, JPEG, GIF, BMP and WebP.

**Jellyfin** — your own media server for films, TV and music, streamed to
phones, browsers, smart TVs, Roku, Fire TV and Kodi. You give the panel the
folders your media is in and it mounts them **read-only**, so nothing here can
alter or delete your library. It checks each folder exists before saving —
Docker's own response to a path that is not there is to create an empty one and
mount that, which turns a typo into an empty library and a stray root-owned
directory. If the machine has a GPU, one checkbox hands it over for transcoding.

**Tunnel and domains** — your apps on a domain you own, like
`meals.yourdomain.com`, through a Cloudflare Tunnel. A small connector on this
machine dials out to Cloudflare and visitors come back in through it, so there
are no ports to open on your router, no certificates to renew (Cloudflare serves
HTTPS), and it works even when your internet provider never gave you an address
of your own. You paste one Cloudflare API token; the panel makes the tunnel and
the DNS record for each name, and will not overwrite a DNS record it did not
make. Anything else on your network with a web page can be published the same
way, by its address and port.

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

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | `~/.quickstart-home` | Where everything lives |
| `--gui-port <port>` | `8420` | The panel's port |
| `--bind <address>` | `0.0.0.0` | What the panel listens on |
| `--password <pass>` | generated | The panel password |
| `--yes, -y` | | Do not ask anything |

Every flag has a `QSH_`-prefixed environment variable (`QSH_STACK_DIR`,
`QSH_GUI_PORT`, …) for scripted installs.

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

## Where things live

Everything is in one directory (`~/.quickstart-home` by default):

```
docker-compose.yml     the stack
manager/               the control panel (Node, no dependencies)
nextcloud/             the Nextcloud image build
conf/                  generated state: settings, port and mount overrides,
                       build records
.env                   generated secrets and the panel password hash
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

`--keep-data` preserves the volumes. Docker itself is never touched: it is
shared machine-wide, and removing it would take every unrelated container with
it. The panel has the same thing under Global settings → Remove everything.

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
   and the teardown lists in `manager/lib/selfservice.js` and `uninstall.sh`.
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
