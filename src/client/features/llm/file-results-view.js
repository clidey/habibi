import { createResultButton } from '../../ui/result-button.js';
import { icon } from '../../core/view-helpers.js';

const fileButton = createResultButton({ icon, chatTime: () => '', iconNames: { files: 'file-text' } });

/** Use the launcher's file rows inside Ask, with the same typography and actions. */
export function fileResultsMarkup(files) {
  return `<div class="result-header"><b>Local files</b><span>${files.length} match${files.length === 1 ? '' : 'es'}</span></div><div class="result-list">${files.map((file, index) => fileButton({
    icon: 'files', title: file.name, meta: [file.folder, file.directory].filter(Boolean).join(' · '),
    tag: 'FILE', type: 'file', path: file.path,
  }, index + 1)).join('')}</div>`;
}
