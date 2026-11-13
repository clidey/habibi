# Architecture

Habibi is a Rust backend inside a Tauri v2 shell, with a browser UI rendered
in the system webview. It builds for macOS, Windows and Linux. There is no
local HTTP server and no Node host: the UI talks to Rust over Tauri IPC.

- `app.js` and `src/client/` are the browser UI, built with `@clidey/ux`. They
  still speak the same `/api/*` JSON routes and `habibiNative` bridge messages
  they did when a Swift app and a loopback Node service hosted them.
- `crates/` holds the backend, one crate per service plus shared crates for
  the contract, per-OS integration and desktop helpers.
- `src-tauri/` is the shell: windows, tray, global shortcut, IPC commands,
  the `habibi://` scheme, overlays, autostart, updater and single instance.
- `skills/<id>/manifest.json` declares built-in commands and least-privilege
  permissions.

The UI renders results and asks for approval; it never stores provider keys
or performs unapproved side effects.

## Request flow

```
Launcher UI ── fetch('/api/…') ──► init script ──► `api` command
                                                      │
                     habibi_server::Server::handle ◄──┘
                                │
                     Router ──► service (Routes impl) ──► habibi_platform / provider
                                │
                     validated local state under state_root/.habibi/
```

- The shell serves the page from bundled resources through the `habibi://`
  custom URI scheme. Only an explicit allowlist of static files is reachable
  (`src-tauri/src/protocol.rs`), so `.habibi/`, `.openwa/`, `.env`, `.git` and
  `package.json` can never be served. GET-only resources the UI loads with
  `src=` (`/api/app-icon`, `/api/file`, clipboard previews) are served by the
  same scheme.
- An init script (`src-tauri/js/launcher-init.js`) wraps `fetch` for
  same-origin `/api/` URLs and sends method, path and body to the `api`
  command, which returns status, headers and the exact body bytes.
- `window.webkit.messageHandlers.habibiNative.postMessage(msg)` is defined by
  the same script and forwarded to the `native_message` command, which runs on
  the main thread in the order the page posted. Messages a backend service
  owns (calendar access and events, reminders, contacts, the WhatsApp
  component) go to `Server::native_message`; the rest are handled in
  `src-tauri/src/bridge.rs`.
- Native-to-UI callbacks (`window.__habibi…?.(json)`) are delivered with
  `webview.eval`.
- The agent terminal uses `pty_start` / `pty_input` / `pty_resize` /
  `pty_close` plus a Tauri `Channel` for output. `terminal-controller.js`
  keeps the `{ type: 'data' | 'exit' | 'error' | 'started' }` messages.

Capability files (`src-tauri/capabilities/`) limit which window may call each
command, and every command also checks the calling webview's label. Only the
app's own launcher webview can reach `/api/*`, so there is no Host/Origin
check to maintain. The rules about *what* a request may do (approvals, path
allowlists, home-folder confinement, argument validation) are all enforced in
the services.

Provider-specific data is normalized in the owning service before it reaches
the UI, so swapping a transport is a service concern rather than a UI rewrite.

## Crates

| Crate | Owns |
|---|---|
| `habibi-core` | `ApiRequest`/`ApiResponse`, the `Routes` trait and `Router`, `ApprovalService`, `Paths`, and the cross-service traits |
| `habibi-platform` | Per-OS integration with no network: open, secrets, terminal launch, app discovery and icons, running apps, system actions, Quick Look/preview, named folders, contacts |
| `habibi-desktop` | Per-OS desktop helpers that don't need Tauri: clipboard history and images, teleprompter speech, the agent PTY, focus timer state, launcher-shortcut translation, the shell's preferences file |
| `habibi-local` | OS-facing routes (`/api/apps`, `/api/app-icon`, `/api/open-*`, `/api/browser/open`, `/api/system/action`, `/api/running-apps*`, `/api/preview-file`, `/api/quick-look`, `/api/agents*`), `/api/approvals`, the filename search index, `/api/files`, `/api/file`, `/api/search/*`, file investigation, recent files, notes, skill manifests (`/api/skills`), analytics, agent sessions |
| `habibi-agent` | LLM providers and `/api/llm/*`, the agent tool loop and tool policy, MCP (`/api/mcp/*`), `/api/agent/route`, imported agent skills (`/api/agent-skills*`) |
| `habibi-mail` | `/api/mail/*`: IMAP/SMTP accounts, Gmail/Zoho OAuth, parsing, attachments |
| `habibi-files` | `/api/file-tools/*` and in-process PDF, image, OCR and Trash work |
| `habibi-calendar` | Calendars, events and reminders behind one provider interface: EventKit on macOS, Google Calendar/Tasks and CalDAV everywhere |
| `habibi-integrations` | Kubernetes (`/api/kubernetes/*`), WhoDB (`/api/whodb/*`), WhatsApp (`/api/whatsapp/*`, `/api/openwa/*`) including supervising the OpenWA component |
| `habibi-server` | Builds every service and the `Router` in one place |
| `habibi-devserver` | Development and docs tooling only, never bundled: serves the UI and `/api/*` on loopback HTTP (with Host/Origin checks) so Playwright scripts can drive the UI in a plain browser |
| `src-tauri` (`habibi-app`) | Windows, menu-bar/tray icon, global shortcut, autostart, updater, single instance, IPC commands and the `habibi://` scheme, clipboard watch, notes export, teleprompter and focus overlays, permission flows |

