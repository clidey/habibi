/** Browser-only fixtures layered over the sealed demo API, never the host API. */
export function installCaptureFixtures(emojiCatalog) {
  const now = '2026-11-05T12:00:00.000Z';
  const files = [
    {
      id: 'plan',
      name: 'Aurora launch plan.md',
      path: '/demo/Documents/Aurora launch plan.md',
      kind: 'file',
      size: 4200,
      pinned: true,
    },
    {
      id: 'design',
      name: 'Workspace sketches.pdf',
      path: '/demo/Documents/Workspace sketches.pdf',
      kind: 'file',
      size: 82000,
      pinned: false,
    },
    {
      id: 'project',
      name: 'Aurora',
      path: '/demo/Projects/Aurora',
      kind: 'folder',
      size: 0,
      pinned: false,
    },
  ].map((item) => ({ ...item, available: true, openedAt: now }));
  const responses = {
    '/api/notes': {
      ok: true,
      folders: [{ id: 'launch', name: 'Launch', parentId: null }],
      notes: [
        {
          id: 'launch-plan',
          title: 'A calmer launch',
          icon: 'file-text',
          body: '## Make room for the work that matters\n\nKeep the plan simple, the message clear, and the team connected.\n\n### This week\n\n- [x] Shape the first version\n- [ ] Gather a little feedback\n- [ ] Tell the launch story\n\n> Small steps, taken with care.\n\n### Useful context\n\nLink a page, a conversation, or a file when you need it. The writing stays in focus.',
          folderId: 'launch',
        },
        {
          id: 'ideas',
          title: 'Ideas for next week',
          icon: 'lightbulb',
          body: 'A few small improvements can make the whole day feel easier.',
          folderId: 'launch',
        },
        {
          id: 'story',
          title: 'The launch story',
          icon: 'file-text',
          body: 'A clear message starts with one useful idea.',
          folderId: null,
        },
      ].map((note) => ({
        ...note,
        emoji: '',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        revision: 1,
      })),
      noteOrder: ['launch-plan', 'ideas', 'story'],
    },
    '/assets/emoji-catalog.json': emojiCatalog,
    '/api/recent-files': { ok: true, items: files },
    '/api/agent-sessions': {
      ok: true,
      sessions: [
        {
          id: 'demo-codex',
          kind: 'codex',
          title: 'Build a calmer notes workspace',
          cwd: '/demo/Projects/Aurora',
          updatedAt: now,
        },
        {
          id: 'demo-claude',
          kind: 'claude',
          title: 'Review the launch checklist',
          cwd: '/demo/Projects/Aurora',
          updatedAt: now,
        },
        {
          id: 'demo-docs',
          kind: 'codex',
          title: 'Write the getting started guide',
          cwd: '/demo/Projects/Fieldnotes',
          updatedAt: now,
        },
      ],
    },
    '/api/agent-skills': {
      ok: true,
      skills: [
        {
          id: 'demo-review',
          source: 'codex',
          kind: 'skill',
          name: 'Review a change',
          description: 'Read the diff and prepare a focused review.',
        },
        {
          id: 'demo-docs',
          source: 'claude',
          kind: 'command',
          name: 'Draft release notes',
          description: 'Turn completed work into clear release notes.',
        },
        {
          id: 'demo-mcp',
          source: 'mcp',
          kind: 'mcp-server',
          name: 'Project knowledge',
          description: 'Look up the team’s fictional project reference.',
        },
      ],
    },
    '/api/kubernetes/overview': {
      ok: true,
      context: 'aurora-staging',
      contexts: ['aurora-staging', 'aurora-development'],
      namespace: '',
      namespaces: ['default', 'web', 'workers'],
      resources: [
        {
          kind: 'pods',
          ok: true,
          items: [
            {
              name: 'web-6c48b9-demo',
              namespace: 'web',
              primary: 'Running',
              secondary: '1/1 ready · 0 restarts',
              badge: 'Healthy',
            },
            {
              name: 'api-7d56c2-demo',
              namespace: 'web',
              primary: 'Running',
              secondary: '1/1 ready · 0 restarts',
              badge: 'Healthy',
            },
            {
              name: 'queue-5f92a1-demo',
              namespace: 'workers',
              primary: 'Running',
              secondary: '1/1 ready · 0 restarts',
              badge: 'Healthy',
            },
          ],
        },
        {
          kind: 'deployments',
          ok: true,
          items: [
            {
              name: 'web',
              namespace: 'web',
              primary: '2/2 ready',
              secondary: '2 available',
              badge: 'Available',
            },
            {
              name: 'api',
              namespace: 'web',
              primary: '2/2 ready',
              secondary: '2 available',
              badge: 'Available',
            },
          ],
        },
        {
          kind: 'services',
          ok: true,
          items: [
            { name: 'web', namespace: 'web', primary: 'ClusterIP', secondary: 'Port 8080' },
            { name: 'api', namespace: 'web', primary: 'ClusterIP', secondary: 'Port 3000' },
          ],
        },
      ],
    },
  };
  const sealedFetch = window.fetch;
  window.fetch = (resource, options = {}) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, location.origin);
    const method = options.method || resource.method || 'GET';
    if (url.origin === location.origin && method === 'GET' && responses[url.pathname]) {
      return Promise.resolve(
        new Response(JSON.stringify(responses[url.pathname]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return sealedFetch(resource, options);
  };
  const clipboard = {
    ok: true,
    enabled: true,
    items: [
      {
        id: 'launch',
        kind: 'text',
        name: 'A clear launch starts with one small step.',
        text: 'A clear launch starts with one small step.',
        source: 'Notes',
        pinned: true,
      },
      {
        id: 'link',
        kind: 'text',
        name: 'https://example.test/aurora',
        text: 'https://example.test/aurora',
        source: 'Browser',
        pinned: false,
      },
      {
        id: 'agenda',
        kind: 'text',
        name: 'Demo agenda: design review, feedback, next steps.',
        text: 'Demo agenda: design review, feedback, next steps.',
        source: 'Mail',
        pinned: false,
      },
    ].map((item) => ({ ...item, createdAt: now })),
  };
  const reminders = {
    ok: true,
    access: true,
    defaultList: 'work',
    lists: [
      { id: 'work', name: 'Work' },
      { id: 'personal', name: 'Personal' },
    ],
    items: [
      {
        id: 'review',
        title: 'Review the Aurora launch checklist',
        list: 'Work',
        due: '2026-11-06T10:00:00.000Z',
        completed: false,
      },
      {
        id: 'feedback',
        title: 'Send feedback on the new workspace',
        list: 'Work',
        due: '2026-11-06T14:00:00.000Z',
        completed: false,
      },
      {
        id: 'walk',
        title: 'Make time for an afternoon walk',
        list: 'Personal',
        due: null,
        completed: false,
      },
    ],
  };
  const focus = {
    ok: true,
    state: 'idle',
    duration: 1500,
    remaining: 1500,
    label: 'Focus',
    visible: false,
  };
  // This is a fake bridge in an isolated browser, never the native app bridge.
  window.webkit = {
    messageHandlers: {
      habibiNative: {
        postMessage(message) {
          if (message.type !== 'dailyUtility') return;
          let result = {
            ok: false,
            error: 'This action is unavailable in documentation captures.',
          };
          if (message.action === 'clipboard.state') result = clipboard;
          if (message.action === 'reminders.state') result = reminders;
          if (message.action === 'focus') {
            if (message.value?.action === 'start')
              Object.assign(focus, {
                state: 'running',
                remaining: message.value.seconds,
                duration: message.value.seconds,
                label: message.value.label,
                visible: true,
              });
            result = focus;
          }
          queueMicrotask(() =>
            window.__habibiDailyResult?.({ ...result, requestId: message.requestId }),
          );
        },
      },
    },
  };
}
