//! WhatsApp: OpenWA session lifecycle, recents validation, avatar enrichment
//! and approved sends (`src/server/services/whatsapp-service.js`), plus
//! supervision of the OpenWA runtime and the macOS WhatsApp Desktop reader.

pub mod desktop;
pub mod openwa;
pub mod runtime;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method};
use serde_json::{Map, Value, json};

use crate::util::{self, array, encode_component, js_string, number, number_value, record, take, truthy};
use openwa::OpenwaClient;

// Attachment payloads are base64-encoded before they reach OpenWA. Keep the
// local boundary comfortably below OpenWA's default 50 MiB media cap while
// still allowing a useful collection of documents in one approved send.
pub const MAX_SEND_BODY_BYTES: usize = 10 * 1024 * 1024;

const NOT_CONNECTED: &str = "WhatsApp is not connected";
const UNAVAILABLE: &str = "WhatsApp is unavailable";

fn reply(value: Value) -> Option<ApiResponse> {
    Some(ApiResponse::json(&value))
}

fn error(message: &str) -> Value {
    json!({ "ok": false, "error": message })
}

/// `/^\+?\d[\d\s()-]{6,}$/` on the trimmed label.
fn is_phone_label(value: Option<&Value>) -> bool {
    let label = util::string_or_empty(value);
    let label = label.trim();
    let digits = label.strip_prefix('+').unwrap_or(label);
    let mut chars = digits.chars();
    chars.next().is_some_and(|first| first.is_ascii_digit()) && {
        let rest: Vec<char> = chars.collect();
        rest.len() >= 6 && rest.iter().all(|c| c.is_ascii_digit() || c.is_whitespace() || "()-".contains(*c))
    }
}

/// Collapse duplicate connector rows by chat id, keeping the newest preview,
/// a real name over a phone-number label, any avatar, and the higher unread count.
pub fn dedupe_chats(chats: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for chat in chats {
        let id = util::string_or_empty(chat.get("id"));
        if id.is_empty() {
            continue;
        }
        let Some(previous) = by_id.get(&id) else {
            order.push(id.clone());
            by_id.insert(id, chat.clone());
            continue;
        };
        let timestamp = |value: &Value| number(Some(util::or(value.get("timestamp"), &json!(0))));
        let (newest, older) = if timestamp(chat) >= timestamp(previous) { (chat, previous) } else { (previous, chat) };
        let mut merged: Map<String, Value> = record(Some(older));
        merged.extend(record(Some(newest)));
        let name = if is_phone_label(newest.get("name")) && !is_phone_label(older.get("name")) {
            older.get("name")
        } else {
            newest.get("name")
        };
        set_or_remove(&mut merged, "name", name.cloned());
        let avatar = if truthy(newest.get("avatar")) { newest.get("avatar") } else { older.get("avatar") };
        set_or_remove(&mut merged, "avatar", avatar.cloned());
        let unread = |value: &Value| number(Some(util::or(value.get("unreadCount"), &json!(0))));
        let (a, b) = (unread(newest), unread(older));
        let max = if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) };
        merged.insert("unreadCount".into(), number_value(max));
        by_id.insert(id, Value::Object(merged));
    }
    order.into_iter().filter_map(|id| by_id.remove(&id)).collect()
}

/// `undefined` properties disappear from `JSON.stringify`.
fn set_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.into(), value);
        }
        None => {
            map.remove(key);
        }
    }
}

/// Only a snapshot with at least five visible, timestamped chats is trusted.
pub fn has_usable_recents(chats: &[Value]) -> bool {
    let visible: Vec<&Value> = chats
        .iter()
        .filter(|chat| chat.get("kind").and_then(Value::as_str) != Some("status") && !truthy(chat.get("archived")))
        .collect();
    visible.len() >= 5 && visible.iter().filter(|chat| number(chat.get("timestamp")) > 0.0).count() >= 5
}

