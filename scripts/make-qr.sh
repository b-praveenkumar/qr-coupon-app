#!/usr/bin/env sh
set -e
URL="$1"
if [ -z "$URL" ]; then
  echo "Usage: ./scripts/make-qr.sh https://your-domain.com"
  exit 1
fi

echo "URL: $URL"

if command -v qrencode >/dev/null 2>&1; then
  OUT="qr.png"
  qrencode -o "$OUT" -s 8 "$URL"
  echo "Generated $OUT using qrencode."
else
  echo "qrencode not found."
  echo "Open this URL in any QR generator website to create a PNG:"
  echo "$URL"
fi
