//! `/api/mail/*`: IMAP accounts (Gmail, Zoho), reading and searching the
//! inbox, sending over SMTP after an approval, and the Gmail/Zoho OAuth
//! connection. Ported from `src/server/services/mail-service.js` and the
//! mail routes in `server.js`.

mod attachments;
mod config;
mod imap;
mod js;
mod oauth;
mod parser;
mod search;
mod secrets;
mod transport;

use std::sync::Arc;

use async_trait::async_trait;
use habibi_core::services::{Llm, RecentFiles};
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method, Paths, Routes, body};
use serde_json::{Map, Value, json};

use crate::config::{Account, ConfigFile, Imap, PROVIDERS};
use crate::imap::{ImapError, Row, with_session};
use crate::oauth::{Authorized, OAuth};
use crate::search::SearchPlan;
use crate::secrets::SecretStore;
use crate::transport::Connector;

pub use crate::parser::{dedupe_messages, safe_email_html, split_mail_thread};

type Opener = Arc<dyn Fn(&str) -> bool + Send + Sync>;

pub struct MailService {
    paths: Paths,
    approvals: Arc<ApprovalService>,
    recent: Arc<dyn RecentFiles>,
    llm: Arc<dyn Llm>,
    config: Arc<ConfigFile>,
    secrets: Arc<dyn SecretStore>,
    connector: Arc<dyn Connector>,
    opener: Opener,
    oauth: Arc<OAuth>,
}

/// What a service needs from the outside world; tests replace all of it.
struct Backend {
    secrets: Arc<dyn SecretStore>,
    connector: Arc<dyn Connector>,
    opener: Opener,
    token_url: Option<String>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn ok_threads(threads: Vec<Value>) -> Value {
    json!({ "ok": true, "threads": threads })
}

fn failed_threads(error: &str) -> Value {
    json!({ "ok": false, "error": error, "threads": [] })
}

impl MailService {
    pub fn new(
        paths: Paths,
        approvals: Arc<ApprovalService>,
        recent: Arc<dyn RecentFiles>,
        llm: Arc<dyn Llm>,
    ) -> Arc<MailService> {
        let backend = Backend {
            secrets: Arc::new(secrets::Keychain),
            connector: Arc::new(transport::TlsConnector),
            opener: Arc::new(|target| habibi_platform::open::open_detached(target).is_ok()),
            token_url: None,
        };
        Self::with_backend(paths, approvals, recent, llm, backend)
    }

    fn with_backend(
        paths: Paths,
        approvals: Arc<ApprovalService>,
        recent: Arc<dyn RecentFiles>,
        llm: Arc<dyn Llm>,
        backend: Backend,
    ) -> Arc<MailService> {
        let config = Arc::new(ConfigFile::new(paths.state("mail-providers.json")));
        let oauth = OAuth::new(Arc::clone(&config), Arc::clone(&backend.secrets), backend.token_url);
        Arc::new(MailService {
            paths,
            approvals,
            recent,
            llm,
            config,
            secrets: backend.secrets,
            connector: backend.connector,
            opener: backend.opener,
            oauth,
        })
    }

    async fn secret(&self, account: String) -> String {
        secrets::get(&self.secrets, account).await
    }

    /// The account's app password, including the pre-multi-account item.
    async fn password(&self, account: &Account) -> String {
        let password = self.secret(format!("imap:{}", account.id)).await;
        if password.is_empty() && account.legacy {
            self.secret(format!("imap:{}", account.provider)).await
        } else {
            password
        }
    }

    async fn status(&self) -> Value {
        let config = self.config.read();
        let mut accounts = Vec::new();
        for account in config::accounts_from(&config) {
            let connected = !self.password(&account).await.is_empty();
            accounts.push(json!({
                "id": account.id,
                "provider": account.provider,
                "label": config::provider(&account.provider).map_or(account.provider.as_str(), |p| p.label),
                "email": account.imap.email,
                "connected": connected,
                "transport": "imap",
            }));
        }
        let providers: Vec<Value> = PROVIDERS
            .iter()
            .map(|provider| {
                let settings = config.get(provider.id);
                let configured = js::truthy(settings.and_then(|s| s.get("clientId")))
                    && js::truthy(settings.and_then(|s| s.get("clientSecret")));
                json!({ "id": provider.id, "label": provider.label, "configured": configured })
            })
            .collect();
        json!({ "ok": true, "providers": providers, "accounts": accounts })
    }

