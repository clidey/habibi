//! `window.webkit.messageHandlers.habibiNative.postMessage(...)` from the
//! launcher, ported from `HabibiApp.swift`'s `userContentController` and the
//! handlers it delegated to (`DailyUtilities`, `NotesExport`, the
//! teleprompter). Only the launcher window can reach this (see
//! `capabilities/launcher.json` and the label check in `commands.rs`).
//!
//! Messages are handled in the order the page sent them, on the main thread,
//! as WebKit delivered them to the Swift app (`permissionFlow` on/off pairs
//! depend on it). Work that waits on a backend service is spawned.

use std::sync::Arc;

use base64::Engine;
use habibi_desktop::images;
use habibi_desktop::shortcut::LauncherShortcut;
use serde_json::{Value, json};

use crate::shell::{LAUNCHER, Shell};
use crate::{login, overlays, shortcut, tray, updates};

const MAX_NOTE_UTF16: usize = 300_000;

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub fn handle(shell: Arc<Shell>, message: Value) {
    if message.as_str() == Some("dismiss") {
        shell.hide_launcher_and_reset();
        return;
    }
    let Some(kind) = message.get("type").and_then(Value::as_str).map(str::to_string) else { return };
    match kind.as_str() {
        "quitApp" => crate::quit(&shell),
        "dailyUtility" => daily_utility(shell, message),
        "copyNoteText" | "exportNote" => notes(&shell, &kind, &message),
        "copyEmoji" => {
            let emoji = message.get("emoji").and_then(Value::as_str).unwrap_or("");
            let success = habibi_desktop::valid_emoji(emoji) && {
                let mut clipboard = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner());
                clipboard.board().write_text(emoji)
            };
            shell.call_launcher("__habibiEmojiCopyResult", &Value::Bool(success));
        }
        "teleprompter" => {
            if !overlays::teleprompter_message(&shell, &message) {
                shell.call_launcher(
                    "__habibiTeleprompterState",
                    &json!({ "error": "Paste a script of up to 100,000 characters to start." }),
                );
            } else if message.get("action").and_then(Value::as_str) == Some("start") {
                shell.hide_launcher();
            }
        }
        "clipboardImage" => {
            let for_mail = message.get("context").and_then(Value::as_str) == Some("mail");
            clipboard_image(shell, for_mail);
        }
        "menuBarIconState" => tray::send_state(&shell),
        "menuBarIcon" => {
            if let Some(enabled) = message.get("enabled").and_then(Value::as_bool) {
                tray::set_visible(&shell, enabled);
            }
        }
        "launchAtLoginState" => login::send_state(&shell, None),
        "launchAtLogin" => {
            if let Some(enabled) = message.get("enabled").and_then(Value::as_bool) {
                login::set(&shell, enabled);
            }
        }
        "checkForUpdate" => updates::check(shell.clone()),
        "installUpdate" => updates::install(shell.clone()),
        "prepareNativeFileDrag" => prepare_file_drag(&shell, &message),
        "nativeFileDrag" => start_file_drag(&shell, &message),
        "lockScreen" => lock_screen(&shell),
        "permissionFlow" => {
            // The services may trigger OS privacy prompts while investigating
            // files. Keep the current launcher route behind that prompt.
            if message.get("active").and_then(Value::as_bool) == Some(true) {
                shell.begin_permission_request();
            } else {
                shell.end_permission_request();
            }
        }
        "windowDrag" => {
            if let Some(window) = shell.window(LAUNCHER) {
                let _ = window.start_dragging();
            }
        }
        // Keep the old bridge message valid during upgrades from an already-open UI.
        "settings" => {
            if let Some(name) = message.get("shortcut").and_then(Value::as_str) {
                shell.prefs.set("launcherShortcut", Value::String(name.into()));
                shell.prefs.remove(&["launcherShortcutKeyCode", "launcherShortcutModifiers", "launcherShortcutLabel"]);
                let next = LauncherShortcut::load(&shell.prefs);
                shortcut::register(&shell, next);
            }
        }
        "shortcutCheck" | "shortcutSave" => {
            let (Some(key_code), Some(modifiers)) =
                (message.get("keyCode").and_then(Value::as_u64), message.get("modifiers").and_then(Value::as_u64))
            else {
                return;
            };
            let (Ok(key_code), Ok(modifiers)) = (u32::try_from(key_code), u32::try_from(modifiers)) else { return };
            let candidate = LauncherShortcut::new(key_code, modifiers);
            if kind == "shortcutCheck" {
                let (available, text) = shortcut::availability(&shell, candidate);
                shell.call_launcher("__habibiShortcutValidation", &json!({ "available": available, "message": text }));
            } else {
                let label = message
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|label| !label.is_empty() && utf16_len(label) <= 64)
                    .map(str::to_string)
                    .unwrap_or_else(|| candidate.default_label(cfg!(target_os = "macos")));
                shortcut::save(&shell, candidate, &label);
            }
        }
        // Backend-owned: calendar, contacts, the WhatsApp component, and
        // anything else a service claims.
        _ => {
            tauri::async_runtime::spawn(async move { backend(shell, &kind, message).await });
        }
    }
}

