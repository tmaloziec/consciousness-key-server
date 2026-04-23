# Contributing to Consciousness Key Server

Thanks for your interest in contributing! This document explains how to get involved.

## Quick Start

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Test locally (`docker compose up` and curl `/health`)
5. Open a Pull Request
6. Sign the CLA (one click via [CLA Assistant bot](https://cla-assistant.io/))

## Contributor License Agreement (CLA)

Before your Pull Request can be merged, you must sign the [CLA](CLA.md). The CLA Assistant bot will automatically prompt you on your first PR — one click, one time, all future contributions covered.

**Why a CLA?** Consciousness Key Server is dual-licensed (AGPLv3 + commercial). To offer commercial licenses to organizations that need them, the project must hold the rights to all contributed code. Without a CLA, a single contributor could block commercial licensing.

The CLA does **not** transfer ownership of your code. You retain copyright. You simply grant the Maintainer the right to license the project (including your contributions) under multiple licenses.

## Security is the product

This repo is a secrets vault. The bar for changes is higher than for a normal service:

- **Defense in depth** — every new endpoint must pass auth, must audit-log every outcome (not only successes), and must reject path traversal input.
- **Zero dependencies** is a feature, not a coincidence. Do not add a dependency without an issue discussion first.
- **Backward-compatible audit format** — the audit log is append-only and may be consumed by SIEMs. Don't change field order or separators within a minor version.

## What to Contribute

Welcomed:

- **Bug fixes** for auth bypass, path traversal, log injection, DoS
- **Better auth backends** — bcrypt / Argon2 key hashing, mTLS, JWT validators — but **only** as opt-in. Zero-dep + IP allowlist stays the default.
- **New secret types** — e.g. TLS cert bundles, cloud IAM credentials, OAuth refresh tokens
- **Client libraries** — curl example in multiple languages under `examples/`
- **Integration docs** for CS, Cortex, and other agent systems
- **Tests** — there are none yet; add them

Cautious:

- **Dependencies** — every dep is a supply-chain attack surface. Justify in the issue.
- **New daemons / background jobs** — vault should not surprise an operator with hidden work.
- **Changes to the on-disk layout of `keys/`** — breaking existing deployments without a migration script is a no-go.

## Code Style

- **JavaScript**: Node stdlib only. 2-space indent, semicolons.
- **No emojis in code paths** — emojis in log messages OK if they survive ASCII-only terminals (currently `🔐 📁 🔒 📝 🚀` at startup — keep this minimal).
- **Comments** — explain *why*, not *what*. Code is self-documenting.
- **No private data** in PRs — no IPs, no sample keys, no emails.

## Testing

```bash
# Syntax check
node --check server.js

# Smoke with docker
docker compose up -d
curl -s http://localhost:3040/health | jq
docker compose down
```

## Reporting Bugs / Security Issues

- **Bugs**: Open an issue with reproduction steps and environment.
- **Security vulnerabilities**: Do **not** open a public issue. Contact the maintainer privately via [github.com/tmaloziec](https://github.com/tmaloziec). We aim to respond within 7 days.

## Pull Request Checklist

- [ ] CLA signed
- [ ] Branch from `main`, rebased
- [ ] Code follows existing style
- [ ] Smoke-tested locally
- [ ] PR description explains *what* and *why*
- [ ] No private data in commits
- [ ] New env vars documented in `.env.example`
- [ ] New endpoints audit-logged + documented in `README.md`

## License

By contributing, you agree that your contributions will be licensed under the project's dual license (AGPLv3 + commercial), as described in the [CLA](CLA.md).

---

Questions? Open a [Discussion](https://github.com/build-on-ai/consciousness-key-server/discussions) or file an issue.
