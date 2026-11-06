import { lexer } from 'marked';
import { notePreview as readablePreview } from '../../../core/note-preview.js';

export function notePreview(note) {
  return readablePreview(note, lexer);
}
