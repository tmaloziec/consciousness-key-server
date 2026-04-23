# Consciousness Key Server

**Zero-dependency secrets vault for multi-agent AI systems.**

[![CI](https://github.com/build-on-ai/consciousness-key-server/actions/workflows/ci.yml/badge.svg)](https://github.com/build-on-ai/consciousness-key-server/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Commercial License Available](https://img.shields.io/badge/Commercial-Available-green.svg)](LICENSE-COMMERCIAL.md)
[![Zero Dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen.svg)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-brightgreen.svg)](package.json)

A small HTTP service that hands out SSH private keys and API tokens to **authorized machines and agents** in a locked-down environment.

Designed as a sidecar for [Consciousness Server](https://github.com/build-on-ai/consciousness-server) and [Cortex](https://github.com/build-on-ai/cortex), but works standalone for any system that needs a small trusted vault without pulling in HashiCorp Vault or a cloud KMS.

## Why this exists

If you run a team of AI agents, each one eventually needs credentials — SSH keys to push code, API tokens to call services, bearer tokens to authenticate into your own infrastructure. Three bad patterns you want to avoid:

1. **`.env` files scattered everywhere** — duplicated across hosts, leaked by `git add -A`, never rotated.
2. **Hardcoded secrets in config** — even in private repos, they leak the moment a fork goes public.
3. **Full vault (Vault / KMS / Secret Manager)** — overkill for a small team; brings its own operational burden.

Consciousness Key Server is the boring middle path: one 300-line Node.js file, **zero runtime dependencies**, IP allow-list + optional API key header, every request audit-logged.

## Quick start

```bash
git clone https://github.com/build-on-ai/consciousness-key-server.git
cd consciousness-key-server
cp auth/allowed-clients.example.json auth/allowed-clients.json
# edit auth/allowed-clients.json: add your client IPs and API keys
docker compose up -d
curl http://localhost:3040/health
```

You should see:

```json
{
  "status": "ok",
  "service": "key-server",
  "version": "1.0.0",
  "uptime": 3.2,
  "timestamp": "2026-04-18T15:00:00.000Z"
}
```

## Vault layout

The on-disk layout of `keys/` is deliberately simple — `ls` tells you what's there:

```
keys/
├── ssh/
│   ├── github-deploy          ← private SSH key (file contents served as-is)
│   ├── github-deploy.pub      ← public key (hidden from /keys/list)
│   └── server-backup
└── <service-name>/
    └── api-key.txt            ← single-line token
```

- SSH private keys go in `keys/ssh/<name>` (no extension).
- API tokens go in `keys/<service>/api-key.txt`.
- Permissions: run `chmod 600 keys/ssh/* keys/*/api-key.txt` after populating.

## API

| Method | Path                     | Purpose                                      |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/health`                | Health + uptime                              |
| GET    | `/keys/list`             | List available SSH keys and API services     |
| GET    | `/keys/ssh/:name`        | Get an SSH private key (returns `text/plain`)|
| GET    | `/keys/api/:service`     | Get an API key (returns JSON)                |
| GET    | `/audit`                 | Last 100 audit-log entries                   |

### Example — fetch an SSH key

```bash
curl -s http://localhost:3040/keys/ssh/github-deploy \
  -H 'X-API-Key: replace-me-with-a-long-random-string' \
  > ~/.ssh/id_deploy
chmod 600 ~/.ssh/id_deploy
```

### Example — fetch an API key

```bash
curl -s http://localhost:3040/keys/api/openai \
  -H 'X-API-Key: replace-me-with-a-long-random-string' | jq -r .api_key
```

## Authentication

Two layers, both configured in `auth/allowed-clients.json`:

1. **IP allow-list** — `allowed_ips` accepts bare IPs or `/24`-style CIDR prefixes. Localhost (`127.0.0.1` / `::1`) is always allowed.
2. **Optional `X-API-Key` header** — if the caller sends an API key, it must match one of the values in `api_keys`; if they don't send one, the IP check alone determines access. Set a key per client so you can rotate individually.

For production, combine with a reverse proxy + TLS + network segmentation. The service itself has no TLS and does not enforce an API key on callers that come from an allow-listed IP — that's by design for low-friction LAN use.

## Audit log

Every request — success or failure — appends one line to `logs/audit.log`:

```
[2026-04-18T15:00:00.000Z] IP=10.0.0.42 ENDPOINT=/keys/ssh/github-deploy RESULT=SUCCESS size=3247
[2026-04-18T15:00:04.123Z] IP=10.0.0.99 ENDPOINT=/keys/ssh/github-deploy RESULT=FORBIDDEN IP not whitelisted
[2026-04-18T15:00:12.901Z] IP=10.0.0.42 ENDPOINT=/keys/ssh/../etc/passwd RESULT=REJECTED path_traversal_attempt
```

Format is line-oriented and stable — pipe it into your SIEM without a parser.

## Using with Consciousness Server

Consciousness Server (CS) can fetch its own bearer token from this service at startup, so you don't have to put `AUTH_TOKEN` in every `.env`.

**Step 1** — put the token into the vault:

```bash
mkdir -p keys/consciousness-server
openssl rand -base64 48 > keys/consciousness-server/api-key.txt
chmod 600 keys/consciousness-server/api-key.txt
```

**Step 2** — tell CS where to find the key server (planned for CS v0.2, tracked in [CS ROADMAP](https://github.com/build-on-ai/consciousness-server/blob/main/docs/ROADMAP.md)):

```env
# consciousness-server/.env
CS_KEY_SERVER_URL=http://localhost:3040
CS_KEY_SERVER_API_KEY=replace-me-with-a-long-random-string
```

At startup, CS will call:

```
GET /keys/api/consciousness-server
Headers: X-API-Key: <CS_KEY_SERVER_API_KEY>
```

and use the returned token as its own `AUTH_TOKEN`. This means:

- Rotating the CS auth token is a vault operation, not a deploy.
- CS process never has the token in its environment or on its command line.
- The audit log shows exactly when CS fetched the token.

**Today** (pre-v0.2), integrate manually from your deploy script:

```bash
export AUTH_TOKEN=$(curl -s -H "X-API-Key: $KEY_SERVER_API_KEY" \
  http://localhost:3040/keys/api/consciousness-server | jq -r .api_key)
docker compose up -d cs
```

## Using with Cortex

Same pattern — Cortex v1.1 plans to accept `CORTEX_KEY_SERVER_URL` (see the Cortex roadmap). Until then, the manual deploy-script approach above works identically.

## SSH key distribution for a fleet

The other common use case: you have multiple hosts (a primary server, a GPU box, a developer laptop) that all need the same deploy SSH key to push to a shared git repo. Instead of scp-ing the key around and hoping no one commits it, put the key in the vault once and have every host fetch it at boot.

**Step 1** — put the key into the vault on the primary host:

```bash
# On primary-host, as the user running key-server
mkdir -p keys/ssh
cp ~/.ssh/id_deploy keys/ssh/git-deploy
chmod 600 keys/ssh/git-deploy
```

**Step 2** — allow the other hosts by IP + API key:

```json
// auth/allowed-clients.json
{
  "allowed_ips": [
    "127.0.0.1",
    "10.0.0.0/24"
  ],
  "api_keys": {
    "gpu-box":        "long-random-string-for-gpu-box",
    "dev-laptop":     "long-random-string-for-dev-laptop",
    "ci-runner":      "long-random-string-for-ci"
  }
}
```

**Step 3** — on every other host, fetch the key at boot:

```bash
#!/usr/bin/env bash
# /etc/rc.local or a systemd oneshot unit on each host
set -euo pipefail

KEY_SERVER_URL="http://primary-host.lan:3040"
KEY_SERVER_API_KEY="long-random-string-for-gpu-box"  # this host's client key

mkdir -p "$HOME/.ssh"
curl -sS -H "X-API-Key: $KEY_SERVER_API_KEY" \
  "$KEY_SERVER_URL/keys/ssh/git-deploy" \
  > "$HOME/.ssh/id_deploy"
chmod 600 "$HOME/.ssh/id_deploy"

# (optional) also grab the known_hosts line
# curl -sS -H "X-API-Key: $KEY_SERVER_API_KEY" \
#   "$KEY_SERVER_URL/keys/ssh/known_hosts" >> "$HOME/.ssh/known_hosts"
```

Now every host has the deploy key, the key never leaves the vault, and **every fetch is in the audit log** — you can see who grabbed what and when:

```
[2026-04-18T08:00:01Z] IP=10.0.0.20 ENDPOINT=/keys/ssh/git-deploy RESULT=SUCCESS size=3247
[2026-04-18T08:00:03Z] IP=10.0.0.30 ENDPOINT=/keys/ssh/git-deploy RESULT=SUCCESS size=3247
[2026-04-18T14:22:05Z] IP=10.0.0.99 ENDPOINT=/keys/ssh/git-deploy RESULT=FORBIDDEN IP not whitelisted
```

### Rotating the key

1. Generate a new SSH key pair on primary host.
2. Update the upstream (e.g. GitHub Deploy Keys) with the new public key.
3. Copy the new private key into `keys/ssh/git-deploy` on primary host (overwrite).
4. Every client re-fetches on its next boot / cron — no manual scp-ing.

That's the fleet pattern: one source of truth, auditable distribution, zero secrets in `.env` files.

## Port convention

Listens on **3040** by default — part of the Consciousness Server ecosystem reserved range **3030–3050**. Change via `KEY_SERVER_PORT`.

## Threat model (what this defends against and what it doesn't)

**Defends against:**

- Accidental disclosure from `git push` (keys live outside the repo).
- Shared-secret-in-env-file leaks (you rotate one vault entry, not 10 `.env` files).
- Path traversal probes (hard-coded rejection of `..` and `/` in key names).
- Silent access (audit log records every request).

**Does not defend against:**

- A compromised host inside the IP allow-list (IP auth only).
- Weak or leaked `X-API-Key` values (you set them — keep them long and random).
- Lack of TLS (plain HTTP — wrap in a reverse proxy for cross-host use).
- A malicious reader on the same filesystem as the vault (use OS permissions).

## License

Dual-licensed:

- **AGPLv3** for open source, personal, and internal use — see [LICENSE](LICENSE).
- **Commercial license** for SaaS, embedded use, or proprietary modifications — see [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

Contributions require a signed [CLA](CLA.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for the security-first contribution bar.

## Status

**v0.1.0** — first public release. The API is small and intended to stay small; v1.0 will freeze it.

## Credits

Built by [Tomasz Małozięć](https://github.com/tmaloziec) as the auth sidecar for a multi-agent AI ecosystem. Intentionally boring — a secrets vault shouldn't be exciting.
