#!/bin/sh
# Start as root, run the server as `app`.
#
# The image cannot simply declare USER app. The data directory is a VOLUME, and on every
# instance that already exists its contents were created by root — secrets.json, the
# screenshot tree, the sing-box helper's scratch. A non-root process inherits none of that
# and fails on its first write, which is not a thing to discover in production.
#
# So the ownership is corrected here, at the one moment something is still privileged
# enough to do it, and the server is then handed to the unprivileged user.
set -e

# The base image's own user, uid 1000 — matching the camoufox and cf-proxy sidecars, so a
# bind-mounted data directory has a single owner across all three containers.
APP_USER=node
DATA="${DATA_DIR:-/app/data}"

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged (someone passed --user, or a re-exec): nothing to hand over.
  exec "$@"
fi

APP_UID="$(id -u "$APP_USER")"

# Only when it is not already right. chown -R over a large screenshot tree is not something
# to do on every restart, and after the first run it is always already correct.
if [ "$(stat -c %u "$DATA" 2>/dev/null || echo -1)" != "$APP_UID" ]; then
  echo "entrypoint: taking ownership of $DATA for $APP_USER" >&2
  chown -R "$APP_USER:$APP_USER" "$DATA" 2>/dev/null || true
fi

# Prove it before relying on it. A read-only mount, a volume driver that ignores chown, or
# a host-mapped directory owned by someone else all leave a process that cannot write, and
# the failure would surface later as a corrupt-looking install rather than a permissions
# problem.
if su -s /bin/sh -c "test -w '$DATA'" "$APP_USER" 2>/dev/null; then
  exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups "$@"
fi

# Could not. Running as root is what this image has always done, so it stays up — losing
# the hardening is bad, refusing to start is worse, and this line says which happened.
echo "entrypoint: WARNING — $DATA is not writable by $APP_USER; continuing as root." >&2
echo "entrypoint: the container keeps working, but without the privilege drop." >&2
exec "$@"
