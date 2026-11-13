//! Route tests. No real network, browser or Keychain: IMAP goes to a local
//! mock server over plain TCP, SMTP submissions are recorded, the opener is
//! a recorder and secrets live in memory.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use habibi_core::services::{CompletionRequest, CompletionResult, LlmState};
use habibi_core::{ApiRequest, Method};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use super::*;
use crate::secrets::MemoryStore;
use crate::transport::ImapStream;

#[derive(Default)]
struct Recent(Mutex<Vec<String>>);

impl RecentFiles for Recent {
    fn record(&self, target: &str) {
        self.0.lock().unwrap().push(target.into());
    }
}

struct NoLlm;

#[async_trait]
impl Llm for NoLlm {
    async fn state(&self) -> LlmState {
        LlmState { configured: false, provider: None }
    }
    async fn complete(&self, _request: CompletionRequest) -> CompletionResult {
        panic!("the mail search must not reach a model that is not configured");
    }
}

#[derive(Clone)]
struct MockMessage {
    uid: u32,
    subject: &'static str,
    from: (&'static str, &'static str),
    seen: bool,
    date: &'static str,
    raw: String,
}

#[derive(Default)]
struct MockImap {
    inbox: Vec<MockMessage>,
    sent: Vec<MockMessage>,
    password: &'static str,
    /// Received commands, literals included as `{n}` CRLF and their bytes.
    commands: Mutex<Vec<String>>,
    /// Advertise RFC 7888 `LITERAL+` in `CAPABILITY`.
    literal_plus: bool,
    /// Answer a synchronizing literal with a tagged `NO` instead of `+`.
    reject_literals: bool,
    /// `+` continuations sent.
    continuations: AtomicUsize,
    /// A client sent literal bytes before the `+` it had to wait for.
    early_literal: AtomicBool,
}

/// `{n}` or `{n+}` at the end of a command line: the literal's size and
/// whether the client waits for a continuation.
fn literal_announcement(line: &str) -> Option<(usize, bool)> {
    let open = line.rfind('{')?;
    let inner = line[open + 1..].strip_suffix('}')?;
    let (digits, synchronizing) = match inner.strip_suffix('+') {
        Some(digits) => (digits, false),
        None => (inner, true),
    };
    Some((digits.parse().ok()?, synchronizing))
}

fn quoted(value: &str) -> String {
    format!("\"{value}\"")
}

impl MockImap {
    fn envelope(message: &MockMessage) -> String {
        let (mailbox, host) = message.from;
        format!(
            "ENVELOPE ({} {} ((NIL NIL {} {})) NIL NIL ((NIL NIL \"me\" \"example.test\")) NIL NIL NIL NIL)",
            quoted(message.date),
            quoted(message.subject),
            quoted(mailbox),
            quoted(host)
        )
    }

    fn fetch_line(seq: usize, message: &MockMessage, body: bool) -> Vec<u8> {
        let flags = if message.seen { "\\Seen" } else { "" };
        let mut line = format!(
            "* {seq} FETCH (UID {} FLAGS ({flags}) INTERNALDATE \"{}\" {}",
            message.uid,
            message.date_imap(),
            Self::envelope(message)
        )
        .into_bytes();
        if body {
            line.extend_from_slice(format!(" BODY[] {{{}}}\r\n", message.raw.len()).as_bytes());
            line.extend_from_slice(message.raw.as_bytes());
        }
        line.extend_from_slice(b")\r\n");
        line
    }