    fn configure(&self, body: &Value) -> Value {
        let provider = body.get("provider").and_then(Value::as_str).unwrap_or("");
        if config::provider(provider).is_none()
            || !js::truthy(body.get("clientId"))
            || !js::truthy(body.get("clientSecret"))
        {
            return json!({ "ok": false, "error": "Client ID and client secret are required." });
        }
        let redirect = js::string_or_empty(body.get("redirectUri"));
        let mut config = self.config.read();
        config.insert(
            provider.into(),
            json!({
                "clientId": js::string_or_empty(body.get("clientId")).trim(),
                "clientSecret": js::string_or_empty(body.get("clientSecret")).trim(),
                "redirectUri": if redirect.is_empty() { config::DEFAULT_REDIRECT_URI } else { redirect.as_str() }.trim(),
            }),
        );
        match self.config.write(&config) {
            Ok(()) => json!({ "ok": true }),
            Err(_) => json!({ "ok": false, "error": "Could not save the mail settings." }),
        }
    }

    async fn configure_imap(&self, body: &Value) -> Value {
        let provider_id = body.get("provider").and_then(Value::as_str).unwrap_or("");
        let Some(provider) = config::provider(provider_id) else {
            return json!({ "ok": false, "error": "Email address and app password are required." });
        };
        if !js::truthy(body.get("email")) || !js::truthy(body.get("password")) {
            return json!({ "ok": false, "error": "Email address and app password are required." });
        }
        let login_failed =
            json!({ "ok": false, "error": "IMAP login failed: check IMAP access, server, and app password." });
        let host = js::string_or_empty(body.get("host"));
        let port = match body.get("port") {
            None => 993.0,
            port => js::number(port),
        };
        let port = if port == 0.0 || port.is_nan() { 993.0 } else { port };
        if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
            return login_failed;
        }
        let imap = Imap {
            email: js::string(&body["email"]).trim().to_string(),
            host: if host.is_empty() { provider.imap_host.to_string() } else { host }.trim().to_string(),
            port: port as u16,
        };
        let password: String = js::string(&body["password"]).split_whitespace().collect();
        let verified: Result<(), ImapError> =
            with_session!(self.connector.as_ref(), &imap, &password, |_session| async { Ok(()) }).await;
        if verified.is_err() {
            return login_failed;
        }
        let id = config::account_id(provider.id, &imap.email);
        let mut config = self.config.read();
        let legacy_email = config
            .get(provider.id)
            .and_then(|settings| settings.get("imap"))
            .map(|imap| js::string_or_empty(imap.get("email")).to_lowercase());
        if legacy_email.as_deref() == Some(imap.email.to_lowercase().as_str()) {
            config.remove(provider.id);
        }
        let accounts = config.entry("accounts").or_insert_with(|| json!({}));
        if !accounts.is_object() {
            *accounts = json!({});
        }
        let created_at = accounts
            .get(&id)
            .and_then(|account| account.get("createdAt"))
            .filter(|created| js::truthy(Some(created)))
            .cloned()
            .unwrap_or_else(|| json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
        accounts[&id] = json!({
            "provider": provider.id,
            "imap": { "email": imap.email, "host": imap.host, "port": imap.port },
            "createdAt": created_at,
        });
        if self.config.write(&config).is_err() {
            return json!({ "ok": false, "error": "Could not save the mail settings." });
        }
        if secrets::set(&self.secrets, format!("imap:{id}"), password).await {
            json!({ "ok": true, "account": { "id": id, "provider": provider.id, "email": imap.email } })
        } else {
            json!({ "ok": false, "error": format!("Could not save the app password in {}.", secrets::store_name()) })
        }
    }

    async fn remove(&self, id: Option<&str>) -> Value {
        let Some(account) = id.and_then(|id| self.config.find(id)) else {
            return json!({ "ok": false, "error": "Unknown mail account." });
        };
        let mut config = self.config.read();
        if account.legacy {
            config.remove(&account.provider);
        } else if let Some(Value::Object(accounts)) = config.get_mut("accounts") {
            accounts.remove(&account.id);
        }
        if self.config.write(&config).is_err() {
            return json!({ "ok": false, "error": "Could not save the mail settings." });
        }
        secrets::delete(&self.secrets, format!("imap:{}", account.id)).await;
        if account.legacy {
            secrets::delete(&self.secrets, format!("imap:{}", account.provider)).await;
        }
        json!({ "ok": true })
    }

