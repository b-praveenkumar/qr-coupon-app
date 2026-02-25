#!/usr/bin/env sh
set -e
URL="${1:-http://localhost:3000/admin}"
if [ -z "$ADMIN_USER" ] || [ -z "$ADMIN_PASS" ]; then
  echo "Set ADMIN_USER and ADMIN_PASS env vars."
  exit 1
fi

status=$(curl -s -o /dev/null -w "%{http_code}" -u "$ADMIN_USER:$ADMIN_PASS" "$URL")
if [ "$status" = "200" ]; then
  echo "OK 200"
  exit 0
fi

echo "Unexpected status: $status"
exit 1