    /// One whole command, following any literals in it. None at EOF or
    /// after refusing a literal (the refusal has been sent).
    async fn read_command(
        &self,
        reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
    ) -> Option<Option<String>> {
        let mut command = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                return None;
            }
            let line = line.strip_suffix("\r\n").unwrap_or(&line);
            command.push_str(line);
            let Some((size, synchronizing)) = literal_announcement(line) else {
                self.commands.lock().unwrap().push(command.clone());
                return Some(Some(command));
            };
            command.push_str("\r\n");
            if synchronizing {
                // Nothing may arrive before the continuation.
                let early = tokio::time::timeout(Duration::from_millis(50), reader.fill_buf()).await;
                if early.is_ok_and(|buffered| buffered.is_ok_and(|bytes| !bytes.is_empty())) {
                    self.early_literal.store(true, Ordering::SeqCst);
                }
                if self.reject_literals {
                    self.commands.lock().unwrap().push(command.clone());
                    let tag = command.split(' ').next().unwrap();
                    writer.write_all(format!("{tag} NO [BADCHARSET (US-ASCII)] refused\r\n").as_bytes()).await.unwrap();
                    return Some(None);
                }
                self.continuations.fetch_add(1, Ordering::SeqCst);
                writer.write_all(b"+ Ready for literal data\r\n").await.unwrap();
            }
            let mut literal = vec![0; size];
            reader.read_exact(&mut literal).await.ok()?;
            command.push_str(std::str::from_utf8(&literal).unwrap());
        }
    }

    async fn serve(self: Arc<Self>, stream: TcpStream) {
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        writer.write_all(b"* OK mock ready\r\n").await.unwrap();
        let mut selected: Vec<MockMessage> = Vec::new();
        loop {
            let Some(command) = self.read_command(&mut reader, &mut writer).await else { return };
            let Some(command) = command else { continue };
            let (tag, rest) = command.split_once(' ').unwrap();
            let upper = rest.to_ascii_uppercase();
            let mut reply: Vec<u8> = Vec::new();
            if upper.starts_with("CAPABILITY") {
                let extra = if self.literal_plus { " LITERAL+" } else { "" };
                reply.extend(format!("* CAPABILITY IMAP4rev1{extra}\r\n{tag} OK done\r\n").bytes());
            } else if upper.starts_with("LOGIN") {
                if rest.ends_with(&quoted(self.password)) {
                    reply.extend(format!("{tag} OK LOGIN completed\r\n").bytes());
                } else {
                    reply.extend(format!("{tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n").bytes());
                }
            } else if upper.starts_with("EXAMINE") || upper.starts_with("SELECT") {
                selected = if rest.contains("INBOX") { self.inbox.clone() } else { self.sent.clone() };
                reply.extend(
                    format!("* {} EXISTS\r\n* FLAGS (\\Seen)\r\n{tag} OK [READ-ONLY] done\r\n", selected.len()).bytes(),
                );
            } else if upper.starts_with("LIST") {
                reply.extend(format!("* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent\"\r\n{tag} OK done\r\n").bytes());
            } else if upper.starts_with("UID SEARCH") {
                let ids: Vec<String> = selected.iter().map(|m| m.uid.to_string()).collect();
                reply.extend(format!("* SEARCH {}\r\n{tag} OK done\r\n", ids.join(" ")).bytes());
            } else if upper.starts_with("UID FETCH") {
                let set = rest.split(' ').nth(2).unwrap();
                let wanted: Vec<u32> = set.split(',').map(|id| id.parse().unwrap()).collect();
                for (index, message) in selected.iter().enumerate() {
                    if wanted.contains(&message.uid) {
                        reply.extend(Self::fetch_line(index + 1, message, upper.contains("BODY.PEEK[]")));
                    }
                }
                reply.extend(format!("{tag} OK done\r\n").bytes());
            } else if upper.starts_with("FETCH") {
                let start: usize = rest.split(' ').nth(1).unwrap().split(':').next().unwrap().parse().unwrap();
                for (index, message) in selected.iter().enumerate().skip(start - 1) {
                    reply.extend(Self::fetch_line(index + 1, message, upper.contains("BODY.PEEK[]")));
                }
                reply.extend(format!("{tag} OK done\r\n").bytes());
            } else if upper.starts_with("LOGOUT") {
                writer.write_all(format!("* BYE\r\n{tag} OK done\r\n").as_bytes()).await.unwrap();
                return;
            } else {
                reply.extend(format!("{tag} BAD unexpected\r\n").bytes());
            }
            writer.write_all(&reply).await.unwrap();
        }
    }
}

impl MockMessage {
    /// `06-Jan-2025 10:00:00 +0000` from an RFC 2822 date.
    fn date_imap(&self) -> String {
        let date = chrono::DateTime::parse_from_rfc2822(self.date).unwrap();
        date.format("%d-%b-%Y %H:%M:%S %z").to_string()
    }
}

struct Sent {
    host: String,
    port: u16,
    user: String,
    message: String,
}

struct MockConnector {
    address: std::net::SocketAddr,
    sent: Mutex<Vec<Sent>>,
}

#[async_trait]
impl Connector for MockConnector {
    async fn imap(&self, _host: &str, _port: u16) -> std::io::Result<ImapStream> {
        Ok(Box::new(TcpStream::connect(self.address).await?))
    }
    async fn smtp(
        &self,
        host: &str,
        port: u16,
        user: &str,
        _password: &str,
        message: lettre::Message,
    ) -> Result<(), ()> {
        self.sent.lock().unwrap().push(Sent {
            host: host.into(),
            port,
            user: user.into(),
            message: String::from_utf8_lossy(&message.formatted()).into_owned(),
        });
        Ok(())
    }
}

struct Harness {
    service: Arc<MailService>,
    approvals: Arc<ApprovalService>,
    secrets: Arc<MemoryStore>,
    recent: Arc<Recent>,
    opened: Arc<Mutex<Vec<String>>>,
    imap: Arc<MockImap>,
    connector: Arc<MockConnector>,
    root: tempfile::TempDir,
}

fn message(
    uid: u32,
    subject: &'static str,
    from: (&'static str, &'static str),
    seen: bool,
    date: &'static str,
    body: &str,
) -> MockMessage {
    let raw = format!(
        "From: {}@{}\r\nTo: me@example.test\r\nSubject: {subject}\r\nMessage-ID: <m{uid}@example.test>\r\nDate: {date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n",
        from.0, from.1
    );
    MockMessage { uid, subject, from, seen, date, raw }
}

