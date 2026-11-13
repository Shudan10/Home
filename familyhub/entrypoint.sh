#!/bin/sh
# Starts as root only long enough to hand /data to the node user, then drops to
# it for good.
#
# The volume predates the image running as anything but root, so on an existing
# install every file in it is root's, and node could neither save nor rename
# over them. Fixing ownership here, at each start, means an upgrade needs no
# step from anybody. Only what is not node's already is touched, so a normal
# start changes nothing on disk.
set -e

DATA="${MEALPLAN_DATA:-/data}"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA"
    find "$DATA" \( ! -user node -o ! -group node \) -exec chown node:node {} +
    exec su-exec node "$@"
fi

# Already somebody else -- `user:` set in compose, say. Nothing to hand over.
exec "$@"