// OpenWA's live history uses `fromMe`; its persisted message collection uses
// `direction`. Habibi exposes one stable UI contract regardless of source.
fn normalize_history(messages: &Value) -> Vec<Value> {
    let list = match messages {
        Value::Array(items) => items.as_slice(),
        other => {
            let nested = if truthy(other.get("messages")) { other.get("messages") } else { other.get("items") };
            array(nested)
        }
    };
    list.iter()
        .map(|message| {
            let mut normalized = record(Some(message));
            let direction = if truthy(message.get("direction")) {
                message["direction"].clone()
            } else if truthy(message.get("fromMe")) {
                json!("outgoing")
            } else {
                json!("incoming")
            };
            normalized.insert("direction".into(), direction);
            let metadata = if truthy(message.get("metadata")) {
                Some(message["metadata"].clone())
            } else if truthy(message.get("media")) {
                Some(json!({ "media": message["media"] }))
            } else {
                None
            };
            set_or_remove(&mut normalized, "metadata", metadata);
            Value::Object(normalized)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
struct Attachment {
    name: String,
    mime: String,
    base64: String,
    bytes: u64,
}

/// One attachment from the UI, or `None` when it is not a well-formed data
/// URL whose declared type matches its `mime`.
fn normalize_attachment(value: &Value) -> Option<Attachment> {
    let name: String = util::string_or_empty(value.get("name"))
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '\0') { '-' } else { c })
        .take(255)
        .collect();
    let name = if name.is_empty() { "Attachment".to_string() } else { name };
    let mime = take(&js_string(util::or(value.get("mime"), &json!("application/octet-stream"))), 120);
    let data_url = util::string_or_empty(value.get("dataUrl"));
    // `/^data:([\w.+/-]+);base64,([A-Za-z0-9+/=]+)$/`
    let rest = data_url.strip_prefix("data:")?;
    let (declared, base64) = rest.split_once(";base64,")?;
    let declared_ok = !declared.is_empty()
        && declared.chars().all(|c| c.is_ascii_alphanumeric() || "_.+/-".contains(c));
    let base64_ok = !base64.is_empty() && base64.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c));
    if !declared_ok || !base64_ok || declared != mime {
        return None;
    }
    let padding = if base64.ends_with("==") { 2 } else if base64.ends_with('=') { 1 } else { 0 };
    let bytes = (base64.len() as u64 * 3 / 4).saturating_sub(padding);
    Some(Attachment { name, mime, base64: base64.to_string(), bytes })
}

/// State shared with background avatar warming.
struct Shared {
    client: OpenwaClient,
    pictures: Mutex<HashMap<String, Value>>,
}

impl Shared {
    async fn warm_pictures(self: Arc<Self>, session_id: String, ids: Vec<String>) {
        let missing: Vec<String> = {
            let cache = self.pictures.lock().unwrap_or_else(|e| e.into_inner());
            ids.into_iter().filter(|id| !cache.get(id).is_some_and(|picture| truthy(Some(picture)))).collect()
        };
        if missing.is_empty() {
            return;
        }
        // Avatars are optional enrichment.
        let Some(pictures) = self.client.profile_pictures(&session_id, &missing).await else { return };
        let mut cache = self.pictures.lock().unwrap_or_else(|e| e.into_inner());
        for id in missing {
            if let Some(picture) = pictures.get(&id).filter(|picture| truthy(Some(picture))) {
                cache.insert(id, picture.clone());
            }
        }
    }
}

pub struct WhatsApp {
    shared: Arc<Shared>,
    approvals: Arc<ApprovalService>,
    snapshot_path: PathBuf,
    chats_cache: Mutex<Option<(Instant, Value)>>,
    settle: Duration,
}

impl WhatsApp {
    pub fn new(state_dir: PathBuf, client: OpenwaClient, approvals: Arc<ApprovalService>) -> Self {
        Self {
            shared: Arc::new(Shared { client, pictures: Mutex::new(HashMap::new()) }),
            approvals,
            snapshot_path: state_dir.join("whatsapp-recents.json"),
            chats_cache: Mutex::new(None),
            settle: Duration::from_millis(700),
        }
    }

    #[cfg(test)]
    fn without_settle_delay(mut self) -> Self {
        self.settle = Duration::ZERO;
        self
    }

    fn client(&self) -> &OpenwaClient {
        &self.shared.client
    }