async fn harness_with(imap: MockImap, token_url: Option<String>) -> Harness {
    let imap = Arc::new(imap);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = Arc::clone(&imap);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(Arc::clone(&server).serve(stream));
        }
    });
    let connector = Arc::new(MockConnector { address, sent: Mutex::new(vec![]) });
    let secrets = Arc::new(MemoryStore::default());
    let recent = Arc::new(Recent::default());
    let opened = Arc::new(Mutex::new(Vec::new()));
    let approvals = Arc::new(ApprovalService::default());
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let recorder = Arc::clone(&opened);
    let backend = Backend {
        secrets: secrets.clone(),
        connector: connector.clone(),
        opener: Arc::new(move |target: &str| {
            recorder.lock().unwrap().push(target.to_string());
            true
        }),
        token_url,
    };
    let paths = Paths::new(root.path(), root.path(), &home);
    let service = MailService::with_backend(paths, Arc::clone(&approvals), recent.clone(), Arc::new(NoLlm), backend);
    Harness { service, approvals, secrets, recent, opened, imap, connector, root }
}

fn inbox_fixture() -> MockImap {
    MockImap {
        password: "app-password",
        inbox: vec![
            message(11, "Older note", ("alice", "example.test"), true, "Mon, 6 Jan 2025 10:00:00 +0000", "Old"),
            message(
                12,
                "=?UTF-8?Q?Invoice_caf=C3=A9?=",
                ("bob", "example.test"),
                false,
                "Tue, 7 Jan 2025 10:00:00 +0000",
                "Please pay.\r\n\r\nFrom: Me <me@example.test>\r\nSent: Mon, 6 Jan 2025 09:00:00 +0000\r\n\r\nSend the invoice?",
            ),
        ],
        sent: vec![message(
            1,
            "Re: Invoice café",
            ("me", "example.test"),
            true,
            "Wed, 8 Jan 2025 10:00:00 +0000",
            "Paid, thanks.\r\n\r\nFrom: bob@example.test\r\n\r\nPlease pay.",
        )],
        ..Default::default()
    }
}

async fn harness() -> Harness {
    harness_with(inbox_fixture(), None).await
}

impl Harness {
    fn write_config(&self, value: Value) {
        std::fs::create_dir_all(self.root.path().join(".habibi")).unwrap();
        std::fs::write(self.root.path().join(".habibi/mail-providers.json"), value.to_string()).unwrap();
    }

