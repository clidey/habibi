//! Read-only IMAP access: the newest inbox messages, a search, and one
//! message with its sent replies. Mailboxes are opened with `EXAMINE` and
//! bodies fetched with `BODY.PEEK[]`, so reading never changes flags.

use std::time::Duration;

use async_imap::imap_proto::{Address, Envelope, MailboxDatum, RequestId, Response, Status};
use async_imap::types::{Fetch, Flag, NameAttribute};
use futures_util::TryStreamExt;
use tokio::io::AsyncWriteExt;
use mail_parser::{MessageParser, PartKind};
use serde_json::{Value, json};

use crate::config::Imap;
use crate::parser::MailboxInfo;
use crate::search::{Criteria, Part};
use crate::transport::{CONNECT_TIMEOUT, Connector, ImapStream};

/// Upper bound for one whole IMAP operation.
pub const OPERATION_TIMEOUT: Duration = Duration::from_secs(120);

pub type Session = async_imap::Session<ImapStream>;

#[derive(Debug)]
pub struct ImapError;

impl From<async_imap::error::Error> for ImapError {
    fn from(_: async_imap::error::Error) -> Self {
        ImapError
    }
}

impl From<std::io::Error> for ImapError {
    fn from(_: std::io::Error) -> Self {
        ImapError
    }
}

pub async fn login(connector: &dyn Connector, imap: &Imap, password: &str) -> Result<Session, ImapError> {
    let stream = connector.imap(&imap.host, imap.port).await?;
    let mut client = async_imap::Client::new(stream);
    let greeting = tokio::time::timeout(CONNECT_TIMEOUT, client.read_response()).await.map_err(|_| ImapError)??;
    greeting.ok_or(ImapError)?;
    client.login(&imap.email, password).await.map_err(|(error, _)| ImapError::from(error))
}

pub async fn logout(mut session: Session) {
    let _ = tokio::time::timeout(Duration::from_secs(5), session.logout()).await;
}

/// Log in, run `$body` with `$session` bound to the session, then log out
/// whatever happened; the whole thing is bounded by [`OPERATION_TIMEOUT`].
macro_rules! with_session {
    ($connector:expr, $imap:expr, $password:expr, |$session:ident| $body:expr) => {
        async {
            let work = async {
                let mut session = $crate::imap::login($connector, $imap, $password).await?;
                let result = {
                    let $session = &mut session;
                    $body.await
                };
                $crate::imap::logout(session).await;
                result
            };
            tokio::time::timeout($crate::imap::OPERATION_TIMEOUT, work).await.map_err(|_| $crate::imap::ImapError)?
        }
    };
}
pub(crate) use with_session;

/// RFC 2047 words in an envelope field, decoded.
fn decode_words(raw: &[u8]) -> String {
    let flat: Vec<u8> = raw.iter().copied().filter(|byte| *byte != b'\r' && *byte != b'\n').collect();
    let mut header = b"Subject: ".to_vec();
    header.extend_from_slice(&flat);
    header.extend_from_slice(b"\r\n\r\n");
    MessageParser::new()
        .parse(&header)
        .and_then(|message| message.subject().map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(&flat).into_owned())
}

fn first_address(addresses: Option<&Vec<Address<'_>>>) -> String {
    let Some(address) = addresses.and_then(|list| list.first()) else { return String::new() };
    let mailbox = address.mailbox.as_deref().map(String::from_utf8_lossy).unwrap_or_default();
    match address.host.as_deref().map(String::from_utf8_lossy) {
        Some(host) if !mailbox.is_empty() => format!("{mailbox}@{host}"),
        _ => mailbox.into_owned(),
    }
}

fn envelope_subject(envelope: Option<&Envelope<'_>>) -> String {
    envelope.and_then(|envelope| envelope.subject.as_deref()).map(decode_words).unwrap_or_default()
}

fn internal_date(fetch: &Fetch) -> i64 {
    fetch.internal_date().map(|date| date.timestamp_millis()).unwrap_or(0)
}

/// One inbox row as the Node service returned it.
pub struct Row {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub to: String,
    pub timestamp: i64,
    pub unread: bool,
}

