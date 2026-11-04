# Client architecture

Habibi's browser client is a small application, not a script. Its modules follow
the same separation that makes larger products maintainable. The shell and
shared controls render from the published Clidey UX React library; feature
controllers still own provider behavior and DOM event wiring.

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
- `ui/` contains provider-neutral presentation helpers. `ux/` mounts shared
  Clidey UX components and preserves the DOM contracts used by feature controllers.
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

The `ux/` entry point reexports focused modules for the shell, template control
upgrades, selectors, dialogs, indicators, and the teleprompter overlay. Add a
new control to its matching module. Shared parsing and static metadata belong in
`core/` and `data/`; feature directories must not import sibling features. The
module-size and dependency-boundary tests enforce these rules.
