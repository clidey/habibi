use habibi_core::Method;

use super::*;
use crate::http::{HttpError, HttpResponse};
use crate::testing::FakeHttp;

#[test]
fn collapses_duplicate_rows_by_chat_id_and_keeps_the_newest_preview() {
    let chats = dedupe_chats(&[
        json!({ "id": "447700@c.us", "name": "Alex", "timestamp": 10, "lastMessage": "older", "unreadCount": 1 }),
        json!({ "id": "447700@c.us", "name": "Alex", "timestamp": 20, "lastMessage": "newer", "unreadCount": 0, "avatar": "https://example.test/avatar.jpg" }),
        json!({ "id": "", "name": "dropped" }),
    ]);
    assert_eq!(chats.len(), 1);
    assert_eq!(chats[0]["lastMessage"], "newer");
    assert_eq!(chats[0]["unreadCount"], 1);
    assert_eq!(chats[0]["avatar"], "https://example.test/avatar.jpg");
}

#[test]
fn a_real_name_wins_over_a_phone_label() {
    let chats = dedupe_chats(&[
        json!({ "id": "1@c.us", "name": "Alex", "timestamp": 1 }),
        json!({ "id": "1@c.us", "name": "+44 7700 900123", "timestamp": 2 }),
    ]);
    assert_eq!(chats[0]["name"], "Alex");
    assert!(is_phone_label(Some(&json!("+44 (7700) 900-123"))));
    assert!(!is_phone_label(Some(&json!("Alex 123456789"))));
}

#[test]
fn accepts_only_a_timestamped_visible_recents_snapshot() {
    let valid: Vec<Value> = (0..5).map(|index| json!({ "id": format!("{index}@c.us"), "timestamp": index + 1, "kind": "individual" })).collect();
    let invalid: Vec<Value> = valid.iter().map(|chat| json!({ "id": chat["id"], "timestamp": 0, "kind": "individual" })).collect();
    assert!(has_usable_recents(&valid));
    assert!(!has_usable_recents(&invalid));
    let mut hidden = valid.clone();
    hidden[0]["archived"] = json!(true);
    assert!(!has_usable_recents(&hidden));
}

#[test]
fn history_has_one_direction_contract() {
    let history = normalize_history(&json!({ "messages": [
        { "id": "1", "fromMe": true, "media": { "mimetype": "image/png" } },
        { "id": "2", "direction": "incoming" },
    ] }));
    assert_eq!(history[0]["direction"], "outgoing");
    assert_eq!(history[0]["metadata"], json!({ "media": { "mimetype": "image/png" } }));
    assert_eq!(history[1]["direction"], "incoming");
    assert!(history[1].get("metadata").is_none());
}

#[test]
fn attachments_must_be_matching_base64_data_urls() {
    let good = normalize_attachment(&json!({ "name": "a/b:c.pdf", "mime": "application/pdf", "dataUrl": "data:application/pdf;base64,QUJDRA==" })).unwrap();
    assert_eq!(good.name, "a-b-c.pdf");
    assert_eq!(good.bytes, 4);
    assert!(normalize_attachment(&json!({ "mime": "image/png", "dataUrl": "data:application/pdf;base64,QUJD" })).is_none());
    assert!(normalize_attachment(&json!({ "mime": "image/png", "dataUrl": "data:image/png;base64,<script>" })).is_none());
    assert_eq!(normalize_attachment(&json!({ "dataUrl": "data:application/octet-stream;base64,QQ==" })).unwrap().name, "Attachment");
}

struct Fixture {
    whatsapp: WhatsApp,
    approvals: Arc<ApprovalService>,
    http: Arc<FakeHttp>,
    _state: tempfile::TempDir,
}

