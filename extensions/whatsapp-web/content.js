(() => {
  const endpoint = 'http://127.0.0.1:4173/api/whatsapp/browser-recents';
  let lastFingerprint = '';
  let timer;

  const text = element => element?.textContent?.trim() || '';
  const timestamp = value => {
    const now = new Date();
    const match = String(value).match(/(\d{1,2}):(\d{2})/);
    if (!match) return Math.floor(Date.now() / 1000);
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]));
    return Math.floor(date.getTime() / 1000);
  };
  const collect = () => {
    const rows = [...document.querySelectorAll('#pane-side [role="listitem"]')].slice(0, 60);
    return rows.map((row, index) => {
      const titleNodes = [...row.querySelectorAll('[title]')].map(node => node.getAttribute('title')).filter(Boolean);
      const image = row.querySelector('img[src]');
      const labels = [...row.querySelectorAll('span')].map(text).filter(Boolean);
      const name = titleNodes[0] || labels[0] || '';
      const time = labels.find(value => /^(?:\d{1,2}:\d{2}|yesterday|mon|tue|wed|thu|fri|sat|sun)/i.test(value)) || '';
      const preview = labels.find(value => value !== name && value !== time && !/^\d+$/.test(value)) || '';
      const unread = Number(labels.find(value => /^\d+$/.test(value)) || 0);
      return { id: row.getAttribute('data-id') || `${name}-${index}`, name, lastMessage:preview, timestamp:timestamp(time), unreadCount:unread, avatar:image?.src || '' };
    }).filter(chat => chat.name);
  };
  const sync = () => {
    const chats = collect();
    const fingerprint = chats.map(chat => `${chat.id}:${chat.lastMessage}:${chat.unreadCount}`).join('|');
    if (!chats.length || fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    fetch(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ chats }) }).catch(() => {});
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(sync, 350); };
  new MutationObserver(schedule).observe(document.documentElement, { childList:true, subtree:true, characterData:true });
  setInterval(sync, 15_000);
  schedule();
})();