    fn row_json(account: &Account, row: Row, with_to: bool) -> Value {
        let mut value = Map::new();
        value.insert("id".into(), json!(row.uid.to_string()));
        value.insert("accountId".into(), json!(account.id));
        value.insert("provider".into(), json!(account.provider));
        value.insert("accountEmail".into(), json!(account.imap.email));
        value.insert("subject".into(), json!(row.subject));
        value.insert("from".into(), json!(row.from));
        if with_to {
            value.insert("to".into(), json!(row.to));
        }
        value.insert("preview".into(), json!(""));
        value.insert("timestamp".into(), json!(row.timestamp));
        value.insert("unread".into(), json!(row.unread));
        Value::Object(value)
    }

    /// `(account, password)` when the account exists and has a password.
    async fn connected(&self, id: Option<&str>) -> Option<(Account, String)> {
        let account = self.config.find(id?)?;
        let password = self.password(&account).await;
        (!password.is_empty()).then_some((account, password))
    }

    async fn threads(&self, id: Option<&str>) -> Value {
        let Some((account, password)) = self.connected(id).await else {
            return failed_threads("Connect this account with IMAP first.");
        };
        let rows =
            with_session!(self.connector.as_ref(), &account.imap, &password, |session| imap::inbox(session)).await;
        match rows {
            Ok(rows) => {
                let mut threads: Vec<Value> =
                    rows.into_iter().map(|row| Self::row_json(&account, row, false)).collect();
                sort_newest(&mut threads);
                ok_threads(threads)
            }
            Err(_) => failed_threads("Could not connect to IMAP."),
        }
    }

    async fn search_account(&self, account: &Account, plan: &SearchPlan) -> Value {
        let Some((account, password)) = self.connected(Some(&account.id)).await else {
            return failed_threads("Connect this account with IMAP first.");
        };
        let criteria = search::search_criteria(plan);
        let rows = with_session!(self.connector.as_ref(), &account.imap, &password, |session| imap::search(
            session, &criteria
        ))
        .await;
        match rows {
            Ok(rows) => {
                let mut threads: Vec<Value> = rows.into_iter().map(|row| Self::row_json(&account, row, true)).collect();
                search::rank(&mut threads, plan);
                ok_threads(threads)
            }
            Err(_) => failed_threads("Could not search this IMAP inbox."),
        }
    }

    async fn search(&self, provider: &str, plan: &SearchPlan) -> Value {
        let normalized = search::normalize(plan);
        let accounts: Vec<Account> = if !provider.is_empty() && provider != "all" {
            self.config.find(provider).into_iter().collect()
        } else {
            self.config.accounts()
        };
        if accounts.is_empty() {
            return json!({ "ok": true, "threads": [], "plan": normalized });
        }
        let results =
            futures_util::future::join_all(accounts.iter().map(|account| self.search_account(account, &normalized)))
                .await;
        let ok = results.iter().any(|result| result["ok"] == json!(true));
        let error = results
            .iter()
            .filter(|result| result["ok"] != json!(true))
            .filter_map(|result| result["error"].as_str())
            .find(|error| !error.is_empty())
            .unwrap_or("");
        let mut threads: Vec<Value> =
            results.iter().flat_map(|result| result["threads"].as_array().cloned().unwrap_or_default()).collect();
        search::rank(&mut threads, &normalized);
        threads.truncate(80);
        json!({ "ok": ok, "threads": threads, "plan": normalized, "error": error })
    }

