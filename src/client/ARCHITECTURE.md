# Client architecture

Habibi's browser client is a small application, not a script. Its modules follow
the same separation that makes larger products maintainable while keeping the
runtime framework-free.

## Dependency direction

```text
app.js (composition only)
  -> features/<feature>/*-feature.js
       -> ui/ and core/
       -> loopback HTTP APIs
  -> data/ (static catalogues)
```

- `app.js` owns bootstrapping, shell-level navigation, and feature wiring. It
  must not own provider workflows, feature markup, or feature state.
- `features/<feature>/` owns one user capability end to end. Its controller
  receives shell DOM nodes and navigation callbacks explicitly, keeps transient
  state private, and exposes a small operation surface.
- `ui/` contains reusable presentation components with no provider knowledge.
- `core/` contains stateless cross-cutting policy such as safe DOM rendering,
  keyboard behavior, analytics, error presentation, and formatting.
- Provider credentials and normalization remain server-side. Client features
  call loopback APIs and never import connectors.

Features do not import other features. Cross-feature navigation goes through a
callback supplied by the composition root. Shared behavior moves down into
`core/` or `ui/`; it is not copied sideways between features.

## Feature shape

Start with one controller file. Split only when a second responsibility is
clear:

```text
features/whatsapp/
  whatsapp-feature.js   # public controller and orchestration
  whatsapp-api.js       # transport, when calls become substantial
  whatsapp-view.js      # markup/binding, when rendering becomes substantial
  whatsapp-model.js     # pure normalization/state transitions, when needed
```

Controllers expose verbs meaningful to the shell, for example `{ show, reset }`
or `{ show, runQuery, stop }`. They do not expose internal state or individual
render helpers.

## Migration order

Extract along cohesive runtime boundaries, keeping behavior unchanged and tests
green after each move:

1. Kubernetes workspace (complete)
2. Agent Dock and interactive terminal lifecycle
3. Settings, appearance, and native preferences
4. Calendar and proactive-home data
5. Mail inbox/thread/compose flows
6. WhatsApp discovery, setup, chats, and composer
7. AI setup/chat/action routing
8. Home shell and remaining composition cleanup

Each extraction must remove the old implementation from `app.js`, add a focused
controller test, and preserve the built-bundle smoke test. The end state is a
small composition root whose size changes only when top-level capabilities are
added or removed.