fn row(fetch: &Fetch) -> Option<Row> {
    let envelope = fetch.envelope();
    let subject = envelope_subject(envelope);
    Some(Row {
        uid: fetch.uid?,
        subject: if subject.is_empty() { "(No subject)".into() } else { subject },
        from: first_address(envelope.and_then(|envelope| envelope.from.as_ref())),
        to: first_address(envelope.and_then(|envelope| envelope.to.as_ref())),
        timestamp: internal_date(fetch),
        unread: !fetch.flags().any(|flag| flag == Flag::Seen),
    })
}

const ROW_QUERY: &str = "(UID ENVELOPE FLAGS INTERNALDATE)";

/// The newest 50 inbox messages.
pub async fn inbox(session: &mut Session) -> Result<Vec<Row>, ImapError> {
    let mailbox = session.examine("INBOX").await?;
    if mailbox.exists == 0 {
        return Ok(Vec::new());
    }
    let start = mailbox.exists.saturating_sub(49).max(1);
    let fetches: Vec<Fetch> = session.fetch(format!("{start}:*"), ROW_QUERY).await?.try_collect().await?;
    Ok(fetches.iter().filter_map(row).collect())
}

/// RFC 7888 `LITERAL-` only allows non-synchronizing literals up to this size.
const LITERAL_MINUS_MAX: usize = 4096;

/// `UID SEARCH` with `criteria`. ASCII-only criteria go out as one line.
/// Each literal is announced as `{n}` and sent only after the server's `+`
/// continuation, or as `{n+}` without waiting when the server advertises
/// `LITERAL+` (or `LITERAL-` for literals up to 4096 bytes). async-imap has
/// no literal support outside `APPEND`, so the command is framed here the
/// same way `APPEND` does it: the tagged first line through `run_command`,
/// the rest written to the stream directly.
async fn uid_search(session: &mut Session, criteria: &Criteria) -> Result<Vec<u32>, ImapError> {
    if !criteria.has_literals() {
        return Ok(session.uid_search(criteria.to_string()).await?.into_iter().collect());
    }
    // A failed CAPABILITY just means synchronizing literals, which every server takes.
    let capabilities = session.capabilities().await.ok();
    let advertises = |name: &str| capabilities.as_ref().is_some_and(|capabilities| capabilities.has_str(name));
    let (plus, minus) = (advertises("LITERAL+"), advertises("LITERAL-"));
    let mut tag: Option<RequestId> = None;
    let mut line = b"UID SEARCH ".to_vec();
    for part in criteria.parts() {
        let value = match part {
            Part::Text(text) => {
                line.extend_from_slice(text.as_bytes());
                continue;
            }
            Part::Literal(value) => value.as_bytes(),
        };
        let wait = !(plus || (minus && value.len() <= LITERAL_MINUS_MAX));
        line.extend_from_slice(format!("{{{}{}}}", value.len(), if wait { "" } else { "+" }).as_bytes());
        let id = match &tag {
            // The first line is everything before the first literal: ASCII.
            None => session.run_command(std::str::from_utf8(&line).map_err(|_| ImapError)?).await?,
            Some(id) => {
                line.extend_from_slice(b"\r\n");
                session.get_mut().write_all(&line).await?;
                id.clone()
            }
        };
        if wait {
            session.get_mut().flush().await?;
            continuation(session, &id).await?;
        }
        tag = Some(id);
        line = value.to_vec();
    }
    let tag = tag.ok_or(ImapError)?;
    line.extend_from_slice(b"\r\n");
    session.get_mut().write_all(&line).await?;
    session.get_mut().flush().await?;
    let mut ids = Vec::new();
    loop {
        let response = session.read_response().await?.ok_or(ImapError)?;
        match response.parsed() {
            Response::MailboxData(MailboxDatum::Search(found)) => ids.extend_from_slice(found),
            Response::Done { tag: done, status, .. } if *done == tag => {
                return if matches!(status, Status::Ok) { Ok(ids) } else { Err(ImapError) };
            }
            _ => {}
        }
    }
}