    async fn recent(&self, provider: Option<&str>, hours: Option<&str>) -> Value {
        let hours = js::number_from_text(hours);
        let hours = if hours == 0.0 || hours.is_nan() { 4.0 } else { hours };
        let window = hours.clamp(1.0, 24.0) * 60.0 * 60.0 * 1000.0;
        let since = now_ms() as f64 - window;
        let in_window = |thread: &Value| thread["timestamp"].as_f64().unwrap_or(0.0) >= since;
        if provider == Some("all") {
            let accounts = self.config.accounts();
            let results =
                futures_util::future::join_all(accounts.iter().map(|account| self.threads(Some(&account.id)))).await;
            let mut merged: Vec<Value> = results
                .iter()
                .flat_map(|result| result["threads"].as_array().cloned().unwrap_or_default())
                .filter(in_window)
                .collect();
            sort_newest(&mut merged);
            return ok_threads(merged);
        }
        let mut inbox = self.threads(provider).await;
        let filtered: Vec<Value> =
            inbox["threads"].as_array().cloned().unwrap_or_default().into_iter().filter(in_window).collect();
        inbox["threads"] = json!(filtered);
        inbox
    }

    async fn message(&self, id: Option<&str>, uid: Option<&str>) -> Value {
        let unavailable = json!({ "ok": false, "error": "Mail account or message is unavailable." });
        let uid = uid
            .filter(|uid| !uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|uid| uid.parse::<u32>().ok());
        let (Some((account, password)), Some(uid)) = (self.connected(id).await, uid) else { return unavailable };
        let own = account.imap.email.clone();
        let fetched: Result<_, ImapError> =
            with_session!(self.connector.as_ref(), &account.imap, &password, |session| async {
                let Some(item) = imap::inbox_message(session, uid).await? else { return Ok(None) };
                let parsed = imap::parse_source(&item.raw);
                let subject = [parsed.subject.as_str(), item.subject.as_str()]
                    .into_iter()
                    .find(|subject| !subject.is_empty())
                    .unwrap_or("(No subject)")
                    .to_string();
                // IMAP stores our replies in a separate Sent mailbox. Read only
                // recent messages with the same normalized subject, then merge them
                // into this visual conversation. This is how the UI can show a real
                // sent reply even when the selected inbox email has not yet quoted it.
                let sent_path = parser::sent_mailbox_path(&imap::mailboxes(session).await?);
                let sent =
                    if sent_path.is_empty() { Vec::new() } else { imap::recent_sources(session, &sent_path).await? };
                Ok(Some((item, parsed, subject, sent)))
            })
            .await;
        let (item, parsed, subject, sent) = match fetched {
            Ok(Some(found)) => found,
            Ok(None) => return json!({ "ok": false, "error": "Message no longer exists." }),
            Err(_) => return json!({ "ok": false, "error": "Could not load the message." }),
        };
        let text = parsed.text.replace("\r\n", "\n");
        let text = collapse_blank_lines(&text);
        let body = text.trim();
        let from = if parsed.from.is_empty() { item.from.clone() } else { parsed.from.clone() };
        let mut messages = split_mail_thread(
            if body.is_empty() { "(No readable message body)" } else { body },
            &from,
            &own,
            item.timestamp,
            &safe_email_html(&parsed.html),
        );
        let topic = parser::conversation_subject(&subject);
        for sent in sent.iter().filter(|sent| parser::conversation_subject(&sent.subject) == topic) {
            let sent_parsed = imap::parse_source(&sent.raw);
            let sender = if sent_parsed.from.is_empty() { own.as_str() } else { sent_parsed.from.as_str() };
            let parts =
                split_mail_thread(&sent_parsed.text, sender, &own, sent.timestamp, &safe_email_html(&sent_parsed.html));
            // The first part is the actual message we sent; later parts are its
            // quoted history and have already been collected from the inbox.
            if let Some(mut first) = parts.into_iter().next() {
                first.direction = "outgoing".into();
                if sent.timestamp != 0 {
                    first.timestamp = sent.timestamp;
                }
                messages.push(first);
            }
        }
        json!({
            "ok": true,
            "message": {
                "id": item.uid.unwrap_or(uid).to_string(),
                "accountId": account.id,
                "provider": account.provider,
                "accountEmail": own,
                "messageId": parsed.message_id,
                "subject": subject,
                "from": from,
                "to": parsed.to,
                "timestamp": item.timestamp,
                "messages": dedupe_messages(messages),
                "attachments": parsed.attachments,
            }
        })
    }

