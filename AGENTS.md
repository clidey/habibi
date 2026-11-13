# Repository Guidelines

## Team Rules

These apply in every clidey repository, for people and agents alike.

- **Commits:** ask once before the first commit. Once the user says yes, keep committing that work without asking again; push only when they've asked for it.
- **No AI attribution, anywhere:** commits, PRs, issues, comments and releases carry no `Co-Authored-By:` for Claude, Codex or any other agent, and no "Generated with" lines.
- **Never, whatever the instruction:** publish packages or releases, push images, deploy to UAT or production, or run anything against production. Build images and run build scripts only locally, to test. Prepare the command and hand it to the user.
- **Cluster and cloud commands:** read-only `kubectl`, `helm` and `gcloud` commands run without asking, and in UAT so do day-to-day operations: restarting a rollout, deleting pods, config maps and jobs, scaling, `exec`, `cp` and port-forwarding. Never anything against production. Anything else that writes, deletes or shows secret values (including `apply`, `patch`, `set` and rollbacks), and anything that writes to a WhoDB organisation: show the exact command and wait for a yes.
- **Branches and worktrees:** never create a branch or worktree, or switch branches, unless the user asked. If the work seems to need one, ask first; this is a required question.
- **Untracked files:** ask before deleting untracked or gitignored files; they often hold secrets or local state.
- **pnpm only:** never npm, npx, yarn or bun.
- **Stay in the workspace:** use only the clones in the workspace; never read or run checkouts elsewhere, such as old ones in `~/Documents`.
- **The machine:** don't keep it awake or change power settings (`caffeinate`, `pmset`); recommend it to the user instead.
- **Agent replies:** lead with the answer or result. No preamble, no restating the question, no recap unless asked. Keep it short and explain only what isn't obvious; if you need something from the user, ask in one line.
- **Clarify first:** before starting, ask about anything where a different answer would change the work: scope, behaviour, which repo or environment, or anything hard to undo. Ask all your questions at once, then wait. Don't ask what the code or docs already answer; for small choices that are easy to change later, pick one and say which in your reply.

## Project Structure & Module Organization

Habibi is a local-first command center for macOS, Windows and Linux: a Rust
backend in a Tauri v2 shell with a browser UI in the system webview. The UI
calls `/api/*` routes as before, but `fetch` is routed into Rust over Tauri
IPC; there is no HTTP server or Node host. Read `ARCHITECTURE.md` for the
request flow, approvals and the per-OS feature table.

Where things go:

- `crates/habibi-core/`: the `ApiRequest`/`ApiResponse`/`Routes`/`Router`
  contract, approvals, `Paths`, and the cross-service traits (`Llm`,
  `McpHub`, `RecentFiles`). Services reach each other only through these.
- `crates/habibi-platform/`: everything that differs per OS without
  networking (open, secrets, terminal launch, apps and icons, running apps,
  system actions, previews, named folders, contacts).
- `crates/habibi-desktop/`: per-OS desktop helpers the shell uses that don't
  need Tauri (clipboard, teleprompter speech, PTY, focus timer, shortcut
  translation, preferences).
- `crates/habibi-local/`: OS-facing routes, search index, files, recent
  files, notes, skill manifests, approvals route, analytics, agent sessions.
- `crates/habibi-agent/`: model providers, agent loop and tool policy, MCP,
  imported agent skills.
- `crates/habibi-mail/`, `crates/habibi-files/`, `crates/habibi-calendar/`,
  `crates/habibi-integrations/` (Kubernetes, WhoDB, WhatsApp/OpenWA): one
  service area each.
- `crates/habibi-server/`: builds every service and the `Router`. Register a
  new service here.
- `crates/habibi-devserver/`: a loopback HTTP host for UI checks and demo
  screenshots in a plain browser. Development only; never bundled, and keep
  its Host/Origin checks.
- `src-tauri/`: the shell (windows, tray, global shortcut, IPC commands, the
  `habibi://` scheme, overlays, autostart, updater). Keep domain logic out of
  it.
- `native/`: the OpenWA supervisor and WhatsApp component packaging scripts
  that remain from the macOS app.

Per-OS code belongs only in `habibi-platform`, `habibi-desktop`,
`habibi-files` or `src-tauri`, behind `cfg(target_os = ...)`; other crates
have none. Unsupported features return `PlatformError::Unsupported` and the
UI hides them.

