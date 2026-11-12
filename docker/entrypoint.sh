#!/bin/sh
set -e

# When started as root (the default), make sure the data folder belongs to PUID:PGID
# and then drop privileges. This avoids "permission denied" on NAS shared folders.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "${PUID}:${PGID}" "$DATA_DIR" 2>/dev/null || echo "Warning: could not change owner of $DATA_DIR"
  exec su-exec "${PUID}:${PGID}" "$@"
fi

exec "$@"