    async fn send(&self, payload: &Value) -> Value {
        let account = payload.get("provider").and_then(Value::as_str).and_then(|id| self.config.find(id));
        let Some(account) = account else { return json!({ "ok": false, "error": "Connect a mail account first." }) };
        let address = js::string_or_empty(payload.get("to")).trim().to_string();
        let invalid_address = json!({ "ok": false, "error": "Enter a valid recipient address." });
        if !valid_address(&address) {
            return invalid_address;
        }
        let text = js::string_or_empty(payload.get("body"));
        if text.trim().is_empty() {
            return json!({ "ok": false, "error": "Write a message before sending." });
        }
        let Some(provider) = config::provider(&account.provider) else {
            return json!({ "ok": false, "error": "Sending is not supported for this provider yet." });
        };
        let password = self.password(&account).await;
        if password.is_empty() {
            return json!({ "ok": false, "error": "Connect this account with IMAP first." });
        }
        let Ok(files) = attachments::read_mail_attachments(payload.get("attachments"), &self.paths.home) else {
            return json!({ "ok": false, "error": "Could not read these attachments. Choose up to five local files, each under 8 MB and 20 MB in total." });
        };
        let subject = js::string_or_empty(payload.get("subject")).trim().to_string();
        let subject = if subject.is_empty() { "(No subject)".to_string() } else { subject };
        let Ok(to) = address.parse::<lettre::message::Mailbox>() else { return invalid_address };
        let could_not_send = json!({ "ok": false, "error": "Could not send this email." });
        let Ok(from) = account.imap.email.parse::<lettre::message::Mailbox>() else { return could_not_send };
        let domain = account.imap.email.rsplit_once('@').map_or("localhost", |(_, domain)| domain);
        let message_id = format!("<{}@{domain}>", uuid::Uuid::new_v4());
        let builder =
            lettre::Message::builder().from(from).to(to).subject(subject).message_id(Some(message_id.clone()));
        let message = if files.is_empty() {
            builder.header(lettre::message::header::ContentType::TEXT_PLAIN).body(text)
        } else {
            let mut parts = lettre::message::MultiPart::mixed().singlepart(lettre::message::SinglePart::plain(text));
            for file in files {
                let kind = lettre::message::header::ContentType::parse(attachments::content_type(&file.filename))
                    .unwrap_or(lettre::message::header::ContentType::TEXT_PLAIN);
                parts = parts.singlepart(lettre::message::Attachment::new(file.filename).body(file.content, kind));
            }
            builder.multipart(parts)
        };
        let Ok(message) = message else { return could_not_send };
        let (host, port) = provider.smtp;
        match self.connector.smtp(host, port, &account.imap.email, &password, message).await {
            Ok(()) => json!({ "ok": true, "messageId": message_id }),
            Err(()) => could_not_send,
        }
    }

    fn web_url(&self, body: &Value) -> String {
        let provider = body.get("provider").and_then(Value::as_str).unwrap_or("");
        let kind = self.config.find(provider).map(|account| account.provider).unwrap_or_else(|| provider.to_string());
        match kind.as_str() {
            "gmail" => {
                let query = if js::truthy(body.get("messageId")) {
                    format!("rfc822msgid:{}", js::string(&body["messageId"]).replace(['<', '>'], ""))
                } else {
                    format!("subject:\"{}\"", js::prefix(&js::string_or_empty(body.get("subject")), 180))
                };
                format!("https://mail.google.com/mail/u/0/#search/{}", js::encode_uri_component(&query))
            }
            "zoho" => "https://mail.zoho.com/zm/".into(),
            _ => String::new(),
        }
    }

    fn open(&self, body: &Value) -> Value {
        let target = self.web_url(body);
        if target.is_empty() || !(self.opener)(&target) {
            return json!({ "ok": false, "error": "That mail provider cannot be opened." });
        }
        self.recent.record(&target);
        let mut response = json!({ "ok": true });
        if let Some(provider) = body.get("provider") {
            response["provider"] = provider.clone();
        }
        response
    }

    fn authorize(&self, provider: &str) -> Value {
        match self.oauth.authorize(provider) {
            Authorized::Url(url) => {
                // The consent page opens in the default browser; the provider
                // redirects back to the one-shot loopback listener.
                (self.opener)(&url);
                json!({ "ok": true, "url": url })
            }
            Authorized::Error(error) => json!({ "ok": false, "error": error }),
        }
    }

