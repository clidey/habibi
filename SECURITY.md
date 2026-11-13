# Security policy

## Scope

Habibi is a single-user desktop application for macOS, Windows, and Linux. It
runs no local web server: its browser UI reaches the Rust backend only over the
app's own Tauri IPC, and only the launcher window may call those commands. The
only loopback listeners are short-lived OAuth redirect handlers that exist
while a sign-in is pending (mail on `127.0.0.1:4173`, calendar and WhoDB on an
ephemeral port). Habibi is not designed to be exposed through a proxy, a LAN
address, or a cloud host.

The highest-impact reports are credential handling, arbitrary file access,
connector data leaks, approval bypasses, command execution, a way for web
content or another local process to reach the backend's commands, and a way to
load files outside the bundled static allowlist.

## Reporting a vulnerability

Please do not open a public issue containing reproduction steps for a security
problem. Email the maintainers listed in the repository's GitHub security
advisory contact with a concise reproduction, affected version, operating
system, and impact. We aim to acknowledge reports within five business days and
coordinate a fix before disclosure.

## Local data

Credentials live in the system credential store (macOS Keychain, Windows
Credential Manager, or the Linux Secret Service). Connector sessions and local
snapshots live in Habibi's data directory: `~/Library/Application Support/Habibi`
on macOS, `%APPDATA%\Habibi` on Windows, `~/.local/share/Habibi` on Linux, or
the directory set by `HABIBI_DATA_ROOT`. They must never be included in bug
reports, screenshots, fixtures, or commits.