Each service crate exposes a constructor and a `Routes` implementation, for
example `MailService::new(paths, approvals, recent, llm) -> Arc<MailService>`
with `impl Routes for MailService`. Constructor parameters are only what that
service needs. `Routes::handle` returns `None` for paths a group does not own,
and `habibi-server` registers groups so a more specific service always
answers its own prefix before the general local routes.

Service crates never depend on Tauri, so they are unit-testable on their own.

### Cross-service traits

When one service needs another it goes through a trait in
`habibi_core::services`, never the other crate:

- `Llm`: a plain completion from the configured model (mail, files, local
  routes, integrations). Implemented by `habibi-agent`.
- `McpHub` / `McpSession`: configured local MCP servers (WhoDB's custom MCP
  connection). Implemented by `habibi-agent`.
- `RecentFiles`: record something the user opened (mail attachments).
  Implemented by `habibi-local`.

Errors crossing these traits are `ServiceError` values whose message is safe
to show the user.

## Approvals

`habibi_core::ApprovalService` issues local, single-use approvals for a fixed
list of actions (`APPROVABLE_ACTIONS`: file-tools preview/apply/undo, browser
open, WhatsApp and mail sends, calendar create/update, reminder
create/complete, agent-skill execution, quitting apps, system actions). A
token is bound to one action and to the exact payload it was issued for,
expires after two minutes, and is spent on every attempt, matched or not.

The UI asks `/api/approvals` for a token after the user confirms. The route
that performs the write re-derives the payload from its own request body and
consumes the token against it, so a token minted for one request cannot
authorize another.

## Agent and MCP policy

`habibi-agent` owns model transport (OpenAI-compatible chat completions for
OpenAI, LM Studio and Ollama; Anthropic Messages; Gemini `generateContent`)
and a bounded tool loop. Every built-in and MCP tool call is evaluated in
`policy.rs` before execution. The decision is deterministic and ignores tool
annotations: a tool that describes itself as read-only still needs a real
single-use approval. MCP tool names are namespaced (`mcp__<server>__<tool>`)
to avoid collisions with built-in skills.

Personal app data is resolved locally. It is never added to model context
automatically; only explicitly chosen content is passed to the configured
provider.

## Imported Codex, Claude, and MCP capabilities

The Agent Dock can import capability metadata from local agent installations
without copying their credentials or instruction bodies into a shared
registry:

- Codex `SKILL.md` files from the current workspace and `~/.codex/skills/`;
- Claude Code `SKILL.md` files and Markdown commands from the current
  workspace and `~/.claude/`;
- project `.mcp.json`, Habibi's `.habibi/mcp-servers.json`, and local Claude
  MCP declarations.

Discovery is bounded to known agent folders. It never crawls the home
directory, sends configuration to a model, or returns MCP environment
variables to the UI. Agent instructions launch Codex or Claude Code only after
a single-use `agent-skill.execute` approval. MCP servers are connected only
when the user opens their review, and every tool call, reads included,
requires the same explicit approval. An append-only audit log
(`.habibi/imported-skill-audit.jsonl`) records the capability, action and
outcome, never prompt content, tool arguments, credentials or tool output.

