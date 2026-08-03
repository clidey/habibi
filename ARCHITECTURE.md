# Architecture

Habibi is split into explicit boundaries:

- `src/core/` owns typed skill discovery, single-use approval contracts, loopback security, and command planning.
- `src/connectors/` owns one provider transport at a time; connectors never reach into UI state.
- `src/server/services/` owns domain behaviour and its local state. `whatsapp-service.js`, for example, owns OpenWA session lifecycle, recents validation, local contact fallback, avatar enrichment, and message transport.
- `src/agent/` owns the Pi-backed agent harness, deterministic tool policy, and MCP-to-skill naming. Pi provides the model/tool loop; Habibi remains the authority for privacy, identities, approvals, and all side effects.
- `server.js` is the deliberately thin process host: HTTP/WebSocket bootstrap, static assets, and non-domain OS routes only. Its loopback security boundary rejects non-local Host/Origin values before routing.
- `src/client/core/` contains browser modules with no provider credentials or side effects. Feature renderers progressively move beside it rather than accumulating in the launcher entry point.
- `skills/<id>/manifest.json` declares commands and least-privilege permissions.
- The launcher UI renders results and asks for approval; it never stores provider keys or performs unapproved side effects.

## Request flow

```
Launcher UI → local HTTP route → domain service → connector → local provider
                                  ↓
                         validated local cache/snapshot
```

Provider-specific data must be normalized in the domain service before it reaches the UI. This makes connector swaps (for example, Baileys ↔ WhatsApp Web) a service concern rather than a UI rewrite.

## Agent and MCP policy

`@earendil-works/pi-ai` is the multi-provider transport and `@earendil-works/pi-agent-core` drives agent turns. They do not grant permissions. Habibi evaluates every built-in and MCP tool call in `src/agent/harness-policy.js` before execution:

- reads and local draft preparation may run;
- sends, creates, updates, deletes, schedules, archives, and writes require an approval token minted by the UI;
- MCP tool names are namespaced (`mcp__<server>__<tool>`) before registration, avoiding collisions with built-in skills.

Personal app data is resolved locally. It is never added to LLM context automatically; only explicitly chosen content can be passed to the configured provider.

## Imported Codex, Claude, and MCP capabilities

The Agent Dock can import capability metadata from local agent installations without copying their credentials or instruction bodies into a shared registry:

- Codex `SKILL.md` files from the current workspace and `~/.codex/skills/`;
- Claude Code `SKILL.md` files and Markdown commands from the current workspace and `~/.claude/`;
- project `.mcp.json`, Habibi MCP configuration, and local Claude MCP declarations.

Discovery is bounded to known agent folders. It never crawls the home directory, sends configuration to a model, or returns MCP environment variables to the UI. Selecting an imported capability opens a review surface. Agent instructions launch Codex or Claude Code only after a single-use `agent-skill.execute` approval. MCP servers are connected only when the user opens their review, and every tool call—including reads—requires the same explicit approval. A local append-only audit log records the capability ID, action and outcome, but never prompt content, tool arguments, credentials, or tool output.

The Node host is intentionally replaceable by Tauri/Rust without changing skill manifests, domain contracts, or UI-facing API payloads.

## Adding a skill

1. Add `skills/<id>/manifest.json`, matching the typed `SkillManifest` contract in `src/contracts/skill.ts`.
2. Add one connector under `src/connectors/`.
3. Expose `search`, `resolve`, `preview`, and `execute` methods.
4. Declare any write action in `requiresConfirmation`.

No connector may read another connector's credentials, mutate global UI state, or make external writes outside `execute`.

## Engineering rules

- Every bug fix at a provider boundary gets a focused `node:test` regression test.
- Routes return JSON envelopes (`{ ok, ... }`) and never leak provider keys or raw thrown errors.
- Caches may improve latency but cannot replace a validated provider response; stale snapshots are explicitly marked.
- New writes must be idempotent where possible and always require an explicit UI confirmation.
- Runtime data belongs in ignored local state (`.habibi/`, `.openwa/`), never in source control.
- Every manifest is runtime-validated at launch and in CI. A malformed manifest fails closed rather than silently widening a skill's authority.
- The loopback service must never bind to a network interface or relax its Host/Origin validation. It is a desktop companion, not a multi-user server.
