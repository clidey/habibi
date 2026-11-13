# Repository Guidelines

## Team Rules

These apply in every clidey repository, for people and agents alike.

- **Commits:** ask once before the first commit. Once the user says yes, keep committing that work without asking again; push only when they've asked for it.
- **No AI attribution, anywhere:** commits, PRs, issues, comments and releases carry no `Co-Authored-By:` for Claude, Codex or any other agent, and no "Generated with" lines.
- **Never, whatever the instruction:** publish packages or releases, push images, deploy to UAT or production, or run anything against production. Build images and run build scripts only locally, to test. Prepare the command and hand it to the user.
- **Cluster and cloud commands:** read-only `kubectl`, `helm` and `gcloud` commands run without asking (never against production). Anything that writes, deletes or shows secret values, and anything that writes to a WhoDB organisation: show the exact command and wait for a yes.
- **Untracked files:** ask before deleting untracked or gitignored files; they often hold secrets or local state.
- **pnpm only:** never npm, npx, yarn or bun.
- **Stay in the workspace:** use only the clones in the workspace; never read or run checkouts elsewhere, such as old ones in `~/Documents`.
- **The machine:** don't keep it awake or change power settings (`caffeinate`, `pmset`); recommend it to the user instead.
- **Agent replies:** lead with the answer or result. No preamble, no restating the question, no recap unless asked. Keep it short and explain only what isn't obvious; if you need something from the user, ask in one line.
- **Clarify first:** before starting, ask about anything where a different answer would change the work: scope, behaviour, which repo or environment, or anything hard to undo. Ask all your questions at once, then wait. Don't ask what the code or docs already answer; for small choices that are easy to change later, pick one and say which in your reply.

## Project Structure & Module Organization

Habibi is a local-first macOS command center. The Swift/AppKit launcher and
native adapters live in `native/`. The Node host is intentionally thin:
`server.js` bootstraps HTTP/WebSocket handling, while `src/` owns application
logic. Keep public TypeScript contracts in `src/contracts/`, approval and
loopback-security code in `src/core/`, provider transports in
`src/connectors/`, and normalized domain behaviour in
`src/server/services/`. Agent and MCP integrations belong in `src/agent/`.

Browser UI modules are under `src/client/`; add feature-specific code beside
`features/`, not to the `app.js` composition root. Built-in capabilities are
declared in `skills/<id>/manifest.json`. Regression tests live in `test/` and
compile into `dist/test/`.

Use the published `@clidey/ux` package for browser UI controls and design
tokens. Do not recreate a UX component with Habibi-specific DOM/CSS when the
library provides it. The shell and workspace controls share the built UX
runtime; keep unrelated heavy features lazy. Use named icons or `CatalogIcon`
from `@clidey/ux`; template icons are hydrated by the shared UX runtime. Do not
add local SVG artwork or another icon package for interface controls. WhatsApp
uses the explicitly approved brand outline in `assets/icons/whatsapp.svg`. The macOS status item and window
placement remain AppKit hooks; visible launcher and teleprompter controls render
through WebKit with Clidey UX.

## Build, Test, and Development Commands

Use Node.js 22+ (`.nvmrc`) and pnpm, never npm or yarn.

```sh
pnpm install                 # install dependencies
pnpm run build               # compile JS/TS into dist/
pnpm run typecheck           # strict TypeScript check for src/**/*.ts
pnpm test                    # build, then run node:test regressions
pnpm run validate:manifests  # build and validate every skill manifest
pnpm run check               # typecheck, reference check, manifest validation, and tests
pnpm start                   # build and run the loopback service
native/build-app.sh          # build the local macOS launcher
```

Run `pnpm run check` before submitting a change.

## Coding Style & Naming Conventions

Follow the existing two-space JavaScript/TypeScript indentation and semicolon
style. Use lowercase, hyphenated filenames such as `approval-service.ts` and
place focused tests at `test/<area>.test.js`. Keep TypeScript strict: model
untrusted provider input with contracts and validate it at runtime. Routes
return `{ ok, ... }` envelopes and must not expose credentials or raw errors.

## Testing and Safety Boundaries

Use the built-in `node:test` framework. Add a focused regression test for
connector, parser, cache, permission, or security-boundary fixes. External
writes belong only in explicit execution paths and require a fresh approval;
reads and preview preparation must remain separate. Preserve loopback-only
Host/Origin protections. Never commit `.habibi/`, `.openwa/`, API keys, mail
credentials, chat exports, or private screenshots.

## Commits and Pull Requests

Recent commits use short, imperative summaries (for example, `add pnpm-lock.yaml file`). Keep each commit scoped to one concern. Pull requests should explain the behavioural change, identify affected skill/provider boundaries, link the issue when applicable, include UI screenshots for visual changes, and state the command results from `pnpm run check`.