## Platform behaviour

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Open file/URL/folder | `open` | ShellExecute | `xdg-open` |
| App search + icons | `.app` bundles, `.icns` | Start Menu `.lnk` + exe icon | `.desktop` files + icon theme |
| System actions | AppleScript/`CGSession` | `shutdown`, `LockWorkStation`, registry theme | `systemctl`, `loginctl`; dark mode via `gsettings` (GNOME) or `plasma-apply-colorscheme`/`lookandfeeltool` (KDE); app overview via GNOME Shell/Software, KDE launcher/Discover or `xfce4-appfinder` |
| Terminal launch | Terminal.app | Windows Terminal, else `cmd` | `$TERMINAL`, then common terminals |
| Secrets | Keychain | Credential Manager | Secret Service |
| Calendar/Reminders | EventKit, plus Google and CalDAV accounts | Google, CalDAV | Google, CalDAV |
| OCR | Vision | Windows.Media.Ocr | `tesseract` CLI if installed |
| Teleprompter voice following | SFSpeechRecognizer (on-device) | Windows.Media.SpeechRecognition | not available (timed scroll) |
| Quick Look | `qlmanage` | opens in default app | opens in default app |
| Contacts (WhatsApp name fallback) | Contacts | not available | not available |
| WhatsApp Desktop reading | Accessibility API | not available | not available |
| WhatsApp messaging | OpenWA component (Node), downloaded and signature-checked | component must be installed separately | component must be installed separately |
| Launch at login | `SMAppService` | autostart plugin | autostart plugin |
| Drag a file out to another app | not yet | not yet | not yet |

Unavailable features return `PlatformError::Unsupported` (or an equivalent
`unsupported_platform` reason) and the UI hides or explains them. Windows and
Linux builds are compile-checked and pass CI (`cargo clippy` and `cargo test`
on `windows-latest` and `ubuntu-latest`), but have not yet been run on real
Windows or Linux desktops.

## Local state

- `state_root` is `~/Library/Application Support/Habibi` on macOS (the same
  directory the Swift app used), `%APPDATA%\Habibi` on Windows and
  `~/.local/share/Habibi` on Linux. `HABIBI_DATA_ROOT` overrides it.
- Files live under `state_root/.habibi/` and `state_root/.openwa/` with the
  same names and JSON shapes the Node service used, and `0o700`/`0o600`
  permissions on Unix.
- Secrets go through `habibi_platform::secrets` with the service names
  `Habibi Mail`, `Habibi LLM Provider`, `Habibi WhoDB` and `Habibi Calendar`.
  On macOS these are the existing Keychain items; macOS may ask once to let
  the new app read an item the old app created.
- On first launch on macOS the shell imports the Swift app's `UserDefaults`
  (shortcut, menu bar and clipboard choices) into its preferences file.

## Adding a skill

1. Add `skills/<id>/manifest.json`. `habibi-local/src/skills.rs` defines the
   supported fields and kinds (`native`, `extension`, `local-service`,
   `oauth`) and validates every manifest at launch and in
   `pnpm run validate:manifests`.
2. Put the routes in the crate that owns the area, or a new service crate
   registered in `habibi-server`. Per-OS work goes in `habibi-platform`.
3. Keep `search`, `resolve` and `preview` paths separate from `execute`.
4. Declare any write action in `requiresConfirmation` and gate it with an
   approval action in `APPROVABLE_ACTIONS`.

A manifest grants no authority. No service may read another service's
credentials, mutate UI state, or make external writes outside an approved
execution path.

## Engineering rules

- **State on disk stays compatible.** Same file names and JSON shapes; new
  fields are additive.
- **Secrets** never appear in files, logs, process arguments or responses.
- **Writes need a fresh approval**, consumed against the payload re-derived
  from the request body. Writes should be idempotent where possible.
- **Errors** returned to the UI are fixed, user-safe strings. Never forward a
  provider error, an `io::Error` or a path the user didn't supply. Routes
  return `{ ok, ... }` envelopes.
- **Per-OS code** lives in `habibi-platform`, `habibi-desktop`,
  `habibi-files` or `src-tauri`, behind `cfg(target_os = ...)`. Those crates
  must keep passing `cargo check --target x86_64-pc-windows-msvc` and
  `--target x86_64-unknown-linux-gnu` from a Mac, so keep `reqwest`/TLS out of
  them. Other crates have no `cfg(target_os)` code.
- **Caches** may improve latency but cannot replace a validated provider
  response; stale snapshots are explicitly marked.
- **Manifests** fail closed: a malformed manifest never widens a skill's
  authority.
- **Dependencies**: check every new crate with deptrust first, avoid releases
  less than about three days old, and prefer pure-Rust crates. Shared
  versions live in the workspace `Cargo.toml`.
- **Tests**: security-boundary and parser fixes get a focused unit test in
  the owning crate. `cargo clippy --workspace --all-targets -- -D warnings`
  and `cargo test --workspace` must pass.
- In the app, loopback listeners exist only for OAuth redirects (mail on
  `127.0.0.1:4173` while a sign-in is pending, calendar and WhoDB on an
  ephemeral port) and close after the callback.
