# Contributing

Use Node 22+ and run `npm run check` before opening a pull request. It runs the strict TypeScript contract check, validates every skill manifest, and executes the regression suite. `npm start` always compiles the production artifact before starting it. Never commit local sessions, API keys, chat exports, `.habibi/`, or `.openwa/` data. Keep integrations local-first and add explicit confirmation for every external write.

Keep changes inside their boundary: browser rendering in `src/client/`, domain logic in `src/server/services/`, provider transport in `src/connectors/`, and manifests in `skills/`. Add a focused regression test for connector, cache, parser, or permission-boundary behaviour. New public domain contracts belong in `src/contracts/` as strict TypeScript and must validate untrusted provider data at runtime.