    /// The `mail.send` payload, re-derived from the request exactly as the
    /// Node route built it (and as the UI asked for the approval).
    fn send_payload(body: &Value) -> Value {
        let mut payload = json!({
            "provider": js::string_or_empty(body.get("provider")),
            "to": js::string_or_empty(body.get("to")),
            "subject": js::string_or_empty(body.get("subject")),
            "body": js::string_or_empty(body.get("body")),
        });
        if let Some(Value::Array(list)) = body.get("attachments")
            && !list.is_empty()
        {
            payload["attachments"] = Value::Array(list.clone());
        }
        payload
    }
}

fn sort_newest(threads: &mut [Value]) {
    threads.sort_by_key(|thread| std::cmp::Reverse(thread["timestamp"].as_i64().unwrap_or(0)));
}

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
fn valid_address(address: &str) -> bool {
    let Some((local, domain)) = address.split_once('@') else { return false };
    let clean = |part: &str| !part.is_empty() && !part.contains('@') && !part.chars().any(char::is_whitespace);
    if !clean(local) || !clean(domain) {
        return false;
    }
    // Some dot with text on both sides inside the domain.
    domain.char_indices().any(|(index, c)| c == '.' && index > 0 && index + 1 < domain.len())
}

/// `.replace(/\n{4,}/g, '\n\n\n')`
fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0;
    for character in text.chars() {
        if character == '\n' {
            run += 1;
            if run <= 3 {
                out.push('\n');
            }
        } else {
            run = 0;
            out.push(character);
        }
    }
    out
}

fn json_response(value: Value) -> Option<ApiResponse> {
    Some(ApiResponse::json(&value))
}

#[async_trait]
impl Routes for MailService {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        if !request.path.starts_with("/api/mail/") {
            return None;
        }
        let get = request.method == Method::Get;
        let post = request.method == Method::Post;
        match request.path.as_str() {
            "/api/mail/status" if get => json_response(self.status().await),
            "/api/mail/open" if post => {
                let body = body!(request.json());
                json_response(self.open(&body))
            }
            "/api/mail/configure" if post => {
                let body = body!(request.json());
                json_response(self.configure(&body))
            }
            "/api/mail/imap" if post => {
                let body = body!(request.json());
                json_response(self.configure_imap(&body).await)
            }
            "/api/mail/remove" if post => {
                let body = body!(request.json());
                json_response(self.remove(body.get("provider").and_then(Value::as_str)).await)
            }
            "/api/mail/threads" if get => json_response(self.threads(request.query("provider")).await),
            "/api/mail/search" if get => {
                let query = request.query("q").unwrap_or("").trim().to_string();
                if query.is_empty() {
                    return json_response(json!({ "ok": true, "threads": [], "plan": { "terms": [] } }));
                }
                let plan = search::mail_search_plan(self.llm.as_ref(), &query).await;
                let provider = request.query("provider").filter(|p| !p.is_empty()).unwrap_or("all");
                json_response(self.search(provider, &plan).await)
            }
            "/api/mail/recent" if get => {
                json_response(self.recent(request.query("provider"), request.query("hours")).await)
            }
            "/api/mail/message" if get => {
                json_response(self.message(request.query("provider"), request.query("uid")).await)
            }
            "/api/mail/authorize" if post => {
                let body = body!(request.json());
                json_response(self.authorize(body.get("provider").and_then(Value::as_str).unwrap_or("")))
            }
            "/api/mail/oauth/callback" if get => {
                let result = self
                    .oauth
                    .callback(request.query("code").unwrap_or(""), request.query("state").unwrap_or(""))
                    .await;
                let mut response =
                    ApiResponse::bytes("text/html; charset=utf-8", oauth::callback_page(&result).into_bytes());
                response.status = if result.is_ok() { 200 } else { 400 };
                Some(response)
            }
            "/api/mail/send" if post => {
                let body = body!(request.json());
                let payload = Self::send_payload(&body);
                let token = body.get("approvalToken").and_then(Value::as_str);
                if !self.approvals.consume(token, "mail.send", &payload) {
                    return json_response(json!({ "ok": false, "error": "Sending needs explicit approval" }));
                }
                json_response(self.send(&payload).await)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests;