/// The callback the Swift app used to answer each backend-owned message.
fn backend_callback(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "calendarAccess" => "__habibiNativeCalendarAccess",
        "calendarEvents" => "__habibiNativeCalendarEvents",
        "contacts" => "__habibiNativeContacts",
        "whatsappComponent" => "__habibiWhatsAppComponent",
        _ => return None,
    })
}

/// What the UI sees while no service owns the message yet.
fn backend_unavailable(kind: &str) -> Value {
    match kind {
        "calendarAccess" => json!({ "ok": false, "reason": "unavailable", "message": "Calendar access is not available yet." }),
        "calendarEvents" => json!({ "ok": false, "events": [], "reason": "unavailable" }),
        "contacts" => json!({ "ok": false, "contacts": [], "reason": "unavailable" }),
        "whatsappComponent" => json!({ "state": "failed", "ok": false, "error": "WhatsApp support is not available in this build." }),
        _ => Value::Null,
    }
}

async fn backend(shell: Arc<Shell>, kind: &str, message: Value) {
    let privacy = matches!(kind, "calendarAccess" | "contacts");
    if privacy {
        // macOS privacy prompts move focus away from the launcher.
        shell.begin_permission_request();
    }
    let reply = shell.server.native_message(&message).await;
    if privacy {
        shell.end_permission_request();
    }
    let Some(callback) = backend_callback(kind) else {
        if reply.is_none() {
            tracing::debug!("unhandled native message type");
        }
        return;
    };
    shell.call_launcher(callback, &reply.unwrap_or_else(|| backend_unavailable(kind)));
}

fn daily_utility(shell: Arc<Shell>, message: Value) {
    let (Some(request_id), Some(action)) = (
        message.get("requestId").and_then(Value::as_str).filter(|id| utf16_len(id) <= 100).map(str::to_string),
        message.get("action").and_then(Value::as_str).map(str::to_string),
    ) else {
        return;
    };
    let reply = |result: Value| daily_reply(&shell, &request_id, result);
    let id = message.get("id").and_then(Value::as_str).map(str::to_string);
    let changed = |shell: &Shell| {
        if shell.launcher_visible() {
            shell.call_launcher("__habibiDailyChanged", &Value::String("clipboard".into()));
        }
    };
    match action.as_str() {
        "clipboard.state" => {
            let snapshot = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner()).snapshot();
            reply(snapshot);
        }
        "clipboard.enable" => {
            let enabled = message.get("enabled").and_then(Value::as_bool) == Some(true);
            let snapshot = {
                let mut clipboard = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner());
                clipboard.set_enabled(enabled);
                clipboard.snapshot()
            };
            changed(&shell);
            reply(snapshot);
        }
        "clipboard.copy" => {
            let ok = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner()).copy(id.as_deref().unwrap_or(""));
            reply(json!({ "ok": ok }));
        }
        "clipboard.remove" => {
            let snapshot = {
                let mut clipboard = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner());
                clipboard.remove(id.as_deref());
                clipboard.snapshot()
            };
            changed(&shell);
            reply(snapshot);
        }
        "clipboard.pin" => {
            let pinned = message.get("pinned").and_then(Value::as_bool) == Some(true);
            let result = {
                let mut clipboard = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner());
                if clipboard.pin(id.as_deref().unwrap_or(""), pinned) {
                    Some(clipboard.snapshot())
                } else {
                    None
                }
            };
            match result {
                Some(snapshot) => {
                    changed(&shell);
                    reply(snapshot);
                }
                None => reply(json!({ "ok": false, "error": "You can pin up to 20 clipboard items." })),
            }
        }
        "focus" => {
            let value = message.get("value").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
            reply(overlays::focus_message(&shell, &value));
        }
        action if action.starts_with("reminders.") => {
            let access = action == "reminders.access";
            let shell = shell.clone();
            tauri::async_runtime::spawn(async move {
                if access {
                    shell.begin_permission_request();
                }
                let result = shell.server.native_message(&message).await;
                if access {
                    shell.end_permission_request();
                }
                daily_reply(&shell, &request_id, result.unwrap_or(Value::Null));
            });
        }
        _ => reply(Value::Null),
    }
}

/// `window.__habibiDailyResult({ ...result, requestId })`, like the Swift `reply`.
fn daily_reply(shell: &Shell, request_id: &str, mut result: Value) {
    if !result.is_object() {
        result = json!({ "ok": false, "error": "This utility action is unavailable." });
    }
    result["requestId"] = Value::String(request_id.into());
    shell.call_launcher("__habibiDailyResult", &result);
}

