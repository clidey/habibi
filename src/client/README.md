# Habibi client structure

`app.js` is the composition root: it boots the Clidey UX shell and wires feature
controllers together. New feature logic should not be added there.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for dependency rules and the standard
feature shape.

| Area                                            | Location                      |
| ----------------------------------------------- | ----------------------------- |
| Shared DOM helpers and safe formatting          | `core/`                       |
| Shared keyboard navigation policy               | `core/keyboard-controller.js` |
| Static launcher records                         | `data/`                       |
| Search and debounced local-files flow           | `features/search/`            |
| Kubernetes workspace and private runtime state  | `features/kubernetes/`        |
| Shared calendar intent parsing                  | `core/calendar-intent.js`     |
| Shared model provider catalogue                 | `data/llm-providers.js`       |
| Reusable command-result component               | `ui/`                         |
| Clidey UX shell, controls, dialogs, and overlay | `ux/`                         |

Feature modules receive explicit DOM elements and callbacks instead of reaching
into global state. Connector data remains server-owned under `src/server/`;
browser UI code must not access credentials or provider secrets.
