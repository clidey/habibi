# Contributing

Use pnpm, Node 22+, and the Rust toolchain pinned in `Cargo.toml` (1.98), plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Run `pnpm run check` before opening a pull request. It runs the strict TypeScript check, a check that every source and client reference resolves, the JavaScript regression suite, and `cargo clippy --workspace --all-targets -- -D warnings` plus `cargo test --workspace` (which also validates every skill manifest). `pnpm run tauri:dev` (or `pnpm start`) builds the client bundles and runs the app; it uses your real data directory unless you set `HABIBI_DATA_ROOT`. `pnpm run tauri:build` builds an installable app for the current OS. Never commit local sessions, API keys, chat exports, `.habibi/`, or `.openwa/` data. Keep integrations local-first and add explicit confirmation for every external write.

Keep changes inside their boundary: browser rendering in `src/client/`, routes and domain logic in the service crate that owns the area under `crates/`, per-OS code in `habibi-platform`, `habibi-desktop`, `habibi-files` or `src-tauri` behind `cfg(target_os = ...)`, the desktop shell in `src-tauri/`, and manifests in `skills/`. [ARCHITECTURE.md](ARCHITECTURE.md) describes the crates and the rules they follow. Add a focused regression test in the owning crate (or `test/` for client code) for connector, cache, parser, or permission-boundary behaviour. Model untrusted provider data with `serde` types and validate it at runtime. If you change per-OS code, also run `cargo check` for `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`; CI runs the Rust checks on macOS, Windows, and Linux.

Documentation source lives in `docs/` and uses Dory. Run `pnpm run docs:check`
and `pnpm run docs:build` after changing pages, navigation, or documentation
assets. `pnpm run docs:dev` starts the local authoring preview. The site builds
into `docs/dist/`, separately from application output.
