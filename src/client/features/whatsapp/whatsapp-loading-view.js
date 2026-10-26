import { safeImageSrc } from '../../core/view-helpers.js';

export function chatSkeletonMarkup() {
  return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: 5 }, () => '<div class="skeleton-row"><span class="skeleton-avatar"></span><span class="skeleton-lines"><i></i><i></i></span></div>').join('')}</div>`;
}
export function pairingMarkup(status) {
  return `<div class="pairing-layout"><div class="pairing-code"><img class="openwa-qr" src="${safeImageSrc(status.qrCode)}" alt="Scan with WhatsApp to link this local session" /></div><div class="pairing-instructions"><div class="section-heading"><span>LINK YOUR PHONE</span><span>UPDATES AUTOMATICALLY</span></div><ol><li>Open WhatsApp on your phone</li><li>Settings → Linked devices → Link a device</li><li>Point the camera at this code</li></ol><div class="openwa-actions"><button class="primary" id="check-openwa">I’ve scanned it</button></div></div></div>`;
}

/** No requests or animation wakeups while the document is hidden. */
export function scheduleVisibleRefresh(callback, active, milliseconds = 3000) {
  setTimeout(() => {
    if (!active()) return;
    if (!document.hidden) return callback();
    document.addEventListener('visibilitychange', () => { if (active() && !document.hidden) callback(); }, { once: true });
  }, milliseconds);
}
