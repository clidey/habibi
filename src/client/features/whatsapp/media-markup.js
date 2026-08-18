import { escapeHtml, icon, safeMediaSrc } from '../../core/view-helpers.js';

export function whatsappMediaMarkup(message) {
  const media = message.metadata?.media;
  const type = message.type || 'unknown';
  const mime = /^[\w.+/-]+$/.test(String(media?.mimetype || '')) ? media.mimetype : '';
  // `media.data` is connector-supplied base64. Build the URL, then let the
  // shared guard validate the whole thing rather than trusting the parts.
  const source = media?.data && mime ? safeMediaSrc(`data:${mime};base64,${media.data}`) : '';
  const filename = escapeHtml(
    media?.filename || message.body || (type === 'document' ? 'Document' : 'Media'),
  );
  if (source && type === 'image')
    return `<div class="media-card image-media"><img src="${source}" alt="Image message" loading="lazy" /></div>`;
  if (source && type === 'video')
    return `<div class="media-card video-media"><video controls preload="metadata" src="${source}"></video><span>${icon('video')} Video</span></div>`;
  if (source && (type === 'audio' || type === 'voice'))
    return `<div class="media-card audio-media"><span class="media-glyph">${icon('mic')}</span><audio controls src="${source}"></audio></div>`;
  if (type === 'document')
    return `<a class="media-card document-media" href="${source || '#'}" ${source ? `download="${filename}"` : ''}><span class="media-glyph">${icon(mime === 'application/pdf' ? 'file-text' : 'file')}</span><span><b>${filename}</b><small>${mime === 'application/pdf' ? 'PDF document' : 'Document'}${source ? ' · Download' : ''}</small></span></a>`;
  if (type !== 'text')
    return `<div class="media-card generic-media"><span class="media-glyph">${icon(type === 'video' ? 'video' : type === 'image' ? 'image' : 'paperclip')}</span><span><b>${escapeHtml(type === 'unknown' ? 'Media message' : `${type[0].toUpperCase()}${type.slice(1)} message`)}</b><small>${escapeHtml(message.body || 'Open in WhatsApp')}</small></span></div>`;
  return `<span>${escapeHtml(message.body || message.text || message.content || '')}</span>`;
}
