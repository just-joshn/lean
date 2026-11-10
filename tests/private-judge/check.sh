#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
RUNTIME="$HERE/evidence/runtime"
/bin/mkdir -p "$RUNTIME/home" "$RUNTIME/tmp" "$RUNTIME/config" "$RUNTIME/cache"
exec /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  HOME="$RUNTIME/home" \
  TMPDIR="$RUNTIME/tmp" \
  XDG_CONFIG_HOME="$RUNTIME/config" \
  XDG_CACHE_HOME="$RUNTIME/cache" \
  MSWEA_GLOBAL_CONFIG_DIR="$RUNTIME/config" \
  PYTHONDONTWRITEBYTECODE=1 \
  /Users/josh-desktop/.pi/agent/pstack/workspaces/--Users-josh-desktop-src-personal-lean--/store/01a1be1d-6848-73c8-8143-bcde49112b0b/reference-venv/bin/python \
  "$HERE/check.py" "$@"
