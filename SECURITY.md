# Security

consciousness-key-server is a **secrets vault** — a small HTTP
service that hands out SSH keys, API tokens, and ed25519 pub-key
verdicts on demand. It stores private keys on disk and gates
access with an IP allow-list plus an optional API key.

## Intended deployment

Single host, trusted LAN or VPN. Never exposed directly to the
public internet. The threat model assumes the operator owns the
host, the filesystem, and the set of callers that can reach port
3040.

## What it holds

| Kind | Where | Authorisation to read |
|---|---|---|
| SSH private keys | `keys/ssh/<name>` | IP allow-list + optional `X-API-Key` |
| API tokens | `keys/<service>/api-key.txt` | IP allow-list + optional `X-API-Key` |
| Agent public keys | `keys/agents/<agent>.pub` | No gate — public keys are public |
| Audit log | `logs/audit.jsonl` | Read by operator; not exposed over HTTP |

## Deliberate trade-offs (not bugs)

### Private keys live in plaintext on disk

No at-rest encryption, no HSM, no envelope keys. The file
permissions are the guard. If someone can read `keys/ssh/*` on
the host, they have your keys. **Back the disk up encrypted, or
use full-disk encryption on the host.**

### IP allow-list uses prefix match, not CIDR parsing

A simple string-prefix check (e.g. `10.0.0.` matches `10.0.0.42`)
keeps the code zero-dependency and easy to audit. It is **not**
a substitute for a firewall. Run the service behind a firewall or
VPN where only intended hosts can reach port 3040.

### Optional X-API-Key as second factor

When present in `auth/allowed-clients.json`, every request also
needs a correct `X-API-Key`. When absent, IP allow-list is the
only gate. Set both on any deployment that is not strictly
127.0.0.1.

### Audit log keeps every request

`logs/audit.jsonl` records each verify/dispense call with IP,
endpoint, result, and timestamp. The file self-rotates at 50 MB.
If you need compliance logging, ship the jsonl to your SIEM;
the service itself does nothing beyond writing locally.

### Never fail-open on Redis

In `AUTH_MODE=enforce` the ecosystem wires key-server's
`/api/verify` endpoint as the authority for signed-request
verification. When Redis (the anti-replay store) is unreachable,
verify returns `503`, not `200`. Fail-open would let a DoS on
Redis silently de-authenticate every block in the ecosystem.

## What this document does NOT cover

- Transport encryption. All traffic is plaintext HTTP. Wrap in a
  VPN, stunnel, or a reverse proxy with TLS if crossing networks.
- Key rotation policy. The service accepts rotation (drop a new
  file, remove the old) but does not enforce or schedule it.
  Rotate on your own cadence.
- Protection against a compromised host. If root on the host is
  taken, the keys are gone. Nothing inside this service can
  prevent that.

## Reporting a vulnerability

Report privately, not in public GitHub issues.

- **Email:** buildonai.tm@gmail.com
- **GitHub Security Advisory:** https://github.com/build-on-ai/consciousness-key-server/security/advisories/new

Include:

1. A clear description and impact (read keys? write keys?
   bypass IP allow-list? audit evasion?)
2. Steps to reproduce
3. Your preferred credit / disclosure terms

Expect acknowledgement within a few business days. Critical
issues — unauthenticated key disclosure, IP-allow-list bypass,
signature forgery — get priority.

## Hardening checklist for operators

- [ ] Set a strong `X-API-Key` in `auth/allowed-clients.json`
      and require it. Do not rely on IP allow-list alone.
- [ ] Bind port 3040 to loopback or a VPN interface, never
      `0.0.0.0` on a host with a public IP.
- [ ] Host-level full-disk encryption (LUKS, FileVault, BitLocker)
      so private keys at rest are not plaintext on a stolen drive.
- [ ] File permissions `600` on everything in `keys/` — owned by
      the single user that runs the service.
- [ ] Ship `logs/audit.jsonl` to your SIEM if you have one; at
      minimum, monitor for unexpected source IPs.
- [ ] Rotate keys whenever you suspect the host was compromised.