/// Wait for the `+` that lets a synchronizing literal follow. A tagged reply
/// instead means the server refused the command.
async fn continuation(session: &mut Session, tag: &RequestId) -> Result<(), ImapError> {
    loop {
        let response = session.read_response().await?.ok_or(ImapError)?;
        match response.parsed() {
            Response::Continue(_) => return Ok(()),
            Response::Done { tag: done, .. } if done == tag => return Err(ImapError),
            _ => {}
        }
    }
}

/// Up to 120 newest inbox messages matching `criteria`.
pub async fn search(session: &mut Session, criteria: &Criteria) -> Result<Vec<Row>, ImapError> {
    session.examine("INBOX").await?;
    let mut ids = uid_search(session, criteria).await?;
    ids.sort_unstable();
    ids.dedup();
    // IMAP returns UIDs in mailbox order. Pull the newest matches first, then
    // rank subject/sender hits locally without exposing any mail to a model.
    let candidates: Vec<String> = ids.iter().rev().take(120).map(u32::to_string).collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let fetches: Vec<Fetch> = session.uid_fetch(candidates.join(","), ROW_QUERY).await?.try_collect().await?;
    Ok(fetches.iter().filter_map(row).collect())
}

/// A message source with what the envelope said about it.
pub struct Source {
    pub uid: Option<u32>,
    pub subject: String,
    pub from: String,
    pub timestamp: i64,
    pub raw: Vec<u8>,
}

fn source(fetch: &Fetch) -> Source {
    let envelope = fetch.envelope();
    Source {
        uid: fetch.uid,
        subject: envelope_subject(envelope),
        from: first_address(envelope.and_then(|envelope| envelope.from.as_ref())),
        timestamp: internal_date(fetch),
        raw: fetch.body().map(<[u8]>::to_vec).unwrap_or_default(),
    }
}

/// The inbox message with this UID, if it still exists.
pub async fn inbox_message(session: &mut Session, uid: u32) -> Result<Option<Source>, ImapError> {
    session.examine("INBOX").await?;
    let fetches: Vec<Fetch> =
        session.uid_fetch(uid.to_string(), "(UID ENVELOPE INTERNALDATE BODY.PEEK[])").await?.try_collect().await?;
    Ok(fetches.iter().find(|fetch| fetch.uid == Some(uid)).map(source))
}

fn attribute_name(attribute: &NameAttribute<'_>) -> String {
    match attribute {
        NameAttribute::NoInferiors => "\\Noinferiors".into(),
        NameAttribute::NoSelect => "\\Noselect".into(),
        NameAttribute::Marked => "\\Marked".into(),
        NameAttribute::Unmarked => "\\Unmarked".into(),
        NameAttribute::All => "\\All".into(),
        NameAttribute::Archive => "\\Archive".into(),
        NameAttribute::Drafts => "\\Drafts".into(),
        NameAttribute::Flagged => "\\Flagged".into(),
        NameAttribute::Junk => "\\Junk".into(),
        NameAttribute::Sent => "\\Sent".into(),
        NameAttribute::Trash => "\\Trash".into(),
        NameAttribute::Extension(name) => name.to_string(),
        _ => String::new(),
    }
}

pub async fn mailboxes(session: &mut Session) -> Result<Vec<MailboxInfo>, ImapError> {
    let names: Vec<_> = session.list(None, Some("*")).await?.try_collect().await?;
    Ok(names
        .iter()
        .map(|name| MailboxInfo {
            path: name.name().to_string(),
            special_use: name.attributes().iter().map(attribute_name).collect(),
        })
        .collect())
}

/// The newest 150 messages of `mailbox` (the Sent folder).
pub async fn recent_sources(session: &mut Session, mailbox: &str) -> Result<Vec<Source>, ImapError> {
    let selected = session.examine(mailbox).await?;
    if selected.exists == 0 {
        return Ok(Vec::new());
    }
    let start = selected.exists.saturating_sub(149).max(1);
    let fetches: Vec<Fetch> =
        session.fetch(format!("{start}:*"), "(ENVELOPE INTERNALDATE BODY.PEEK[])").await?.try_collect().await?;
    Ok(fetches.iter().map(source).collect())
}

/// What `simpleParser` produced that the mail view uses.
pub struct Parsed {
    pub subject: String,
    pub text: String,
    pub html: String,
    pub from: String,
    pub to: String,
    pub message_id: String,
    pub attachments: Vec<Value>,
}

