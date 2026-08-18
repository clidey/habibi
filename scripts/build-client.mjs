import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// The launcher UI is one ES module graph rooted at app.js. Bundling it lets the
// client import real npm packages (escaping, sanitizing) instead of carrying
// hand-written copies, and means the browser no longer fetches the source tree.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'assets', 'vendor');

// The browser needs four files from packages that are otherwise build-time
// dependencies. Copy only those artifacts into the generated client assets so
// production packaging does not carry the packages' sources, maps, types and
// unused icon modules in node_modules.
const vendorFiles = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm-fit.js'],
];

await fs.rm(vendorRoot, { recursive: true, force: true });
await fs.mkdir(vendorRoot, { recursive: true });
await Promise.all(
  vendorFiles.map(([source, target]) =>
    fs.copyFile(path.join(root, 'node_modules', source), path.join(vendorRoot, target)),
  ),
);

// The stock Lucide UMD file contains the entire icon catalog (~350 KB). Habibi
// uses a fixed subset, so generate the same small `window.lucide.createIcons`
// surface from direct icon modules and let esbuild tree-shake everything else.
const lucideIcons = [
  ['Activity', 'activity'],
  ['ArrowLeft', 'arrow-left'],
  ['ArrowRight', 'arrow-right'],
  ['ArrowUpRight', 'arrow-up-right'],
  ['Bot', 'bot'],
  ['Boxes', 'boxes'],
  ['Braces', 'braces'],
  ['CalendarCheck', 'calendar-check'],
  ['CalendarClock', 'calendar-clock'],
  ['CalendarDays', 'calendar-days'],
  ['ChartNoAxesCombined', 'chart-no-axes-combined'],
  ['Check', 'check'],
  ['ChevronDown', 'chevron-down'],
  ['ChevronRight', 'chevron-right'],
  ['ChevronsUpDown', 'chevrons-up-down'],
  ['CircleStop', 'circle-stop'],
  ['Copy', 'copy'],
  ['Download', 'download'],
  ['FileIcon', 'file'],
  ['FileText', 'file-text'],
  ['Folder', 'folder'],
  ['FolderOpen', 'folder-open'],
  ['Forward', 'forward'],
  ['Image', 'image'],
  ['Inbox', 'inbox'],
  ['Keyboard', 'keyboard'],
  ['Lightbulb', 'lightbulb'],
  ['LockKeyhole', 'lock-keyhole'],
  ['Mail', 'mail'],
  ['MessageCircleMore', 'message-circle-more'],
  ['Mic', 'mic'],
  ['Monitor', 'monitor'],
  ['Moon', 'moon'],
  ['OctagonX', 'octagon-x'],
  ['PanelTop', 'panel-top'],
  ['PanelTopClose', 'panel-top-close'],
  ['Paperclip', 'paperclip'],
  ['Pause', 'pause'],
  ['PlugZap', 'plug-zap'],
  ['Power', 'power'],
  ['Radio', 'radio'],
  ['RefreshCw', 'refresh-cw'],
  ['Rocket', 'rocket'],
  ['RotateCw', 'rotate-cw'],
  ['Route', 'route'],
  ['ScanSearch', 'scan-search'],
  ['ScrollText', 'scroll-text'],
  ['Search', 'search'],
  ['Settings', 'settings'],
  ['Settings2', 'settings-2'],
  ['SlidersHorizontal', 'sliders-horizontal'],
  ['ShieldCheck', 'shield-check'],
  ['ShipWheel', 'ship-wheel'],
  ['Sparkles', 'sparkles'],
  ['Sun', 'sun'],
  ['SunMoon', 'sun-moon'],
  ['TerminalSquare', 'square-terminal'],
  ['Trash2', 'trash-2'],
  ['Video', 'video'],
  ['X', 'x'],
];
const lucideImports = lucideIcons
  .map(([binding, file]) => `import ${binding} from 'lucide/dist/esm/icons/${file}.js';`)
  .join('\n');
const lucideMap = lucideIcons
  .map(([binding]) => `${binding === 'FileIcon' ? 'File' : binding}:${binding}`)
  .join(',');
await esbuild.build({
  stdin: {
    contents: `
      import replaceElement from 'lucide/dist/esm/replaceElement.js';
      ${lucideImports}
      const icons = { ${lucideMap} };
      window.lucide = { createIcons({ nameAttr='data-lucide', attrs={} } = {}) {
        document.querySelectorAll('[' + nameAttr + ']').forEach(element => replaceElement(element, { nameAttr, icons, attrs }));
      } };
    `,
    resolveDir: root,
    sourcefile: 'habibi-lucide.js',
  },
  outfile: path.join(vendorRoot, 'lucide.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari17'],
  legalComments: 'eof',
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(root, 'app.js')],
  outfile: path.join(root, 'assets', 'app.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});
