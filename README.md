# Stalwart mail stack

Docker Compose configuration for a self-hosted Stalwart deployment. The stack
includes Stalwart, Bulwark webmail, nginx, Certbot, and a small `rules-watcher`
service used for IMAP-client-driven `Rules/*` selector folders.

## Repository layout

- `docker-compose.yml` defines the live services and pinned container images.
- `data/stalwart/config/config.json` selects Stalwart's persistent storage.
- `data/nginx/templates/nginx.conf.template` is rendered from `.env` by the
  nginx container entrypoint, then terminates TLS and proxies Stalwart and
  Bulwark. The rendered configuration is not tracked.
- `data/maintenance/renew-certificate.sh` renews and installs TLS certificates.
- `rules-watcher/` contains the JMAP/Sieve control-folder automation.
- `send-mail-tester.py` sends an authenticated SMTP delivery probe using a
  password supplied through the `PASS` environment variable.

## Secrets and persistent data

The repository uses an allowlist `.gitignore`. Mail databases, messages,
Bulwark settings, migration archives, backups, certificates, DKIM private keys,
watcher state, plaintext password files, and `.env` are deliberately excluded.
Real domains, addresses, bind IPs, route maps, and forwarding maps belong only
in `.env`.

Most live Stalwart configuration is stored in Stalwart's RocksDB database, not
in ordinary configuration files. This repository therefore captures the safe
filesystem configuration and source code, but it is not a complete backup or a
standalone disaster-recovery artifact.

Before starting a new deployment:

1. Copy `.env.example` to `.env` and set strong `SESSION_SECRET` and
   `ADMIN_PASSWORD` values, along with the deployment's private routing values.
2. Provision `secrets/rules-watcher/bot_password` with mode `0600`.
3. Provision the Stalwart database, DKIM keys, and TLS certificates under the
   paths mounted by `docker-compose.yml`.
4. Run `docker compose config --quiet`, then `docker compose up -d`.

See [`rules-watcher/README.md`](rules-watcher/README.md) for selector-folder
behavior. The watcher does not perform LLM classification.