fn address_text(list: Option<mail_parser::AddressList<'_>>) -> String {
    let Some(list) = list else { return String::new() };
    list.mailboxes()
        .filter_map(|mailbox| match (mailbox.name(), mailbox.address()) {
            (Some(name), Some(address)) if !name.is_empty() => {
                Some(format!("\"{}\" <{address}>", name.replace('\\', "\\\\").replace('"', "\\\"")))
            }
            (_, Some(address)) => Some(address.to_string()),
            (Some(name), None) => Some(format!("\"{name}\"")),
            (None, None) => None,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn parse_source(raw: &[u8]) -> Parsed {
    let Some(message) = MessageParser::new().parse(raw) else {
        return Parsed {
            subject: String::new(),
            text: String::new(),
            html: String::new(),
            from: String::new(),
            to: String::new(),
            message_id: String::new(),
            attachments: Vec::new(),
        };
    };
    let html: Vec<String> = message
        .html_body()
        .filter(|part| matches!(part.kind(), PartKind::Html))
        .filter_map(|part| part.text().map(|text| text.into_owned()))
        .collect();
    let attachments = message
        .attachments()
        .map(|part| {
            let content_type = part
                .content_type()
                .map(|kind| match kind.subtype() {
                    Some(subtype) => format!("{}/{}", kind.ctype(), subtype).to_ascii_lowercase(),
                    None => kind.ctype().to_ascii_lowercase(),
                })
                .filter(|kind| !kind.is_empty())
                .unwrap_or_else(|| "file".into());
            json!({
                "filename": part.attachment_name().filter(|name| !name.is_empty()).unwrap_or("Attachment"),
                "contentType": content_type,
                "size": part.decoded_len(),
            })
        })
        .take(12)
        .collect();
    Parsed {
        subject: message.subject().unwrap_or("").to_string(),
        text: message.text_bodies().collect::<Vec<_>>().join("\n"),
        html: html.join("\n"),
        from: address_text(message.from()),
        to: address_text(message.to()),
        message_id: message.message_id().map(|id| format!("<{id}>")).unwrap_or_default(),
        attachments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_the_mail_view_needs() {
        let raw = concat!(
            "From: \"Alice A.\" <alice@example.com>\r\n",
            "To: Bob <bob@example.com>, carol@example.com\r\n",
            "Subject: =?UTF-8?B?SGVsbG8=?=\r\n",
            "Message-ID: <abc@example.com>\r\n",
            "Content-Type: multipart/mixed; boundary=\"b\"\r\n",
            "\r\n",
            "--b\r\n",
            "Content-Type: multipart/alternative; boundary=\"c\"\r\n",
            "\r\n",
            "--c\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "\r\n",
            "Hi there\r\n",
            "--c\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "\r\n",
            "<p>Hi <b>there</b></p>\r\n",
            "--c--\r\n",
            "--b\r\n",
            "Content-Type: application/pdf; name=report.pdf\r\n",
            "Content-Disposition: attachment; filename=report.pdf\r\n",
            "Content-Transfer-Encoding: base64\r\n",
            "\r\n",
            "JVBERi0xLjQK\r\n",
            "--b--\r\n",
        );
        let parsed = parse_source(raw.as_bytes());
        assert_eq!(parsed.subject, "Hello");
        assert_eq!(parsed.from, "\"Alice A.\" <alice@example.com>");
        assert_eq!(parsed.to, "\"Bob\" <bob@example.com>, carol@example.com");
        assert_eq!(parsed.message_id, "<abc@example.com>");
        assert_eq!(parsed.text.trim(), "Hi there");
        assert!(parsed.html.contains("<b>there</b>"));
        assert_eq!(
            parsed.attachments,
            vec![json!({ "filename": "report.pdf", "contentType": "application/pdf", "size": 9 })]
        );
    }

    #[test]
    fn envelope_words_are_decoded() {
        assert_eq!(decode_words(b"=?UTF-8?Q?Caf=C3=A9?= menu"), "Café menu");
        assert_eq!(decode_words(b"Plain"), "Plain");
    }
}
