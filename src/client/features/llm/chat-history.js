const historyKey = 'habibi.ephemeral-conversation-history.v1';

export function saveEphemeralTurn(sessionId, role, text) {
  try {
    const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
    history.push({ sessionId, role, text, createdAt: Date.now() });
    localStorage.setItem(historyKey, JSON.stringify(history.slice(-200)));
  } catch (_) {
    // Conversation history is best-effort local state.
  }
}
