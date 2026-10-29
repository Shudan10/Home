# TV Launcher (CleanFrame watcher).
#
# Tiny Python worker: watches the TV's developer port and launches CleanFrame
# over SDB when the TV powers on, and serves a small status page on 8080.
#
# Samsung's `sdb` is NOT bundled here (it is proprietary). The compose service
# bind-mounts the host's sdb binary to /opt/sdb at runtime. sdb needs only the
# standard C/C++ runtime, which this image already has.
FROM python:3.12-slim

WORKDIR /app
COPY watch.py /app/watch.py

ENV CF_SDB=/opt/sdb \
    CF_STATUS_PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=3)" || exit 1

CMD ["python3", "-I", "/app/watch.py"]