fn fixture(status: &'static str) -> Fixture {
    let state = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(state.path().join(".openwa/data")).unwrap();
    std::fs::write(state.path().join(".openwa/data/.api-key"), "key").unwrap();
    let http = FakeHttp::new(move |request| {
        let path = request.url.trim_start_matches("http://openwa.test");
        let json = |value: Value| Ok(HttpResponse { status: 200, body: value.to_string().into_bytes() });
        match path {
            "/api/sessions" => json(json!([{ "id": "s 1", "name": "habibi", "status": status, "engineLoaded": true }])),
            path if path.starts_with("/api/sessions/s%201/chats") => {
                json(json!([{ "id": "1@c.us", "name": "Alex", "timestamp": 1 }, { "id": "1@c.us", "name": "Alex", "timestamp": 2, "lastMessage": "hi" }]))
            }
            path if path.starts_with("/api/sessions/s%201/contacts?") => {
                json(json!([{ "id": "1@c.us", "name": "Alex" }, { "id": "2@c.us", "pushName": "Sam" }]))
            }
            path if path.contains("/history?") => Err(HttpError::Connect),
            path if path.starts_with("/api/sessions/s%201/messages?chatId=1%40c.us") => json(json!([{ "id": "m", "fromMe": false }])),
            path if path.contains("/messages/send-") => json(json!({ "id": "sent" })),
            path if path.contains("profile-pictures") => json(json!({ "pictures": { "1@c.us": "https://example.test/a.jpg" } })),
            _ => Ok(HttpResponse { status: 404, body: b"{}".to_vec() }),
        }
    });
    let client = OpenwaClient::with_options(state.path().to_path_buf(), http.clone(), "http://openwa.test", Duration::from_secs(45));
    let approvals = Arc::new(ApprovalService::default());
    let whatsapp = WhatsApp::new(state.path().join(".habibi"), client, approvals.clone()).without_settle_delay();
    Fixture { whatsapp, approvals, http, _state: state }
}

async fn call(whatsapp: &WhatsApp, request: ApiRequest) -> Value {
    whatsapp.handle(&request).await.unwrap().json_value().unwrap()
}

#[tokio::test]
async fn sends_need_a_fresh_approval_bound_to_the_exact_message() {
    let f = fixture("ready");
    let body = json!({ "chatId": "1@c.us", "text": "  hello  " });
    let unapproved = call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &body)).await;
    assert_eq!(unapproved["error"], "Sending needs explicit approval");
    let approval = f.approvals.issue("whatsapp.send", json!({ "chatId": "1@c.us", "text": "hello", "attachments": [] }));
    let mut tampered = body.clone();
    tampered["text"] = json!("goodbye");
    tampered["approvalToken"] = json!(approval.token);
    assert_eq!(call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &tampered)).await["ok"], false);
    assert!(!f.http.urls().iter().any(|url| url.contains("send-")), "nothing was sent without approval");

    let approval = f.approvals.issue("whatsapp.send", json!({ "chatId": "1@c.us", "text": "hello", "attachments": [] }));
    let mut approved = body.clone();
    approved["approvalToken"] = json!(approval.token);
    let sent = call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &approved)).await;
    assert_eq!(sent, json!({ "ok": true, "message": { "id": "sent" }, "sent": [{ "id": "sent" }] }));
    let request = f.http.requests.lock().unwrap().iter().find(|request| request.url.contains("send-text")).cloned().unwrap();
    let payload: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
    assert_eq!(payload, json!({ "chatId": "1@c.us", "text": "hello" }));
    assert_eq!(call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &approved)).await["ok"], false, "tokens are single-use");
}

