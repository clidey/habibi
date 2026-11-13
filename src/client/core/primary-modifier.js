// The platform's command modifier: ⌘ on macOS, Ctrl on Windows and Linux.
import { onMac } from './platform-copy.js';

export { onMac };
export const primaryModifier = (event) => (onMac() ? event.metaKey : event.ctrlKey);
// The keyboard hint for "submit with the command modifier".
export const primaryEnterLabel = () => (onMac() ? '⌘ ↵' : 'Ctrl ↵');