    fn config(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.root.path().join(".habibi/mail-providers.json")).unwrap()).unwrap()
    }

    /// A Gmail account with its app password stored; returns the id.
    fn with_account(&self) -> String {
        let id = "gmail:me@example.test";
        self.write_config(json!({
            "accounts": { id: { "provider": "gmail", "imap": { "email": "me@example.test", "host": "imap.example.test", "port": 993 }, "createdAt": "2025-01-01T00:00:00.000Z" } }
        }));
        self.secrets.set(&format!("imap:{id}"), "app-password");
        id.into()
    }

    fn secret(&self, account: &str) -> Option<String> {
        self.secrets.get(account)
    }

    async fn get(&self, path: &str) -> Value {
        self.service.handle(&ApiRequest::get(path)).await.expect("route").json_value().unwrap()
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        self.service.handle(&ApiRequest::post(path, &body)).await.expect("route").json_value().unwrap()
    }

    fn commands(&self) -> Vec<String> {
        self.imap.commands.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn other_paths_are_not_handled() {
    let h = harness().await;
    assert!(h.service.handle(&ApiRequest::get("/api/notes")).await.is_none());
    assert!(h.service.handle(&ApiRequest::new(Method::Post, "/api/mail/status", vec![])).await.is_none());
}

#[tokio::test]
async fn status_lists_providers_and_connected_accounts() {
    let h = harness().await;
    let empty = h.get("/api/mail/status").await;
    assert_eq!(empty["accounts"], json!([]));
    assert_eq!(
        empty["providers"],
        json!([{ "id": "gmail", "label": "Gmail", "configured": false }, { "id": "zoho", "label": "Zoho Mail", "configured": false }])
    );
    let id = h.with_account();
    let status = h.get("/api/mail/status").await;
    assert_eq!(
        status["accounts"],
        json!([{ "id": id, "provider": "gmail", "label": "Gmail", "email": "me@example.test", "connected": true, "transport": "imap" }])
    );
}

#[tokio::test]
async fn legacy_accounts_use_their_old_keychain_item() {
    let h = harness().await;
    h.write_config(
        json!({ "zoho": { "imap": { "email": "old@example.test", "host": "imap.example.test", "port": 993 } } }),
    );
    h.secrets.set("imap:zoho", "app-password");
    let status = h.get("/api/mail/status").await;
    assert_eq!(status["accounts"][0]["id"], "zoho");
    assert_eq!(status["accounts"][0]["connected"], true);
    let threads = h.get("/api/mail/threads?provider=zoho").await;
    assert_eq!(threads["ok"], true);
}

#[tokio::test]
async fn connecting_imap_verifies_the_login_and_stores_the_password_in_the_keychain() {
    let mut imap = inbox_fixture();
    imap.password = "apppassword";
    let h = harness_with(imap, None).await;
    h.write_config(
        json!({ "gmail": { "imap": { "email": "Me@Example.test", "host": "imap.gmail.com", "port": 993 } } }),
    );
    let missing = h.post("/api/mail/imap", json!({ "provider": "gmail", "email": "me@example.test" })).await;
    assert_eq!(missing, json!({ "ok": false, "error": "Email address and app password are required." }));

    let wrong =
        h.post("/api/mail/imap", json!({ "provider": "gmail", "email": "me@example.test", "password": "nope" })).await;
    assert_eq!(
        wrong,
        json!({ "ok": false, "error": "IMAP login failed: check IMAP access, server, and app password." })
    );
    assert_eq!(h.secret("imap:gmail:me@example.test"), None);

    let connected = h
        .post(
            "/api/mail/imap",
            json!({ "provider": "gmail", "email": " me@example.test ", "password": "app pass word", "host": "imap.example.test", "port": "993" }),
        )
        .await;
    assert_eq!(
        connected,
        json!({ "ok": true, "account": { "id": "gmail:me@example.test", "provider": "gmail", "email": "me@example.test" } })
    );
    // Whitespace in the pasted app password is removed before login and storage,
    // and it is kept under the account name the `security` CLI used.
    assert_eq!(h.secret("imap:gmail:me@example.test").as_deref(), Some("apppassword"));
    assert_eq!(habibi_platform::secrets::MAIL, "Habibi Mail");
    let config = h.config();
    assert!(config.get("gmail").is_none(), "the legacy entry for the same address is replaced");
    assert_eq!(
        config["accounts"]["gmail:me@example.test"]["imap"],
        json!({ "email": "me@example.test", "host": "imap.example.test", "port": 993 })
    );
    assert!(config["accounts"]["gmail:me@example.test"]["createdAt"].as_str().unwrap().ends_with('Z'));
    assert!(!config.to_string().contains("apppassword"), "secrets never go in the config file");
    assert!(!connected.to_string().contains("apppassword"));
}

#[tokio::test]
async fn threads_are_the_newest_inbox_messages_read_without_marking_them() {
    let h = harness().await;
    let id = h.with_account();
    let threads = h.get(&format!("/api/mail/threads?provider={id}")).await;
    assert_eq!(threads["ok"], true);
    assert_eq!(
        threads["threads"][0],
        json!({
            "id": "12", "accountId": id, "provider": "gmail", "accountEmail": "me@example.test",
            "subject": "Invoice café", "from": "bob@example.test", "preview": "",
            "timestamp": 1_736_244_000_000_i64, "unread": true
        })
    );
    assert_eq!(threads["threads"][1]["unread"], false);
    let commands = h.commands();
    assert!(commands.iter().any(|c| c.contains("EXAMINE \"INBOX\"")));
    assert!(!commands.iter().any(|c| c.contains("STORE") || c.contains("SELECT")));
}

#[tokio::test]
async fn threads_need_a_connected_account() {
    let h = harness().await;
    let threads = h.get("/api/mail/threads?provider=gmail:nobody@example.test").await;
    assert_eq!(threads, json!({ "ok": false, "error": "Connect this account with IMAP first.", "threads": [] }));
    let id = h.with_account();
    h.secrets.delete(&format!("imap:{id}"));
    assert_eq!(h.get(&format!("/api/mail/threads?provider={id}")).await["ok"], false);
}

#[tokio::test]
async fn a_failed_imap_login_is_a_fixed_error() {
    let h = harness().await;
    let id = h.with_account();
    h.secrets.set(&format!("imap:{id}"), "stale");
    let threads = h.get(&format!("/api/mail/threads?provider={id}")).await;
    assert_eq!(threads, json!({ "ok": false, "error": "Could not connect to IMAP.", "threads": [] }));
}

#[tokio::test]
async fn recent_keeps_only_the_time_window() {
    let h = harness().await;
    h.with_account();
    // The fixture's messages are from 2025, outside any window.
    let recent = h.get("/api/mail/recent?provider=all&hours=4").await;
    assert_eq!(recent, json!({ "ok": true, "threads": [] }));
    let single = h.get("/api/mail/recent?provider=gmail:me@example.test&hours=abc").await;
    assert_eq!(single["ok"], true);
    assert_eq!(single["threads"], json!([]));
}

#[tokio::test]
async fn search_uses_local_rules_and_ranks_subject_hits() {
    let h = harness().await;
    h.with_account();
    let empty = h.get("/api/mail/search?q=%20%20").await;
    assert_eq!(empty, json!({ "ok": true, "threads": [], "plan": { "terms": [] } }));
    let result = h.get("/api/mail/search?q=invoice%20a").await;
    assert_eq!(result["ok"], true);
    assert_eq!(result["error"], "");
    assert_eq!(
        result["plan"],
        json!({ "terms": ["invoice"], "from": "", "subject": "", "after": "", "before": "", "unread": null, "source": "rules" })
    );
    assert_eq!(result["threads"][0]["id"], "12");
    assert_eq!(result["threads"][0]["to"], "me@example.test");
    let search = h.commands().into_iter().find(|c| c.contains("UID SEARCH")).unwrap();
    assert!(
        search
            .ends_with("UID SEARCH OR SUBJECT \"invoice\" (OR FROM \"invoice\" (OR TO \"invoice\" BODY \"invoice\"))"),
        "{search}"
    );
}

/// The `UID SEARCH` command the mock received.
fn uid_search(h: &Harness) -> String {
    h.commands().into_iter().find(|c| c.contains("UID SEARCH")).expect("a UID SEARCH")
}

/// The OR tree for the terms `café` (a literal, framed with `open`) and `bill`
/// (quoted, as ASCII terms always are).
fn cafe_and_bill(open: &str) -> String {
    let cafe = format!("{open}\r\ncafé");
    format!(
        "UID SEARCH CHARSET UTF-8 OR SUBJECT {cafe} (OR FROM {cafe} (OR TO {cafe} (OR BODY {cafe} (OR SUBJECT \"bill\" (OR FROM \"bill\" (OR TO \"bill\" BODY \"bill\"))))))"
    )
}

#[tokio::test]
async fn non_ascii_terms_are_synchronizing_literals_sent_after_each_continuation() {
    let h = harness().await;
    h.with_account();
    let result = h.get("/api/mail/search?q=caf%C3%A9%20bill").await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["threads"].as_array().unwrap().len(), 2);
    let commands = h.commands();
    assert!(commands.iter().any(|c| c.ends_with(" CAPABILITY")), "LITERAL+ support is checked first");
    let search = uid_search(&h);
    // `{5}`: the literal's length is its UTF-8 bytes.
    assert!(search.ends_with(&cafe_and_bill("{5}")), "{search:?}");
    assert_eq!(h.imap.continuations.load(Ordering::SeqCst), 4, "one continuation per literal");
    assert!(!h.imap.early_literal.load(Ordering::SeqCst), "each literal waits for its continuation");
    assert!(commands.iter().any(|c| c.contains("UID FETCH 12,11 ")), "{commands:?}");
}

