#!/usr/bin/env python3
"""CleanFrame TV launcher — watcher + status page.

Runs in a container on the home stack. It watches the TV's developer port and,
when the TV powers on, launches CleanFrame over SDB. It never writes to the TV.

It also serves a small status page (see CF_STATUS_PORT) so the panel has
something to open: current state, whether the TV is reachable, the last launch,
and recent log lines.

The TV allows only one developer (SDB) connection at a time. While this is
running it owns that connection, so stop this app before doing a host-side
CleanFrame rebuild/reinstall.
"""
import json
import os
import socket
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---- Config (from the panel via environment) ----
TV_IP = os.environ.get("CF_TV_IP", "192.168.4.136")
SDB_PORT = int(os.environ.get("CF_SDB_PORT", "26101"))
APP_ID = os.environ.get("CF_APP_ID", "AThO0Ps28U.CleanFrame")
SDB = os.environ.get("CF_SDB", "/opt/sdb")
POLL = float(os.environ.get("CF_POLL", "0.4"))
OFF_SECONDS = float(os.environ.get("CF_OFF_SECONDS", "15"))
LAUNCH_RETRIES = int(os.environ.get("CF_LAUNCH_RETRIES", "12"))
LAUNCH_GAP = float(os.environ.get("CF_LAUNCH_GAP", "1.5"))
STATUS_PORT = int(os.environ.get("CF_STATUS_PORT", "8080"))

SERIAL = f"{TV_IP}:{SDB_PORT}"

# ---- Shared state (read by the status page) ----
_lock = threading.Lock()
_state = {
    "tv_ip": TV_IP,
    "app_id": APP_ID,
    "tv_reachable": False,
    "armed": True,
    "last_launch": None,       # epoch seconds
    "last_launch_ok": None,    # bool
    "started": time.time(),
}
_logs = deque(maxlen=50)


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with _lock:
        _logs.append(line)


def set_state(**kw):
    with _lock:
        _state.update(kw)


def port_open(host, port, timeout=1.0):
    try:
        with socket.create_connection((host, port), timeout):
            return True
    except OSError:
        return False


def sdb(*args, timeout=20):
    try:
        return subprocess.run([SDB, *args], capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, FileNotFoundError) as err:
        log(f"sdb error: {err}")
        return None


def launch_cleanframe():
    for attempt in range(1, LAUNCH_RETRIES + 1):
        sdb("connect", SERIAL)
        res = sdb("-s", SERIAL, "shell", "0", "execute", APP_ID)
        out = ((res.stdout if res else "") + (res.stderr if res else ""))
        if res is not None and "successfully launched" in out:
            log(f"CleanFrame launched (attempt {attempt}).")
            set_state(last_launch=time.time(), last_launch_ok=True)
            return True
        time.sleep(LAUNCH_GAP)
    log("Could not launch CleanFrame after retries; re-arming on next power cycle.")
    set_state(last_launch=time.time(), last_launch_ok=False)
    return False


def watcher():
    log(f"Watching {SERIAL} -> {APP_ID} (poll {POLL}s, off>{OFF_SECONDS}s re-arms).")
    armed = True
    off_since = None
    while True:
        up = port_open(TV_IP, SDB_PORT, timeout=min(1.0, POLL + 0.5))
        set_state(tv_reachable=up, armed=armed)
        if up:
            off_since = None
            if armed:
                log("TV reachable and armed -> launching CleanFrame.")
                launch_cleanframe()
                armed = False
        else:
            now = time.monotonic()
            if off_since is None:
                off_since = now
            elif not armed and (now - off_since) >= OFF_SECONDS:
                log("TV off/unreachable; re-armed for next power-on.")
                armed = True
        time.sleep(POLL)


# ---- Status page ----
PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TV Launcher</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--mut:#666;--ok:#1a7f37;--bad:#b00020;--card:#f5f5f5;--bd:#e0e0e0}
@media(prefers-color-scheme:dark){:root{--fg:#eee;--mut:#aaa;--card:#1e1e1e;--bd:#333}}
body{font:15px/1.5 system-ui,sans-serif;color:var(--fg);margin:0;padding:24px;max-width:640px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 20px}
.row{display:flex;justify-content:space-between;padding:10px 14px;border:1px solid var(--bd);border-radius:10px;background:var(--card);margin-bottom:8px}
.k{color:var(--mut)}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
pre{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;overflow:auto;font-size:12px;max-height:40vh}
</style></head><body>
<h1>TV Launcher</h1>
<p class="sub">Launches CleanFrame on the TV at power-on. Nothing is written to the TV.</p>
<div id="rows"></div>
<h2 style="font-size:15px">Recent activity</h2>
<pre id="logs">Loading…</pre>
<script>
function fmt(t){return t?new Date(t*1000).toLocaleString():'—'}
async function tick(){
 try{const s=await (await fetch('status.json',{cache:'no-store'})).json();
 document.getElementById('rows').innerHTML=[
  ['TV ('+s.tv_ip+')', s.tv_reachable?'<span class=ok>reachable</span>':'<span class=bad>off / unreachable</span>'],
  ['State', s.armed?'armed — waiting for power-on':'quiet — TV in use'],
  ['Last launch', fmt(s.last_launch)+(s.last_launch==null?'':(s.last_launch_ok?' <span class=ok>ok</span>':' <span class=bad>failed</span>'))],
  ['App', s.app_id],
 ].map(r=>`<div class=row><span class=k>${r[0]}</span><span>${r[1]}</span></div>`).join('');
 document.getElementById('logs').textContent=(s.logs||[]).join('\\n')||'No activity yet.';
 }catch(e){document.getElementById('logs').textContent='Status unavailable: '+e}
}
tick();setInterval(tick,2000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif path == "/status.json":
            with _lock:
                payload = dict(_state)
                payload["logs"] = list(_logs)
            self._send(200, json.dumps(payload), "application/json")
        elif path in ("/healthz", "/health"):
            self._send(200, "ok", "text/plain")
        else:
            self._send(404, "not found", "text/plain")

    def log_message(self, *a):  # quiet; the watcher does its own logging
        pass


def main():
    if not os.path.isfile(SDB):
        log(f"sdb not found at {SDB}. Mount the host sdb to this path. Exiting.")
        return 1
    threading.Thread(target=watcher, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