fn notes(shell: &Arc<Shell>, kind: &str, message: &Value) {
    let Some(text) = message.get("text").and_then(Value::as_str).filter(|text| utf16_len(text) <= MAX_NOTE_UTF16) else {
        return;
    };
    if kind == "copyNoteText" {
        let success = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner()).board().write_text(text);
        shell.call_launcher("__habibiNotesCopyResult", &Value::Bool(success));
        return;
    }
    let proposed = message.get("filename").and_then(Value::as_str).unwrap_or("Note.md");
    let name: String = std::path::Path::new(proposed)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Note.md")
        .chars()
        .take(160)
        .collect();
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = shell.app.dialog().file().set_title("Export Markdown note").add_filter("Markdown", &["md"]).set_file_name(name);
    if let Some(window) = shell.window(LAUNCHER) {
        dialog = dialog.set_parent(&window);
    }
    let text = text.to_string();
    let callback_shell = shell.clone();
    shell.begin_permission_request();
    dialog.save_file(move |path| {
        callback_shell.end_permission_request();
        let Some(path) = path.and_then(|path| path.into_path().ok()) else {
            callback_shell.call_launcher("__habibiNotesExportResult", &json!({ "ok": false, "cancelled": true }));
            return;
        };
        let success = std::fs::write(&path, text.as_bytes()).is_ok();
        callback_shell.call_launcher("__habibiNotesExportResult", &json!({ "ok": success }));
    });
}

/// The OS clipboard does not consistently expose screenshot bytes through
/// the webview's DataTransfer, so read it natively and hand back a PNG data
/// URL to this local page only. Conversion can take seconds; do it off the
/// UI thread so the page's own paste handling does not time out.
fn clipboard_image(shell: Arc<Shell>, for_mail: bool) {
    tauri::async_runtime::spawn_blocking(move || {
        let png = {
            let mut clipboard = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner());
            clipboard.board().image_png()
        };
        let mut payload = json!({ "ok": false });
        if let Some(png) = png.filter(|png| png.len() <= images::MAXIMUM_BYTES) {
            payload = json!({
                "ok": true,
                "dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)),
            });
            if for_mail && let Some(path) = images::store_paste(&shell.paths.state_root, &png) {
                payload["path"] = Value::String(path.to_string_lossy().into_owned());
            }
        }
        shell.call_launcher("__habibiReceiveNativeClipboardImage", &payload);
    });
}

/// The path a drag message names, if it may leave the launcher as a file.
fn drag_path(shell: &Shell, message: &Value) -> Option<std::path::PathBuf> {
    let requested = message.get("path").and_then(Value::as_str)?;
    habibi_desktop::drag::draggable_path(&shell.paths.home, requested)
}

/// pointerdown on a file result. On macOS this arms the drag the AppKit
/// event monitor starts on the press's first real drag event; elsewhere the
/// drag starts from `nativeFileDrag`.
fn prepare_file_drag(shell: &Shell, message: &Value) {
    #[cfg(target_os = "macos")]
    match drag_path(shell, message) {
        Some(path) => habibi_desktop::drag::macos::prepare(path),
        None => habibi_desktop::drag::macos::cancel(),
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (shell, message);
}

/// The page's `dragstart` on a file result (it cancels the HTML drag).
fn start_file_drag(shell: &Arc<Shell>, message: &Value) {
    // macOS already began the session from the mouse event (or the press
    // was not armed, and the page keeps its normal behaviour).
    #[cfg(target_os = "macos")]
    let _ = (shell, message);
    #[cfg(target_os = "windows")]
    {
        let Some(path) = drag_path(shell, message) else {
            shell.call_launcher("__habibiNativeFileDragFailed", &Value::Null);
            return;
        };
        // Run the modal OLE drag from the event loop, not inside the
        // WebView2 message callback that delivered this message.
        let drag_shell = shell.clone();
        let _ = shell.app.run_on_main_thread(move || {
            let Some(hwnd) = drag_shell.window(LAUNCHER).and_then(|window| window.hwnd().ok()) else { return };
            drag_shell.call_launcher("__habibiNativeFileDragStarted", &Value::Null);
            if !habibi_desktop::drag::windows::drag_file(hwnd.0 as isize, &path) {
                drag_shell.call_launcher("__habibiNativeFileDragFailed", &Value::Null);
            }
            drag_shell.call_launcher("__habibiNativeFileDragEnded", &Value::Null);
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // `__habibiNativeFileDrag` is false here, so the page never asks.
        let _ = message;
        shell.call_launcher("__habibiNativeFileDragFailed", &Value::Null);
    }
}

fn lock_screen(shell: &Arc<Shell>) {
    let shell = shell.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ok = habibi_platform::system::run(habibi_platform::system::SystemAction::Lock).is_ok();
        shell.call_launcher("__habibiNativeLockResult", &json!({ "ok": ok }));
    });
}

/// Whether the launcher page should treat the clipboard as holding an image
/// (the ⌘V capture on macOS).
#[cfg(target_os = "macos")]
pub fn clipboard_has_image(shell: &Shell) -> bool {
    shell.clipboard.lock().unwrap_or_else(|e| e.into_inner()).board().has_image()
}
