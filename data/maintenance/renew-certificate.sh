#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
set -a
source "$root/.env"
set +a

docker compose --profile maintenance run --rm certbot renew \
  --cert-name "$CERTBOT_CERT_NAME" \
  --webroot --webroot-path /var/www/acme \
  --non-interactive

source_dir=$root/data/certbot/etc/live/$CERTBOT_CERT_NAME
target_dir=$root/data/certs/mail
if [[ -s $source_dir/fullchain.pem && -s $source_dir/privkey.pem ]]; then
  if cmp -s "$source_dir/fullchain.pem" "$target_dir/fullchain.pem" && \
     cmp -s "$source_dir/privkey.pem" "$target_dir/privkey.pem"; then
    exit 0
  fi
  install -m 0644 -o 2000 -g 101 "$source_dir/fullchain.pem" "$target_dir/fullchain.pem"
  install -m 0640 -o 2000 -g 101 "$source_dir/privkey.pem" "$target_dir/privkey.pem"
  docker compose kill -s HUP nginx
  docker compose restart stalwart
fi
