# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

Use GitHub's private reporting — the **Security** tab → **Report a vulnerability** — which
opens a draft advisory visible only to the maintainers.

Include what you need to describe the problem: the affected version or commit, the steps to
reproduce it, and what an attacker gains. A proof of concept is welcome and never required.

Expect an acknowledgement within a few days. There is no bounty.

## What this project is

An automation tool you run yourself. It holds credentials for other systems, encrypted at
rest with a key you supply, and it drives real browsers through proxies you configure.
Treat an instance as being as sensitive as the accounts it signs into.

## Deployment expectations

The application trusts its own network position. It is written to sit behind something that
terminates TLS and authenticates, and these are the assumptions that go with that:

- **Do not publish the database port.** The bundled compose files keep Postgres on the
  compose network. `POSTGRES_PASSWORD` defaults to a placeholder and is meant to be changed.
- **Set `SESSION_SECRET` and `ENCRYPTION_KEY`.** Without them a restart invalidates
  sessions, and stored credentials are only as private as the generated key file.
- **Behind a reverse proxy, set `TRUST_PROXY_HOPS`** to the number of proxies in front, so
  login rate limiting counts the real client rather than the proxy. Leave it unset when the
  app is reached directly: `X-Forwarded-For` is forgeable by anyone.
- **Set `SECURE_COOKIES=true` when served over HTTPS.**
- The dashboard password is a single factor guarding everything. Give it length.

## Scope

In scope: authentication and session handling, credential storage and retrieval, the task
runner's handling of untrusted page content, path handling in the file-serving routes,
anything that lets one instance reach another system it was not configured for.

Out of scope: the anti-detection measures failing against a given site, third-party proxy
operators seeing your traffic (they can — that is what a proxy is), and using the tool
against sites whose terms forbid it, which is on the operator.