#[tokio::test]
async fn attachments_are_sent_as_documents_with_the_caption_on_the_first() {
    let f = fixture("ready");
    let attachment = json!({ "name": "r.pdf", "mime": "application/pdf", "dataUrl": "data:application/pdf;base64,QUJD" });
    let approval = f.approvals.issue(
        "whatsapp.send",
        json!({ "chatId": "1@c.us", "text": "see", "attachments": [{ "name": "r.pdf", "mime": "application/pdf", "bytes": 3 }, { "name": "r.pdf", "mime": "application/pdf", "bytes": 3 }] }),
    );
    let body = json!({ "chatId": "1@c.us", "text": "see", "attachments": [attachment, attachment], "approvalToken": approval.token });
    let sent = call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &body)).await;
    assert_eq!(sent["sent"].as_array().unwrap().len(), 2);
    let documents: Vec<Value> = f
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.url.contains("send-document"))
        .map(|request| serde_json::from_slice(request.body.as_deref().unwrap()).unwrap())
        .collect();
    assert_eq!(documents[0], json!({ "chatId": "1@c.us", "base64": "QUJD", "mimetype": "application/pdf", "filename": "r.pdf", "caption": "see" }));
    assert!(documents[1].get("caption").is_none());
    assert!(!f.http.urls().iter().any(|url| url.contains("send-text")));

    let invalid = json!({ "chatId": "1@c.us", "attachments": [attachment, { "dataUrl": "nope" }] });
    assert_eq!(call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &invalid)).await["error"], "One or more attachments are invalid");
    let six = json!({ "chatId": "1@c.us", "attachments": vec![attachment.clone(); 6] });
    assert_eq!(call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &six)).await["error"], "One or more attachments are invalid");
    assert_eq!(call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &json!({ "chatId": "1@c.us" }))).await["error"], "Invalid message");
    let long = json!({ "chatId": "1@c.us", "text": "x".repeat(4097) });
    assert_eq!(call(&f.whatsapp, ApiRequest::post("/api/whatsapp/send", &long)).await["error"], "Invalid message");
    let huge = ApiRequest::new(Method::Post, "/api/whatsapp/send", vec![b' '; MAX_SEND_BODY_BYTES + 1]);
    assert_eq!(call(&f.whatsapp, huge).await["error"], "Request body too large");
}

#[tokio::test]
async fn reads_require_a_ready_session() {
    let f = fixture("qr_ready");
    assert_eq!(call(&f.whatsapp, ApiRequest::get("/api/whatsapp/chats")).await["error"], "WhatsApp is not connected");
    assert_eq!(call(&f.whatsapp, ApiRequest::get("/api/whatsapp/history")).await["error"], "Missing chat");
    let status = call(&f.whatsapp, ApiRequest::get("/api/openwa/status")).await;
    assert_eq!(status["ok"], true);
    assert_eq!(status["service"], true);
    assert_eq!(status["qrCode"], Value::Null);
}

#[tokio::test]
async fn chats_contacts_and_history_are_normalized_and_cached() {
    let f = fixture("ready");
    let chats = call(&f.whatsapp, ApiRequest::get("/api/whatsapp/chats")).await;
    assert_eq!(chats["chats"], json!([{ "id": "1@c.us", "name": "Alex", "timestamp": 2, "lastMessage": "hi", "unreadCount": 0 }]));
    assert_eq!(chats["source"], "openwa");
    assert_eq!(chats["cached"], false);
    assert_eq!(call(&f.whatsapp, ApiRequest::get("/api/whatsapp/chats")).await["cached"], true);
    let contacts = call(&f.whatsapp, ApiRequest::get("/api/whatsapp/contacts?q=%20SAM%20")).await;
    assert_eq!(contacts["contacts"], json!([{ "id": "2@c.us", "pushName": "Sam" }]));
    let history = call(&f.whatsapp, ApiRequest::get("/api/whatsapp/history?chatId=1%40c.us")).await;
    assert_eq!(history["messages"], json!([{ "id": "m", "fromMe": false, "direction": "incoming" }]));
    for _ in 0..50 {
        if f.whatsapp.shared.pictures.lock().unwrap().contains_key("1@c.us") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pictures = call(&f.whatsapp, ApiRequest::get("/api/whatsapp/profile-pictures?ids=1@c.us,2@c.us")).await;
    assert_eq!(pictures["pictures"]["pictures"], json!({ "1@c.us": "https://example.test/a.jpg", "2@c.us": null }));
    assert!(f.whatsapp.handle(&ApiRequest::get("/api/whatsapp/unknown")).await.is_none());
}

#[tokio::test]
async fn a_usable_recents_snapshot_is_kept_private_and_used_when_live_rows_are_thin() {
    let f = fixture("ready");
    let rows: Vec<Value> = (1..=5).map(|index| json!({ "id": format!("{index}@c.us"), "timestamp": index })).collect();
    f.whatsapp.save_snapshot(&rows);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&f.whatsapp.snapshot_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let chats = call(&f.whatsapp, ApiRequest::get("/api/whatsapp/chats")).await;
    assert_eq!(chats["source"], "snapshot");
    assert_eq!(chats["chats"].as_array().unwrap().len(), 5);
}