Browser UI modules are under `src/client/`; add feature-specific code beside
`features/`, not to the `app.js` composition root. Shared client TypeScript
lives in `src/client/shared/`. Built-in capabilities are declared in
`skills/<id>/manifest.json`. JS regression tests live in `test/` and compile
into `dist/test/`; Rust tests live in the owning crate.

Use the published `@clidey/ux` package for browser UI controls and design
tokens. Do not recreate a UX component with Habibi-specific DOM/CSS when the
library provides it. The shell and workspace controls share the built UX
runtime; keep unrelated heavy features lazy. Use named icons or `CatalogIcon`
from `@clidey/ux`; template icons are hydrated by the shared UX runtime. Do not
add local SVG artwork or another icon package for interface controls. WhatsApp
uses the explicitly approved brand outline in `assets/icons/whatsapp.svg`. The
tray icon and window placement stay in `src-tauri`; visible launcher and
teleprompter controls render in the webview with Clidey UX.

## Build, Test, and Development Commands

Use Node.js 22+ (`.nvmrc`) and pnpm, never npm or yarn, plus the Rust
toolchain pinned in `Cargo.toml` (`rust-version = "1.98"`). Linux also needs
the WebKitGTK 4.1 development packages listed in
`.github/workflows/quality.yml`.

```sh
pnpm install                 # install dependencies
pnpm run build:client        # build the browser bundles the shell serves
pnpm run tauri:dev           # run the app (pnpm start does the same)
pnpm run build               # compile JS/TS into dist/ and build the client
pnpm run typecheck           # strict TypeScript check for src/**/*.ts
pnpm test                    # build, then run node:test regressions
pnpm run check:rust          # cargo clippy -D warnings + cargo test, whole workspace
pnpm run validate:manifests  # cargo test for every skill manifest
pnpm run check               # typecheck, reference check, JS tests, check:rust
pnpm run tauri:build         # build the installable app for this OS
pnpm run docs:check          # docs links, navigation, assets and MDX
```

`tauri:dev` uses your real data directory unless `HABIBI_DATA_ROOT` points
elsewhere. Run `pnpm run check` before submitting a change. For per-OS code,
also run `cargo check -p <crate> --target x86_64-pc-windows-msvc` and
`--target x86_64-unknown-linux-gnu` (CI runs clippy and tests on all three
OSes, and `.github/workflows/app.yml` builds, installs and launches the real
app on each, uploading screenshots for review).

## Coding Style & Naming Conventions

JavaScript/TypeScript: follow the existing two-space indentation and
semicolon style. Use lowercase, hyphenated filenames such as
`calendar-accounts.js` and place focused tests at `test/<area>.test.js`.

Rust: edition 2024, shared dependency versions in the workspace
`Cargo.toml` (`{ workspace = true }`). There is no `rustfmt.toml`; follow the
surrounding formatting rather than reformatting whole files. Clippy runs with
`-D warnings`. Model untrusted input with `serde` types and validate it in
the route. Routes return `{ ok, ... }` envelopes with fixed, user-safe error
strings; never forward a provider error, an `io::Error` or a path the user
didn't supply. Keep `reqwest`/TLS out of the per-OS crates. Check every new
crate or npm package with deptrust first and avoid releases less than about
three days old.

## Testing and Safety Boundaries

Rust tests are ordinary `#[test]`/`#[tokio::test]` unit tests in the owning
crate; JS tests use the built-in `node:test` framework. Add a focused
regression test for connector, parser, cache, permission, or security-boundary
fixes. Tests must not touch the network, the credential store or a terminal;
use the injectable backends (for example `habibi_agent::Backends`).

External writes belong only in explicit execution paths and require a fresh
approval from `ApprovalService`, consumed against the payload re-derived from
the request body; reads and preview preparation must remain separate. Only
the launcher webview may call the `api` and `native_message` commands; keep
the capability files and label checks in `src-tauri` tight, and keep the
`habibi://` static-file allowlist explicit. State on disk keeps its file
names and JSON shapes. Secrets go through `habibi_platform::secrets` and never
appear in files, logs, process arguments or responses. Never commit
`.habibi/`, `.openwa/`, API keys, mail credentials, chat exports, or private
screenshots.

## Commits and Pull Requests

Recent commits use short, imperative summaries (for example, `add pnpm-lock.yaml file`). Keep each commit scoped to one concern. Pull requests should explain the behavioural change, identify affected skill/provider boundaries, link the issue when applicable, include UI screenshots for visual changes, and state the command results from `pnpm run check`.
