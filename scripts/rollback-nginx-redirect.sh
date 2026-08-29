#!/usr/bin/env bash
#
# Rollback the muaj.bro.bd -> Cloudflare Worker redirect migration.
#
# Restores /etc/nginx/sites-available/muaj.bro.bd from the most recent
# timestamped backup created during the migration, validates the config,
# and reloads Nginx gracefully.
#
# Usage (run as root on the VPS):
#   bash scripts/rollback-nginx-redirect.sh              # newest backup
#   bash scripts/rollback-nginx-redirect.sh <TIMESTAMP>  # specific backup
#
set -euo pipefail

BACKUP_DIR=/root/nginx-backups
TARGET=/etc/nginx/sites-available/muaj.bro.bd

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root." >&2
    exit 1
fi

if [[ $# -ge 1 ]]; then
    TS="$1"
else
    if [[ ! -f "$BACKUP_DIR/LAST_BACKUP_TS" ]]; then
        echo "ERROR: $BACKUP_DIR/LAST_BACKUP_TS not found. Pass a timestamp explicitly." >&2
        exit 1
    fi
    TS="$(cat "$BACKUP_DIR/LAST_BACKUP_TS")"
fi

BACKUP="$BACKUP_DIR/muaj.bro.bd.bak_$TS"
if [[ ! -f "$BACKUP" ]]; then
    echo "ERROR: backup not found: $BACKUP" >&2
    echo "Available backups:" >&2
    ls -1 "$BACKUP_DIR"/muaj.bro.bd.bak_* 2>/dev/null >&2 || echo "  (none)" >&2
    exit 1
fi

# Snapshot the current state first, so the rollback itself is reversible.
PRE="$BACKUP_DIR/muaj.bro.bd.before_rollback_$(date +%Y%m%d%H%M%S)"
cp -a "$TARGET" "$PRE"
echo "Current config saved to: $PRE"

cp -a "$BACKUP" "$TARGET"
echo "Restored from: $BACKUP"

if nginx -t; then
    systemctl reload nginx
    echo "OK: Nginx validated and reloaded gracefully."
    echo
    echo "Verify:"
    echo "  curl -I https://muaj.bro.bd/"
    echo "  curl -I https://origin.muaj.bro.bd/"
else
    echo "ERROR: nginx -t failed after restore. Reverting to pre-rollback state." >&2
    cp -a "$PRE" "$TARGET"
    nginx -t || true
    exit 1
fi
