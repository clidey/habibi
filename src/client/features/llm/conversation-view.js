import { renderAssistantMarkdown } from '../../core/query.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

/** Creates the message renderer for one ephemeral conversation. */
export function createConversationView({ messages, notify, onTurn }) {
  function addTurn(role, text, attachments = []) {
    const turn = document.createElement('div');
    const body = document.createElement('div');
    const time = document.createElement('time');
    turn.className = `message ${role === 'user' ? 'outgoing' : 'incoming'}`;
    body.className = 'message-body';
    if (role === 'assistant') setHtml(body, renderAssistantMarkdown(text));
    else body.textContent = text;
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    turn.append(body);
    if (attachments.length) {
      const tags = document.createElement('div');
      tags.className = 'message-attachment-tags';
      setHtml(
        tags,
        attachments
          .map(
            (attachment) =>
              `<span>${/^image\//.test(attachment.mime || '') ? icon('image') : icon(attachment.mime === 'text/plain' ? 'file-text' : 'paperclip')} ${escapeHtml(attachment.name)}</span>`,
          )
          .join(''),
      );
      turn.append(tags);
    }
    turn.append(time);
    if (role === 'assistant') {
      const copy = document.createElement('button');
      copy.className = 'copy-message';
      copy.type = 'button';
      copy.title = 'Copy response';
      copy.setAttribute('aria-label', 'Copy response to clipboard');
      setHtml(copy, `${icon('copy')}<span>Copy</span>`);
      copy.onclick = async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
          else {
            const temporary = document.createElement('textarea');
            temporary.value = text;
            temporary.style.position = 'fixed';
            temporary.style.opacity = '0';
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand('copy');
            temporary.remove();
            if (!copied) throw new Error('Copy failed');
          }
          copy.querySelector('span').textContent = 'Copied';
          setTimeout(() => {
            if (copy.isConnected) copy.querySelector('span').textContent = 'Copy';
          }, 1500);
        } catch (_) {
          notify('Could not copy that response');
        }
      };
      turn.append(copy);
    }
    messages.append(turn);
    messages.scrollTop = messages.scrollHeight;
    onTurn(role, text);
    refreshIcons();
  }
  return { addTurn };
}
