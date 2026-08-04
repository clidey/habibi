# Repository Guidelines

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

## Build, Test, and Development Commands

Use Node.js 22+ and the lockfile's package manager, pnpm.

```sh
pnpm install                 # install dependencies
pnpm run build               # compile JS/TS into dist/
pnpm run typecheck           # strict TypeScript check for src/**/*.ts
pnpm test                    # build, then run node:test regressions
pnpm run validate:manifests  # build and validate every skill manifest
pnpm run check               # typecheck, manifest validation, and tests
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
