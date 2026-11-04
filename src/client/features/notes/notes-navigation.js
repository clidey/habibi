/** Opening a note reference reuses each app's existing read/view path. */
export function createNotesNavigation({ mail, whatsapp, calendar, whodb, emoji, teleprompter, aiChat, requestApproval, notify, onWhatsApp, previewFile }) {
  return async function openReference(ref, label) {
    if (ref.type === 'mail') return mail.showThread(ref.threadId, ref.accountId);
    if (ref.type === 'whatsapp') { onWhatsApp(); return whatsapp.showChat({ id: ref.id, name: label || 'WhatsApp conversation' }); }
    if (ref.type === 'file') return previewFile(ref.path, label || ref.path.split('/').at(-1));
    if (ref.type === 'workspace') {
      const actions = { mail: mail.showClient, whatsapp: () => { onWhatsApp(); whatsapp.showChats(); }, calendar: calendar.showUpcoming, whodb: whodb.show, emoji: emoji.show, teleprompter: teleprompter.show, ask: aiChat.show };
      return actions[ref.id]?.();
    }
    if (ref.type === 'web') {
      const approvalToken = await requestApproval('browser.open', { url: ref.url });
      const result = await fetch('/api/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: ref.url, approvalToken }) }).then(response => response.json());
      if (!result.ok) notify(result.error || 'Could not open this website.');
    }
  };
}
