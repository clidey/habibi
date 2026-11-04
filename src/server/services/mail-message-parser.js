// Mail HTML sanitization is loaded only when a message is read.
let htmlSanitizer;
const getSanitizeHtml = () => (htmlSanitizer ||= require('sanitize-html'));

// Mail clients commonly put the whole quoted conversation in `text/plain`.
// Treat the quoted headers as structure, rather than displaying one large MIME-ish
// blob. This deliberately preserves the message prose while dropping visual noise
// such as inline-image ids, link wrappers, warning banners and legal footers.
const cleanMailText = (value) =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\[cid:[^\]]+\].*$/gim, '')
    .replace(/<https?:\/\/[^>\s]+>/g, '')
    .replace(
      /^Note:\s*This email is received from an external sender[^\n]*(?:\n(?!\s*\n)[^\n]*)*/gim,
      '',
    )
    .replace(/^This message \(including any attachments\)[\s\S]*$/gim, '')
    .replace(/^This message and any attachments are confidential[\s\S]*$/gim, '')
    .replace(/^_{10,}\s*$/gm, '')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();

const addressFrom = (value) =>
  String(value || '')
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    ?.toLowerCase() || '';
const conversationSubject = (value) =>
  String(value || '')
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function safeEmailHtml(value) {
  const sanitizeHtml = getSanitizeHtml();
  // Only render the current email's HTML. Quoted mail is already split into
  // separate plain-text bubbles below, so it must not be duplicated here.
  let current = String(value || '')
    .replace(/<hr\b[^>]*>[\s\S]*$/i, '')
    .replace(/(?:<br\s*\/?>(?:\s|&nbsp;|<br\s*\/?>)*){2,}\s*(?:From:|On\s.+?wrote:)[\s\S]*$/i, '');
  // HTML mail often wraps a reply header in a nest of spans/divs instead of
  // placing it directly after a <br>. Cutting at its first visible `From:` is
  // safe: sanitizer will close any remaining open tags for us.
  const replyAt = current.search(/(?:<[^>]+>\s*){0,6}From:\s/i);
  if (replyAt >= 0) current = current.slice(0, replyAt);
  current = current.replace(/={3,}\s*Forwarded message\s*={3,}/gi, '');
  const sanitized = sanitizeHtml(current, {
    allowedTags: [
      'a',
      'b',
      'blockquote',
      'br',
      'div',
      'em',
      'i',
      'li',
      'ol',
      'p',
      'span',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'u',
      'ul',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
    allowedStyles: {
      '*': {
        'font-size': [/^\d+(?:px|pt|em|rem|%)$/i],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/i],
        'font-style': [/^(?:normal|italic)$/i],
        'text-align': [/^(?:left|right|center)$/i],
        'text-decoration': [/^(?:none|underline)$/i],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      }),
    },
  });
  // Outlook/Zoho signatures often encode blank paragraphs as <div><br></div>.
  // They create huge visual gaps in a compact launcher, so collapse them while
  // retaining one meaningful line break between prose blocks.
  return sanitized
    .replace(/<(?:div|p)(?:\s[^>]*)?>\s*(?:<br\s*\/?>\s*)+<\/(?:div|p)>/gi, '')
    .replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>')
    .trim();
}

function sectionHeaders(section) {
  const normalized = String(section || '')
    .replace(/^\s*_{10,}\s*\n*/i, '')
    .trim();
  if (!/^From:\s*/i.test(normalized)) return { from: '', to: '', sent: '', body: normalized };
  const boundary = normalized.search(/\n\s*\n/);
  if (boundary < 0)
    return {
      from: normalized.match(/^From:\s*(.+)$/im)?.[1]?.trim() || '',
      to: '',
      sent: '',
      body: '',
    };
  const headers = normalized.slice(0, boundary);
  return {
    from: headers.match(/^From:\s*(.+)$/im)?.[1]?.trim() || '',
    to: headers.match(/^To:\s*(.+)$/im)?.[1]?.trim() || '',
    sent: headers.match(/^(?:Sent|Date):\s*(.+)$/im)?.[1]?.trim() || '',
    body: normalized.slice(boundary).trim(),
  };
}

function splitMailThread(body, latestFrom, ownEmail, fallbackTimestamp = 0, firstHtml = '') {
  // A separator may have an empty line before `From:`, or the client may omit it.
  const sections = String(body || '')
    .replace(/\r\n/g, '\n')
    .split(/\n(?:\s*_{10,}\s*\n\s*)?(?=From:\s)/i);
  const messages = sections
    .map((section, index) => {
      const parsed = sectionHeaders(section);
      const from = parsed.from || (index === 0 ? latestFrom : 'Unknown sender');
      const content = cleanMailText(parsed.body);
      const sender = addressFrom(from);
      const parsedTime = parsed.sent ? Date.parse(parsed.sent) : NaN;
      return {
        from,
        to: parsed.to || '',
        sent: parsed.sent || '',
        body: content.replace(/={3,}\s*Forwarded message\s*={3,}/gi, '').trim(),
        html: index === 0 ? firstHtml : '',
        direction:
          sender && sender === String(ownEmail || '').toLowerCase() ? 'outgoing' : 'incoming',
        timestamp: Number.isFinite(parsedTime)
          ? parsedTime
          : Math.max(0, fallbackTimestamp - index),
      };
    })
    .filter((item) => item.body);
  // A forwarded email is followed by a normal From: header. Attach that sender
  // to the preceding bubble so the client can render a concise forward marker.
  return messages.map((message, index) => ({
    ...message,
    forwardedFrom: /forwarded message/i.test(sections[index] || '')
      ? messages[index + 1]?.from || ''
      : '',
    forwardedTo: /forwarded message/i.test(sections[index] || '')
      ? messages[index + 1]?.to || ''
      : '',
  }));
}

const dedupeMessages = (messages) => {
  const seen = new Set();
  return messages
    .filter((message) => {
      const key = `${addressFrom(message.from)}:${message.body.replace(/\s+/g, ' ').trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
};

function sentMailboxPath(mailboxes) {
  return (
    mailboxes.find((mailbox) => {
      const special = Array.isArray(mailbox.specialUse)
        ? mailbox.specialUse.join(' ')
        : String(mailbox.specialUse || '');
      return (
        /\\Sent/i.test(special) || /^(sent|sent items|sent mail)$/i.test(String(mailbox.path || ''))
      );
    })?.path || ''
  );
}

module.exports = {
  conversationSubject,
  safeEmailHtml,
  splitMailThread,
  dedupeMessages,
  sentMailboxPath,
};
