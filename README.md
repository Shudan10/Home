# Quick Start Home

A personal home server in one command: a web control panel that installs, runs
and publishes the things you actually want on your own machine.

```bash
curl -fsSL https://raw.githubusercontent.com/Shudan10/Home/main/install.sh | bash
```

It installs Docker if it is missing, sets up the control panel, prints a
password, and stops. Nothing else is installed until you ask for it.

Today it carries **Nextcloud** and a **reverse proxy** with free HTTPS. More
apps will be added.

---

## What you get

**The panel** — one page for the whole machine. How much disk is left, what is
running, and a switch for each thing. It holds the Docker socket, so it is
password-protected and that is not optional.

**Nextcloud** — your own cloud for files, photos, calendars and contacts, with
its own database, Redis cache and preview generator. Video thumbnails and iPhone
HEIC previews work out of the box.

**Proxy and domains** — nginx in front of everything, with a guided setup that
does the whole job end to end: a free DuckDNS name, the DNS record, the vhost,
and a Let's Encrypt certificate that renews itself. It tells you what it is about
to do before it does it, and says plainly what went wrong when a certificate
fails, which is almost always a port that is not forwarded.

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
| `--http-port <port>` | `80` | What nginx binds for http |
| `--https-port <port>` | `443` | What nginx binds for https |
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

Only the panel is installed. Open it and press **Install** on Nextcloud: it
builds the image and creates the containers, then leaves them **stopped**. The
switch in the sidebar is what starts things, and stopping keeps everything —
the container, the data, and the image that took a while to build. Throwing
something away is its own tab, and it says what it will delete.

To put Nextcloud on a real web address, go to **Proxy & domains**, switch the
proxy on, and press **Set up** next to it. You will need ports 80 and 443
forwarded to this machine on your router; the page says so before you start, and
there is a check that asks an outside service whether they actually arrive.

## Where things live

Everything is in one directory (`~/.quickstart-home` by default):

```
docker-compose.yml     the stack
manager/               the control panel (Node, no dependencies)
nextcloud/             the Nextcloud image build
proxy/                 nginx config, certificates, ACME webroot
conf/                  generated state: settings, port overrides, build records
.env                   generated secrets and the panel password hash
```

App data lives in Docker volumes (`quickstart-home-nextcloud-data` and
friends), not in that directory, so removing the directory does not remove your
files. `uninstall.sh` removes both.

## Removing it

```bash
bash ~/.quickstart-home/uninstall.sh
```

`--keep-data` preserves the volumes. Docker itself is never touched: it is
shared machine-wide, and removing it would take every unrelated container with
it. The panel has the same thing under Global settings → Remove everything.

## Adding another app

Apps are wired in explicitly rather than generated, so adding one means editing
six places. In rough order:

1. **`docker-compose.yml`** — the services, behind a `profiles:` of their own so
   they do not exist until installed. Remember the two rules at the top of that
   file: `volumes:` take `${STACK_DIR}` host paths, `build.context:` stays
   relative. Publish no ports here; the panel writes those into
   `conf/apps-ports.yml`.
2. **`manager/lib/apps.js`** — an entry in `APPS` (services, container name,
   what nginx should proxy to) and one in `DEFAULT_APPS_CONFIG`, plus a branch
   in `validateAppsConfig`.
3. **`manager/lib/lifecycle.js`** — a `UNITS` entry naming its containers,
   volumes and images. Volume names are the real Docker ones, because getting
   them wrong deletes something else's data.
4. **`manager/lib/nginx.js`** — a `TARGET_KINDS` entry and a case in
   `upstreamFor`.
5. **`manager/lib/publish.js`** — a `SERVICES` entry so it can be given a domain.
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

The panel, installer and proxy machinery began as
[Kaspa Quick Start](https://github.com/KaspaSilver/Quick-Start-Kaspa) and were
stripped down and rebuilt around a home server rather than a node.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