    pub async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        match (request.method, request.path.as_str()) {
            (Method::Get, "/api/openwa/status") => reply(match self.client().session_state().await {
                Ok(state) => with_ok(state),
                Err(_) => json!({ "ok": false }),
            }),
            (Method::Post, "/api/openwa/connect") => reply(self.connect(false).await),
            (Method::Post, "/api/openwa/reset") => reply(self.connect(true).await),
            (Method::Get, "/api/whatsapp/chats") => reply(self.chats().await),
            (Method::Get, "/api/whatsapp/contacts") => reply(self.contacts(request.query("q").unwrap_or("")).await),
            (Method::Get, "/api/whatsapp/history") => reply(match request.query("chatId").filter(|id| !id.is_empty()) {
                Some(chat_id) => self.history(chat_id).await,
                None => error("Missing chat"),
            }),
            (Method::Get, "/api/whatsapp/profile-pictures") => {
                reply(self.profile_pictures(request.query("ids").unwrap_or("")).await)
            }
            (Method::Post, "/api/whatsapp/send") => reply(self.send(&request.body).await),
            _ => None,
        }
    }

    async fn connect(&self, reset: bool) -> Value {
        let prepared = if reset { self.client().force_reset().await } else { self.client().ensure_session().await };
        if let Err(message) = prepared {
            return error(&message);
        }
        tokio::time::sleep(self.settle).await;
        match self.client().session_state().await {
            Ok(state) => with_ok(state),
            Err(message) => error(&message),
        }
    }

    /// The ready session's id, or the envelope to return instead.
    async fn ready_session(&self) -> Result<String, Value> {
        match self.client().session_state().await {
            Ok(state) if state.pointer("/session/status").and_then(Value::as_str) == Some("ready") => {
                Ok(js_string(&state["session"]["id"]))
            }
            Ok(_) => Err(error(NOT_CONNECTED)),
            Err(_) => Err(error(UNAVAILABLE)),
        }
    }

    fn read_snapshot(&self) -> Option<Vec<Value>> {
        let snapshot: Value = serde_json::from_slice(&std::fs::read(&self.snapshot_path).ok()?).ok()?;
        let chats = array(snapshot.get("chats"));
        (!chats.is_empty()).then(|| chats.to_vec())
    }

    fn save_snapshot(&self, chats: &[Value]) {
        if !has_usable_recents(chats) {
            return;
        }
        // Chat names and message previews: readable only by this user.
        // A live session remains usable when disk is unavailable.
        if let Some(parent) = self.snapshot_path.parent()
            && util::create_private_dir(parent).is_err() {
                return;
            }
        let snapshot = json!({ "savedAt": number_value(util::now_ms()), "chats": chats });
        let _ = util::write_private(&self.snapshot_path, snapshot.to_string().as_bytes());
    }

    async fn chats(&self) -> Value {
        if let Some((at, chats)) = self.chats_cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
            && at.elapsed() < Duration::from_secs(60) {
                return json!({ "ok": true, "chats": chats, "cached": true });
            }
        let session = match self.ready_session().await {
            Ok(session) => session,
            Err(envelope) => return envelope,
        };
        let Ok(chats) = self.client().get(&format!("/api/sessions/{}/chats?limit=100", encode_component(&session))).await
        else {
            return error(UNAVAILABLE);
        };
        let named = dedupe_chats(array(Some(&chats)));
        self.save_snapshot(&named);
        let snapshot = self.read_snapshot();
        let live = has_usable_recents(&named);
        let resolved = if live { named } else { snapshot.clone().unwrap_or(named) };
        *self.chats_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), Value::Array(resolved.clone())));
        let ids: Vec<String> = resolved.iter().take(20).map(|chat| chat.get("id").map(js_string).unwrap_or_default()).collect();
        tokio::spawn(self.shared.clone().warm_pictures(session, ids));
        let source = if live || snapshot.is_none() { "openwa" } else { "snapshot" };
        json!({ "ok": true, "chats": resolved, "cached": false, "source": source })
    }

    async fn contacts(&self, query: &str) -> Value {
        let query = take(&query.trim().to_lowercase(), 80);
        let session = match self.ready_session().await {
            Ok(session) => session,
            Err(envelope) => return envelope,
        };
        let Ok(contacts) =
            self.client().get(&format!("/api/sessions/{}/contacts?limit=1000", encode_component(&session))).await
        else {
            return error(UNAVAILABLE);
        };
        let matches: Vec<Value> = array(Some(&contacts))
            .iter()
            .filter(|contact| {
                let field = |key: &str| util::string_or_empty(contact.get(key));
                format!("{} {} {} {}", field("name"), field("pushName"), field("notify"), field("id"))
                    .to_lowercase()
                    .contains(&query)
            })
            .take(20)
            .cloned()
            .collect();
        json!({ "ok": true, "contacts": matches })
    }

    async fn history(&self, chat_id: &str) -> Value {
        let session = match self.ready_session().await {
            Ok(session) => session,
            Err(envelope) => return envelope,
        };
        let (session, id) = (encode_component(&session), encode_component(chat_id));
        // The paginated collection is OpenWA's persisted store and can lag a
        // connected device. Prefer the engine-backed endpoint: it returns the
        // latest WhatsApp-visible messages for this chat. Fall back only when
        // the engine cannot provide live history.
        let live = self.client().get(&format!("/api/sessions/{session}/messages/{id}/history?limit=40")).await;
        let messages = match live {
            Ok(messages) => messages,
            Err(_) => match self.client().get(&format!("/api/sessions/{session}/messages?chatId={id}&limit=40")).await {
                Ok(messages) => messages,
                Err(_) => return error(UNAVAILABLE),
            },
        };
        json!({ "ok": true, "messages": normalize_history(&messages) })
    }

    async fn profile_pictures(&self, ids: &str) -> Value {
        let ids: Vec<String> = ids.split(',').filter(|id| !id.is_empty()).take(50).map(str::to_string).collect();
        if ids.is_empty() {
            return json!({ "ok": true, "pictures": {} });
        }
        let pictures: Map<String, Value> = {
            let cache = self.shared.pictures.lock().unwrap_or_else(|e| e.into_inner());
            ids.iter().map(|id| (id.clone(), cache.get(id).cloned().unwrap_or(Value::Null))).collect()
        };
        let shared = self.shared.clone();
        tokio::spawn(async move {
            if let Ok(state) = shared.client.session_state().await
                && state.pointer("/session/status").and_then(Value::as_str) == Some("ready") {
                    let session = js_string(&state["session"]["id"]);
                    shared.warm_pictures(session, ids).await;
                }
        });
        // The nested shape is what the UI has always received.
        json!({ "ok": true, "pictures": { "pictures": pictures } })
    }

    async fn send(&self, raw: &[u8]) -> Value {
        if raw.len() > MAX_SEND_BODY_BYTES {
            return error("Request body too large");
        }
        let body: Value = if raw.iter().all(u8::is_ascii_whitespace) {
            json!({})
        } else {
            match serde_json::from_slice(raw) {
                Ok(body) => body,
                Err(_) => return error("Invalid message"),
            }
        };
        let chat_id = body.get("chatId").cloned().unwrap_or(Value::Null);
        let text = match body.get("text") {
            None => String::new(),
            Some(value) => js_string(value),
        };
        let trimmed = text.trim().to_string();
        let given = body.get("attachments");
        let attachments: Vec<Attachment> = match given {
            Some(Value::Array(items)) => items.iter().take(5).filter_map(normalize_attachment).collect(),
            _ => Vec::new(),
        };
        if !truthy(Some(&chat_id)) || (trimmed.is_empty() && attachments.is_empty()) || trimmed.encode_utf16().count() > 4096 {
            return error("Invalid message");
        }
        if let Some(Value::Array(items)) = given
            && items.len() != attachments.len() {
                return error("One or more attachments are invalid");
            }
        let payload = json!({
            "chatId": js_string(&chat_id),
            "text": trimmed,
            "attachments": attachments
                .iter()
                .map(|attachment| json!({ "name": attachment.name, "mime": attachment.mime, "bytes": attachment.bytes }))
                .collect::<Vec<_>>(),
        });
        let token = body.get("approvalToken").and_then(Value::as_str);
        if !self.approvals.consume(token, "whatsapp.send", &payload) {
            return error("Sending needs explicit approval");
        }
        let session = match self.ready_session().await {
            Ok(session) => encode_component(&session),
            Err(envelope) => return envelope,
        };
        let mut sent = Vec::new();
        if !trimmed.is_empty() && attachments.is_empty() {
            let body = json!({ "chatId": chat_id, "text": trimmed });
            match self.client().request("POST", &format!("/api/sessions/{session}/messages/send-text"), Some(body)).await {
                Ok(message) => sent.push(message),
                Err(_) => return error(UNAVAILABLE),
            }
        }
        for (index, attachment) in attachments.iter().enumerate() {
            let mut body = json!({
                "chatId": chat_id,
                "base64": attachment.base64,
                "mimetype": attachment.mime,
                "filename": attachment.name,
            });
            if index == 0 && !trimmed.is_empty() {
                body["caption"] = Value::from(trimmed.clone());
            }
            match self.client().request("POST", &format!("/api/sessions/{session}/messages/send-document"), Some(body)).await {
                Ok(message) => sent.push(message),
                Err(_) => return error(UNAVAILABLE),
            }
        }
        json!({ "ok": true, "message": sent.last().cloned().unwrap_or(Value::Null), "sent": sent })
    }
}

/// `{ ok: true, ...state }`.
fn with_ok(state: Value) -> Value {
    let mut map = record(Some(&state));
    map.insert("ok".into(), Value::Bool(true));
    Value::Object(map)
}

#[cfg(test)]
mod tests;
