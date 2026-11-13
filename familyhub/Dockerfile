# Meal Plan: a family meal planner served to phones on the house network.
#
# Zero npm dependencies, like the rest of this stack -- everything is Node
# stdlib, so the image builds without reaching a registry for a dependency tree
# and there is nothing to audit.
#
# Pinned to a minor version and an Alpine release, so a rebuild is the image
# that was tested plus security patches, not whatever Node 22 or Alpine became
# in the meantime. Moving it on is a one-line change, made on purpose.
FROM node:22.23-alpine3.24

# su-exec is how the entrypoint drops from root to node: a few kilobytes, and
# it execs rather than forking, so tini's child is the server itself.
RUN apk add --no-cache tini su-exec

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY --chmod=755 entrypoint.sh /usr/local/bin/mealplan-entrypoint

ENV NODE_ENV=production \
    PORT=8080 \
    MEALPLAN_DATA=/data

# The meal library and the plan. A named volume is mounted here by compose, so
# rebuilding the image never touches what the family has typed in. Owned by
# node in the image, which a brand-new volume copies when first mounted.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini, so a container stop is a signal the process actually receives rather
# than a ten-second wait followed by a kill.
#
# The server runs as node, not root -- but there is no USER line, on purpose.
# The container has to start as root for the entrypoint to take over a volume
# whose files root owns from before; it then drops to node before the server
# starts. The healthcheck runs as root still, which only ever fetches /healthz.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/mealplan-entrypoint"]
CMD ["node", "server.js"]
