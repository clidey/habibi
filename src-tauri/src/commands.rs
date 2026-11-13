//! IPC commands. The capability files limit which windows may call each one;
//! every command also checks the calling webview's label, so a command can
//! never be reached from a window it was not meant for.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use habibi_core::{ApiRequest, ApiResponse, Method};
use habibi_desktop::pty::PtySession;
use serde_json::{Value, json};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{State, Webview};

use crate::overlays;
use crate::shell::{FOCUS, LAUNCHER, Shell, TELEPROMPTER};

type Shared<'a> = State<'a, Arc<Shell>>;

fn require(webview: &Webview, label: &str) -> Result<(), String> {
    if webview.label() == label { Ok(()) } else { Err("Not allowed".into()) }
}

/// `[u32 BE meta length][meta JSON][body]` — status and headers plus the
/// exact response bytes, so binary routes survive the bridge unchanged.
pub fn frame(response: &ApiResponse) -> Vec<u8> {
    let meta = json!({ "status": response.status, "headers": response.headers });
    let meta = serde_json::to_vec(&meta).unwrap_or_else(|_| b"{\"status\":500,\"headers\":[]}".to_vec());
    let mut out = Vec::with_capacity(4 + meta.len() + response.body.len());
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(&response.body);
    out
}

fn header(request: &Request<'_>, name: &str) -> Option<String> {
    request.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string)
}

fn body_bytes(body: &InvokeBody) -> Vec<u8> {
    match body {
        InvokeBody::Raw(bytes) => bytes.clone(),
        // The postMessage IPC fallback delivers raw bodies as a number array.
        InvokeBody::Json(Value::Array(items)) => {
            items.iter().filter_map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok())).collect()
        }
        InvokeBody::Json(Value::Null) => Vec::new(),
        InvokeBody::Json(value) => serde_json::to_vec(value).unwrap_or_default(),
    }
}

/// `fetch('/api/…')` from the launcher, routed to `habibi_server`.
#[tauri::command]
pub async fn api(webview: Webview, request: Request<'_>, shell: Shared<'_>) -> Result<Response, String> {
    require(&webview, LAUNCHER)?;
    let method = header(&request, "x-habibi-method").unwrap_or_else(|| "GET".into());
    let path = header(&request, "x-habibi-path").unwrap_or_default();
    if !path.starts_with("/api/") {
        return Ok(Response::new(frame(&ApiResponse::not_found())));
    }
    let api_request = ApiRequest::new(Method::parse(&method), &path, body_bytes(request.body()));
    let response = shell.server.handle(&api_request).await;
    log_api(&api_request, &response);
    Ok(Response::new(frame(&response)))
}

/// `HABIBI_API_LOG=1` prints one line per `/api` call (method, path without
/// the query string, status, `ok`) to stderr for development. Never bodies,
/// queries or headers, which can carry personal data.
fn log_api(request: &ApiRequest, response: &ApiResponse) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| std::env::var_os("HABIBI_API_LOG").is_some_and(|value| value == "1")) {
        return;
    }
    let ok = response.json_value().and_then(|value| value.get("ok").and_then(Value::as_bool));
    eprintln!("[api] {:?} {} -> {} ok={ok:?}", request.method, request.path, response.status);
}

/// `habibiNative.postMessage(message)` from the launcher. Deliberately not
/// `async`: Tauri runs it on the main thread, in the order the page posted.
#[tauri::command]
pub fn native_message(webview: Webview, message: Value, shell: Shared<'_>) -> Result<(), String> {
    require(&webview, LAUNCHER)?;
    crate::bridge::handle(shell.inner().clone(), message);
    Ok(())
}

/// `teleprompterOverlay` / `focusOverlay` messages from the overlay pages.
#[tauri::command]
pub fn overlay_message(webview: Webview, message: Value, shell: Shared<'_>) -> Result<(), String> {
    let action = message.get("action").and_then(Value::as_str).unwrap_or("");
    match webview.label() {
        TELEPROMPTER => overlays::teleprompter_overlay_action(shell.inner(), action),
        FOCUS => overlays::focus_overlay_action(shell.inner(), action),
        _ => return Err("Not allowed".into()),
    }
    Ok(())
}

/// Start an agent terminal. Output, exit and errors arrive on `on_event` as
/// the `{ type: 'data' | 'exit' | 'error' | 'started' }` messages the
/// WebSocket used to send.
#[tauri::command]
pub fn pty_start(webview: Webview, message: Value, on_event: Channel<Value>, shell: Shared<'_>) -> Result<u32, String> {
    require(&webview, LAUNCHER)?;
    let channel = on_event.clone();
    let sink: habibi_desktop::pty::Sink = Arc::new(move |value| {
        let _ = channel.send(value);
    });
    match PtySession::start(&message, &shell.paths.home, sink) {
        Ok(session) => {
            let id = shell.next_pty.fetch_add(1, Ordering::SeqCst);
            shell.ptys.lock().unwrap_or_else(|e| e.into_inner()).insert(id, session);
            Ok(id)
        }
        Err(error) => {
            let _ = on_event.send(json!({ "type": "error", "message": error }));
            Err(error.into())
        }
    }
}

#[tauri::command]
pub fn pty_input(webview: Webview, id: u32, data: Value, shell: Shared<'_>) -> Result<(), String> {
    require(&webview, LAUNCHER)?;
    // Written straight into a live shell, so only strings are accepted.
    let Some(data) = data.as_str() else { return Err("Invalid terminal message".into()) };
    if let Some(session) = shell.ptys.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        session.write(data);
    }
    Ok(())
}

/// `Number(value)` for the shapes the UI sends.
fn number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

#[tauri::command]
pub fn pty_resize(webview: Webview, id: u32, cols: Value, rows: Value, shell: Shared<'_>) -> Result<(), String> {
    require(&webview, LAUNCHER)?;
    if let Some(session) = shell.ptys.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        session.resize(number(&cols), number(&rows));
    }
    Ok(())
}

#[tauri::command]
pub fn pty_close(webview: Webview, id: u32, shell: Shared<'_>) -> Result<(), String> {
    require(&webview, LAUNCHER)?;
    let session = shell.ptys.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if let Some(session) = session {
        session.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_status_headers_and_binary_body() {
        let response = ApiResponse::bytes("image/png", vec![0, 159, 146, 150, 255]);
        let framed = frame(&response);
        let length = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        let meta: Value = serde_json::from_slice(&framed[4..4 + length]).unwrap();
        assert_eq!(meta["status"], 200);
        assert_eq!(meta["headers"][0], json!(["Content-Type", "image/png"]));
        assert_eq!(&framed[4 + length..], &[0, 159, 146, 150, 255]);
    }

    #[test]
    fn coerces_numbers_like_javascript() {
        assert_eq!(number(&json!(80)), 80.0);
        assert_eq!(number(&json!("24")), 24.0);
        assert!(number(&json!(null)).is_nan());
        assert!(number(&json!("x")).is_nan());
    }

    #[test]
    fn raw_bodies_survive_both_ipc_transports() {
        assert_eq!(body_bytes(&InvokeBody::Raw(vec![1, 2, 255])), vec![1, 2, 255]);
        assert_eq!(body_bytes(&InvokeBody::Json(json!([1, 2, 255]))), vec![1, 2, 255]);
        assert!(body_bytes(&InvokeBody::Json(Value::Null)).is_empty());
    }
}
