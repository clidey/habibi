import { lexer } from 'marked';
import { notePreview as readablePreview } from '../../shared/note-preview.js';

export function notePreview(note) {
  return readablePreview(note, lexer);
}
