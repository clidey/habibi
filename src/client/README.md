# Habibi client structure

`app.js` is the composition root: it owns DOM bootstrapping and wires feature
controllers together. New feature logic should not be added there.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for dependency rules, the standard
feature shape, and the staged migration away from the current monolith.

| Area                                           | Location                      |
| ---------------------------------------------- | ----------------------------- |
| Shared DOM helpers and safe formatting         | `core/`                       |
| Shared keyboard navigation policy              | `core/keyboard-controller.js` |
| Static launcher records                        | `data/`                       |
| Search and debounced local-files flow          | `features/search/`            |
| Kubernetes workspace and private runtime state | `features/kubernetes/`        |
| Calendar intent extraction                     | `features/calendar/`          |
| Model provider catalogue                       | `features/llm/`               |
| Reusable command-result component              | `ui/`                         |

Feature modules receive explicit DOM elements and callbacks instead of reaching
into global state. Connector data remains server-owned under `src/server/`;
browser UI code must not access credentials or provider secrets.
