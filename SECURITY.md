# Security policy

## Scope

Habibi is a single-user macOS application. Its local service binds only to
`127.0.0.1` and rejects non-local Host and Origin values. It is not designed to
be exposed through a proxy, a LAN address, or a cloud host.

The highest-impact reports are credential handling, arbitrary file access,
connector data leaks, approval bypasses, command execution, and a way for a
web page to control the loopback service.

## Reporting a vulnerability

Please do not open a public issue containing reproduction steps for a security
problem. Email the maintainers listed in the repository's GitHub security
advisory contact with a concise reproduction, affected version, and impact.
We aim to acknowledge reports within five business days and coordinate a fix
before disclosure.

## Local data

Credentials, connector sessions, and local snapshots belong in
`~/Library/Application Support/Habibi` (or the configured local data root).
They must never be included in bug reports, screenshots, fixtures, or commits.