#[tokio::test]
async fn literal_plus_sends_non_synchronizing_literals_without_waiting() {
    let h = harness_with(MockImap { literal_plus: true, ..inbox_fixture() }, None).await;
    h.with_account();
    let result = h.get("/api/mail/search?q=caf%C3%A9%20bill").await;
    assert_eq!(result["ok"], true, "{result}");
    let search = uid_search(&h);
    assert!(search.ends_with(&cafe_and_bill("{5+}")), "{search:?}");
    assert_eq!(h.imap.continuations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn ascii_terms_need_no_literal_or_capability_check() {
    let h = harness().await;
    h.with_account();
    assert_eq!(h.get("/api/mail/search?q=bill").await["ok"], true);
    assert!(!h.commands().iter().any(|c| c.ends_with(" CAPABILITY")));
    assert!(uid_search(&h).ends_with("UID SEARCH OR SUBJECT \"bill\" (OR FROM \"bill\" (OR TO \"bill\" BODY \"bill\"))"));
    assert_eq!(h.imap.continuations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_refused_literal_fails_the_search_without_sending_it() {
    let h = harness_with(MockImap { reject_literals: true, ..inbox_fixture() }, None).await;
    h.with_account();
    let result = h.get("/api/mail/search?q=caf%C3%A9").await;
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"], "Could not search this IMAP inbox.");
    assert!(uid_search(&h).ends_with("UID SEARCH CHARSET UTF-8 OR SUBJECT {5}\r\n"), "{:?}", uid_search(&h));
    let commands = h.commands();
    let after: Vec<&String> = commands.iter().skip_while(|c| !c.contains("UID SEARCH")).skip(1).collect();
    // The literal bytes never went out as a command of their own.
    assert!(after.iter().all(|c| c.ends_with(" LOGOUT")), "{after:?}");
    assert!(!after.is_empty(), "the session is still logged out");
}

#[tokio::test]
async fn a_message_merges_the_sent_reply_into_the_conversation() {
    let h = harness().await;
    let id = h.with_account();
    let unavailable = h.get(&format!("/api/mail/message?provider={id}&uid=1x")).await;
    assert_eq!(unavailable, json!({ "ok": false, "error": "Mail account or message is unavailable." }));
    let gone = h.get(&format!("/api/mail/message?provider={id}&uid=99")).await;
    assert_eq!(gone, json!({ "ok": false, "error": "Message no longer exists." }));

    let result = h.get(&format!("/api/mail/message?provider={id}&uid=12")).await;
    assert_eq!(result["ok"], true, "{result}");
    let message = &result["message"];
    assert_eq!(message["subject"], "Invoice café");
    assert_eq!(message["messageId"], "<m12@example.test>");
    assert_eq!(message["from"], "bob@example.test");
    assert_eq!(message["to"], "me@example.test");
    let bubbles: Vec<(String, String)> = message["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["body"].as_str().unwrap().to_string(), m["direction"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(
        bubbles,
        vec![
            ("Send the invoice?".to_string(), "outgoing".to_string()),
            ("Please pay.".to_string(), "incoming".to_string()),
            ("Paid, thanks.".to_string(), "outgoing".to_string()),
        ]
    );
    assert!(h.commands().iter().any(|c| c.contains("EXAMINE \"Sent\"")));
    assert!(h.commands().iter().all(|c| !c.contains("BODY[]") || c.contains("BODY.PEEK[]")));
}

#[tokio::test]
async fn sending_requires_a_connected_account_a_valid_recipient_and_a_body() {
    let h = harness().await;
    let id = h.with_account();
    let no_account = h
        .service
        .send(&json!({ "provider": "unknown-account", "to": "a@example.test", "subject": "hi", "body": "hello" }))
        .await;
    assert_eq!(no_account["ok"], false);

    h.secrets.delete(&format!("imap:{id}"));
    let no_secret =
        h.service.send(&json!({ "provider": id, "to": "a@example.test", "subject": "hi", "body": "hello" })).await;
    assert_eq!(no_secret["ok"], false);
    assert!(no_secret["error"].as_str().unwrap().contains("IMAP first"));
}

#[tokio::test]
async fn an_invalid_recipient_or_an_empty_body_is_rejected_before_any_network_call() {
    let h = harness().await;
    let id = h.with_account();
    let bad = h.service.send(&json!({ "provider": id, "to": "not-an-email", "subject": "hi", "body": "hello" })).await;
    assert_eq!(bad["ok"], false);
    assert!(bad["error"].as_str().unwrap().contains("valid recipient"));
    let empty =
        h.service.send(&json!({ "provider": id, "to": "a@example.test", "subject": "hi", "body": "   " })).await;
    assert!(empty["error"].as_str().unwrap().contains("Write a message"));
    assert!(h.connector.sent.lock().unwrap().is_empty());
    assert!(h.commands().is_empty());
}

#[test]
fn recipient_addresses_follow_the_node_pattern() {
    assert!(valid_address("a@b.co"));
    assert!(!valid_address("a@b"));
    assert!(!valid_address("a b@c.d"));
    assert!(!valid_address("a@@b.c"));
    assert!(!valid_address("@b.c"));
    assert!(!valid_address("a@.c"));
}

#[tokio::test]
async fn sending_needs_an_approval_for_the_exact_message_and_attachments() {
    let h = harness().await;
    let id = h.with_account();
    let home = h.root.path().join("home");
    let plan = home.join("plan.txt");
    std::fs::write(&plan, b"the plan").unwrap();
    let attachments = json!([{ "path": plan.to_string_lossy(), "name": "plan.txt" }]);
    let payload = json!({ "provider": id, "to": "person@example.com", "subject": "Demo", "body": "A fictional message.", "attachments": attachments });

    let unapproved = h.post("/api/mail/send", payload.clone()).await;
    assert_eq!(unapproved, json!({ "ok": false, "error": "Sending needs explicit approval" }));

    // A token for the message without its attachment does not authorize it.
    let mut without = payload.clone();
    without.as_object_mut().unwrap().remove("attachments");
    let other = h.approvals.issue("mail.send", without);
    let mut body = payload.clone();
    body["approvalToken"] = json!(other.token);
    assert_eq!(h.post("/api/mail/send", body).await["ok"], false);
    assert!(h.connector.sent.lock().unwrap().is_empty());

    let approval = h.approvals.issue("mail.send", payload.clone());
    let mut body = payload.clone();
    body["approvalToken"] = json!(approval.token);
    let sent = h.post("/api/mail/send", body.clone()).await;
    assert_eq!(sent["ok"], true, "{sent}");
    assert!(sent["messageId"].as_str().unwrap().ends_with("@example.test>"));
    {
        let submissions = h.connector.sent.lock().unwrap();
        let submission = &submissions[0];
        assert_eq!(
            (submission.host.as_str(), submission.port, submission.user.as_str()),
            ("smtp.gmail.com", 465, "me@example.test")
        );
        assert!(submission.message.contains("To: person@example.com"));
        assert!(submission.message.contains("Subject: Demo"));
        assert!(submission.message.contains("filename=\"plan.txt\""));
        assert!(submission.message.contains("A fictional message."));
    }
    // The token is single-use.
    assert_eq!(
        h.post("/api/mail/send", body).await,
        json!({ "ok": false, "error": "Sending needs explicit approval" })
    );
}

#[tokio::test]
async fn an_empty_attachment_list_is_not_part_of_the_approved_payload() {
    let h = harness().await;
    let id = h.with_account();
    let payload = json!({ "provider": id, "to": "person@example.com", "subject": "", "body": "Hi" });
    let approval = h.approvals.issue("mail.send", payload.clone());
    let mut body = payload.clone();
    body["attachments"] = json!([]);
    body["approvalToken"] = json!(approval.token);
    let sent = h.post("/api/mail/send", body).await;
    assert_eq!(sent["ok"], true);
    assert!(h.connector.sent.lock().unwrap()[0].message.contains("Subject: (No subject)"));
}

#[tokio::test]
async fn attachments_outside_home_are_refused_after_approval() {
    let h = harness().await;
    let id = h.with_account();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let payload = json!({ "provider": id, "to": "person@example.com", "subject": "x", "body": "Hi", "attachments": [{ "path": outside.path().to_string_lossy(), "name": "x.txt" }] });
    let approval = h.approvals.issue("mail.send", payload.clone());
    let mut body = payload;
    body["approvalToken"] = json!(approval.token);
    let sent = h.post("/api/mail/send", body).await;
    assert_eq!(
        sent,
        json!({ "ok": false, "error": "Could not read these attachments. Choose up to five local files, each under 8 MB and 20 MB in total." })
    );
    assert!(h.connector.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn removing_an_account_deletes_its_settings_and_password() {
    let h = harness().await;
    let id = h.with_account();
    assert_eq!(
        h.post("/api/mail/remove", json!({ "provider": "nope" })).await,
        json!({ "ok": false, "error": "Unknown mail account." })
    );
    assert_eq!(h.post("/api/mail/remove", json!({ "provider": id })).await, json!({ "ok": true }));
    assert_eq!(h.config()["accounts"], json!({}));
    assert_eq!(h.secret(&format!("imap:{id}")), None);
}

#[tokio::test]
async fn opening_mail_on_the_web_records_it_as_recent() {
    let h = harness().await;
    let id = h.with_account();
    let opened = h.post("/api/mail/open", json!({ "provider": id, "messageId": "<abc@x>" })).await;
    assert_eq!(opened, json!({ "ok": true, "provider": id }));
    let url = "https://mail.google.com/mail/u/0/#search/rfc822msgid%3Aabc%40x";
    assert_eq!(*h.opened.lock().unwrap(), vec![url.to_string()]);
    assert_eq!(*h.recent.0.lock().unwrap(), vec![url.to_string()]);

    h.post("/api/mail/open", json!({ "provider": "gmail", "subject": "Lunch \"today\"" })).await;
    assert_eq!(
        h.opened.lock().unwrap()[1],
        "https://mail.google.com/mail/u/0/#search/subject%3A%22Lunch%20%22today%22%22"
    );
    assert_eq!(h.post("/api/mail/open", json!({ "provider": "zoho" })).await["ok"], true);
    assert_eq!(h.opened.lock().unwrap()[2], "https://mail.zoho.com/zm/");
    assert_eq!(
        h.post("/api/mail/open", json!({ "provider": "other" })).await,
        json!({ "ok": false, "error": "That mail provider cannot be opened." })
    );
}

#[tokio::test]
async fn configuring_a_provider_keeps_the_redirect_uri() {
    let h = harness().await;
    let missing = h.post("/api/mail/configure", json!({ "provider": "gmail", "clientId": "id" })).await;
    assert_eq!(missing, json!({ "ok": false, "error": "Client ID and client secret are required." }));
    assert_eq!(
        h.post("/api/mail/configure", json!({ "provider": "gmail", "clientId": " id ", "clientSecret": "shh" })).await,
        json!({ "ok": true })
    );
    assert_eq!(
        h.config()["gmail"],
        json!({ "clientId": "id", "clientSecret": "shh", "redirectUri": config::DEFAULT_REDIRECT_URI })
    );
    assert_eq!(h.get("/api/mail/status").await["providers"][0]["configured"], true);
    assert_eq!(
        h.post("/api/mail/authorize", json!({ "provider": "zoho" })).await,
        json!({ "ok": false, "error": "Configure this mail provider first." })
    );
}

/// A token endpoint that answers one request and reports the form it got.
async fn token_server(reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/token", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            request.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if body.len() >= length {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                    return body.to_string();
                }
            }
        }
    });
    (url, task)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn http_get(port: u16, host: &str, target: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream
        .write_all(format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

fn query_value(url: &str, key: &str) -> String {
    let query = url.split_once('?').unwrap().1;
    form_urlencoded::parse(query.as_bytes()).find(|(name, _)| name == key).map(|(_, value)| value.into_owned()).unwrap()
}

#[tokio::test]
async fn oauth_uses_a_one_shot_loopback_listener_and_keeps_the_refresh_token_out_of_responses() {
    let (token_url, token_request) =
        token_server(r#"{"access_token":"a","token_type":"Bearer","refresh_token":"refresh-token-super-secret"}"#)
            .await;
    let h = harness_with(inbox_fixture(), Some(token_url)).await;
    let port = free_port();
    let redirect = format!("http://127.0.0.1:{port}/api/mail/oauth/callback");
    h.post(
        "/api/mail/configure",
        json!({ "provider": "gmail", "clientId": "id", "clientSecret": "shh", "redirectUri": redirect }),
    )
    .await;

    let authorized = h.post("/api/mail/authorize", json!({ "provider": "gmail" })).await;
    assert_eq!(authorized["ok"], true);
    let url = authorized["url"].as_str().unwrap().to_string();
    assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
    assert_eq!(query_value(&url, "redirect_uri"), redirect);
    assert_eq!(
        query_value(&url, "scope"),
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"
    );
    assert_eq!(query_value(&url, "access_type"), "offline");
    assert_eq!(query_value(&url, "code_challenge_method"), "S256");
    assert_eq!(*h.opened.lock().unwrap(), vec![url.clone()], "the consent page opens in the browser");
    let state = query_value(&url, "state");

    // Another Host (e.g. DNS rebinding) or path is refused without spending the state.
    let foreign =
        http_get(port, &format!("evil.test:{port}"), &format!("/api/mail/oauth/callback?code=c&state={state}")).await;
    assert!(foreign.starts_with("HTTP/1.1 403"));
    assert!(http_get(port, &format!("127.0.0.1:{port}"), "/favicon.ico").await.starts_with("HTTP/1.1 404"));
    // An unknown state is refused and the listener keeps waiting.
    let unknown = http_get(port, &format!("127.0.0.1:{port}"), "/api/mail/oauth/callback?code=c&state=guess").await;
    assert!(unknown.starts_with("HTTP/1.1 400"));
    assert!(unknown.contains("This connection request expired."));

    let done =
        http_get(port, &format!("127.0.0.1:{port}"), &format!("/api/mail/oauth/callback?code=the-code&state={state}"))
            .await;
    assert!(done.starts_with("HTTP/1.1 200"), "{done}");
    assert!(done.contains("Mail connected."));
    assert!(!done.contains("refresh-token-super-secret"));
    assert_eq!(h.secret("refresh:gmail").as_deref(), Some("refresh-token-super-secret"));

    let form = token_request.await.unwrap();
    let fields: std::collections::HashMap<String, String> =
        form_urlencoded::parse(form.as_bytes()).into_owned().collect();
    assert_eq!(fields["grant_type"], "authorization_code");
    assert_eq!(fields["code"], "the-code");
    assert_eq!(fields["redirect_uri"], redirect);
    assert!(fields["code_verifier"].len() >= 43);

    // The listener closes after the callback, and the state cannot be replayed.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    let replay =
        h.service.handle(&ApiRequest::get(&format!("/api/mail/oauth/callback?code=c&state={state}"))).await.unwrap();
    assert_eq!(replay.status, 400);
    assert!(String::from_utf8(replay.body).unwrap().contains("This connection request expired."));
}

#[tokio::test]
async fn a_busy_redirect_port_is_a_clear_error() {
    let h = harness().await;
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    let redirect = format!("http://127.0.0.1:{port}/api/mail/oauth/callback");
    h.post(
        "/api/mail/configure",
        json!({ "provider": "zoho", "clientId": "id", "clientSecret": "shh", "redirectUri": redirect }),
    )
    .await;
    let authorized = h.post("/api/mail/authorize", json!({ "provider": "zoho" })).await;
    assert_eq!(authorized["ok"], false);
    assert!(authorized["error"].as_str().unwrap().contains(&format!("Port {port} is in use")));
    assert!(h.opened.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_token_exchange_shows_a_fixed_message() {
    let (token_url, _request) =
        token_server(r#"{"error":"invalid_grant","error_description":"<b>provider text</b>"}"#).await;
    let h = harness_with(inbox_fixture(), Some(token_url)).await;
    let port = free_port();
    let redirect = format!("http://localhost:{port}/cb");
    h.post(
        "/api/mail/configure",
        json!({ "provider": "zoho", "clientId": "id", "clientSecret": "shh", "redirectUri": redirect }),
    )
    .await;
    let authorized = h.post("/api/mail/authorize", json!({ "provider": "zoho" })).await;
    let url = authorized["url"].as_str().unwrap();
    assert_eq!(query_value(url, "scope"), "ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE");
    let state = query_value(url, "state");
    // The IPC route completes the same pending request.
    let response =
        h.service.handle(&ApiRequest::get(&format!("/api/mail/oauth/callback?code=c&state={state}"))).await.unwrap();
    assert_eq!(response.status, 400);
    let page = String::from_utf8(response.body).unwrap();
    assert!(page.contains("The provider did not return a refresh token."));
    assert!(!page.contains("provider text"));
    assert_eq!(h.secret("refresh:zoho"), None);
}
