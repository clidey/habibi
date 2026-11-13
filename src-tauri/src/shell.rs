//! Shared shell state, the launcher window and native → UI callbacks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use habibi_core::Paths;
use habibi_desktop::clipboard::ClipboardHistory;
use habibi_desktop::focus::FocusTimer;
use habibi_desktop::prefs::Preferences;
use habibi_desktop::pty::PtySession;
use habibi_desktop::shortcut::LauncherShortcut;
use habibi_desktop::teleprompter::Teleprompter;
use habibi_server::Server;
use serde_json::{Value, json};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};

use crate::legacy::LegacySeed;
use crate::protocol::SCHEME;

pub const LAUNCHER: &str = "launcher";
pub const TELEPROMPTER: &str = "teleprompter";
pub const FOCUS: &str = "focus";

const LAUNCHER_INIT: &str = include_str!("../js/launcher-init.js");

pub struct Shell {
    pub app: AppHandle,
    pub server: Arc<Server>,
    pub paths: Paths,
    pub prefs: Arc<Preferences>,
    pub clipboard: Mutex<ClipboardHistory>,
    pub focus: Mutex<FocusTimer>,
    pub prompter: Mutex<Teleprompter>,
    pub ptys: Mutex<HashMap<u32, PtySession>>,
    pub next_pty: AtomicU32,
    /// A privacy prompt, file dialog or long file request is open: keep the
    /// launcher on screen when it loses focus.
    pub permission_in_flight: AtomicBool,
    pub shortcut: Mutex<LauncherShortcut>,
    pub shortcut_registered: AtomicBool,
    pub announced_shortcut_failure: AtomicBool,
    /// Debounces shortcut re-registration after wake.
    pub shortcut_repair: AtomicU64,
    pub update: Mutex<Option<tauri_plugin_updater::Update>>,
    pub clock_generation: AtomicU64,
    pub focus_overlay_ready: AtomicBool,
    shown_at: Mutex<Option<Instant>>,
}

/// `habibi://localhost/<path>`; on Windows custom schemes are served as
/// `http://habibi.localhost/<path>`.
pub fn app_url(path: &str) -> tauri::Url {
    let base = if cfg!(windows) { format!("http://{SCHEME}.localhost") } else { format!("{SCHEME}://localhost") };
    tauri::Url::parse(&format!("{base}{path}")).expect("static app URL")
}

/// True for URLs served by the app itself.
pub fn is_app_url(url: &tauri::Url) -> bool {
    if cfg!(windows) {
        matches!(url.scheme(), "http" | "https") && url.host_str() == Some(&format!("{SCHEME}.localhost"))
    } else {
        url.scheme() == SCHEME && url.host_str() == Some("localhost")
    }
}

/// Open http(s)/mailto links outside the app, as the Swift app's navigation
/// delegate did; any other scheme is dropped.
pub fn open_external(app: &AppHandle, url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// `window.<callback>?.(<json>)`. Callback names are fixed identifiers in
/// this crate and payloads are always JSON-encoded, never interpolated text.
pub fn js_call(callback: &str, payload: &Value) -> String {
    debug_assert!(callback.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    format!("window.{callback}?.({payload})")
}

impl Shell {
    pub fn new(app: AppHandle, server: Arc<Server>, paths: Paths, prefs: Arc<Preferences>) -> Self {
        let board = Box::new(habibi_desktop::clipboard::SystemBoard::new());
        let clipboard = ClipboardHistory::new(&paths.state_root, board, prefs.clone());
        let focus = FocusTimer::load(&prefs);
        let shortcut = LauncherShortcut::load(&prefs);
        Self {
            app,
            server,
            paths,
            clipboard: Mutex::new(clipboard),
            focus: Mutex::new(focus),
            prompter: Mutex::new(Teleprompter::new(habibi_desktop::speech::available())),
            prefs,
            ptys: Mutex::new(HashMap::new()),
            next_pty: AtomicU32::new(1),
            permission_in_flight: AtomicBool::new(false),
            shortcut: Mutex::new(shortcut),
            shortcut_registered: AtomicBool::new(false),
            announced_shortcut_failure: AtomicBool::new(false),
            shortcut_repair: AtomicU64::new(0),
            update: Mutex::new(None),
            clock_generation: AtomicU64::new(0),
            focus_overlay_ready: AtomicBool::new(false),
            shown_at: Mutex::new(None),
        }
    }

    pub fn window(&self, label: &str) -> Option<WebviewWindow> {
        self.app.get_webview_window(label)
    }

    /// Call a `window.__habibi…` callback in a window, if it exists.
    pub fn call(&self, label: &str, callback: &str, payload: &Value) {
        if let Some(window) = self.window(label) {
            let _ = window.eval(js_call(callback, payload));
        }
    }

    pub fn call_launcher(&self, callback: &str, payload: &Value) {
        self.call(LAUNCHER, callback, payload);
    }

    pub fn launcher_visible(&self) -> bool {
        self.window(LAUNCHER).and_then(|window| window.is_visible().ok()).unwrap_or(false)
    }

    pub fn shortcut_label(&self) -> String {
        let shortcut = *self.shortcut.lock().unwrap_or_else(|e| e.into_inner());
        shortcut.label(&self.prefs)
    }

    // -- launcher ----------------------------------------------------------

    /// `seed` is the legacy `localStorage` import script, if any; it runs
    /// before the bridge and the page (see `legacy.rs`).
    pub fn create_launcher(self: &Arc<Self>, seed: Option<LegacySeed>) -> tauri::Result<WebviewWindow> {
        let init = LAUNCHER_INIT.replace("__HABIBI_PLATFORM__", habibi_platform::os());
        let navigation_app = self.app.clone();
        let popup_app = self.app.clone();
        let page_shell = self.clone();
        let mut builder = WebviewWindowBuilder::new(&self.app, LAUNCHER, WebviewUrl::CustomProtocol(app_url("/index.html")));
        if let Some(seed) = seed {
            builder = builder.initialization_script(seed.script);
            if seed.ephemeral {
                // Development check of the importer: start from empty storage.
                builder = builder.incognito(true);
            }
        }
        let window = builder
            .title("Habibi")
            .inner_size(840.0, 580.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .focused(false)
            .initialization_script(init)
            .on_navigation(move |url| {
                if is_app_url(url) || url.scheme() == "about" {
                    return true;
                }
                open_external(&navigation_app, url);
                false
            })
            .on_new_window(move |url, _| {
                open_external(&popup_app, &url);
                NewWindowResponse::Deny
            })
            .on_page_load(move |_, payload| match payload.event() {
                PageLoadEvent::Started => page_shell.close_all_ptys(),
                PageLoadEvent::Finished => page_shell.launcher_loaded(),
            })
            .build()?;
        #[cfg(target_os = "macos")]
        if let Ok(ns_window) = window.ns_window() {
            // A real NSPanel, like the Swift launcher: it can become key (so
            // Esc and typing reach the webview) without activating Habibi, so
            // the user's app — full-screen or not — stays frontmost.
            if let Err(error) = launcher_panel::convert(&window) {
                tracing::warn!("launcher could not become a panel: {error}");
            }
            let pointer = ns_window as usize;
            let _ = self.app.run_on_main_thread(move || {
                // SAFETY: the pointer came from this live window, and this
                // closure runs on the main thread.
                unsafe {
                    habibi_desktop::macos::configure_panel(pointer as *mut _, habibi_desktop::macos::PanelKind::Launcher);
                    habibi_desktop::macos::round_window(pointer as *mut _, 18.0, false);
                }
            });
            self.install_file_drag(&window);
        }
        #[cfg(any(target_os = "macos", windows))]
        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
        Ok(window)
    }

    /// Native file drags out of the launcher (macOS): an AppKit event monitor
    /// on the launcher's webview reports back to the page.
    #[cfg(target_os = "macos")]
    fn install_file_drag(self: &Arc<Self>, window: &WebviewWindow) {
        use habibi_desktop::drag::DragEvent;
        let shell = Arc::downgrade(self);
        let _ = window.with_webview(move |webview| {
            let callback = move |event: DragEvent| {
                let Some(shell) = shell.upgrade() else { return };
                if crate::shell_log() {
                    eprintln!("[drag] {event:?}");
                }
                let name = match event {
                    DragEvent::Started => "__habibiNativeFileDragStarted",
                    DragEvent::Ended => "__habibiNativeFileDragEnded",
                    DragEvent::Failed => "__habibiNativeFileDragFailed",
                };
                shell.call_launcher(name, &Value::Null);
            };
            // SAFETY: `with_webview` runs this on the main thread with the
            // launcher's live window and WKWebView, which live for the app.
            unsafe { habibi_desktop::drag::macos::install(webview.ns_window(), webview.inner(), callback) };
        });
    }

    /// Mirrors the Swift `didFinish` hook: mark the page as hosted natively and
    /// tell it the launcher shortcut.
    fn launcher_loaded(&self) {
        let shortcut = *self.shortcut.lock().unwrap_or_else(|e| e.into_inner());
        let payload = json!({
            "keyCode": shortcut.key_code,
            "modifiers": shortcut.modifiers,
            "label": shortcut.label(&self.prefs),
        });
        let script = format!(
            "document.documentElement.classList.add('native-host'); document.body.classList.add('native-host'); document.documentElement.dataset.nativePlatform = {platform}; window.__habibiNativeShortcut = {payload}; window.__habibiNativeFileDrag = {drag}; document.body.dataset.nativeShortcutLabel = window.__habibiNativeShortcut.label || '⌥ Space'; document.getElementById('command-input')?.focus()",
            platform = Value::String(habibi_platform::os().into()),
            drag = habibi_desktop::drag::supported(),
        );
        if let Some(window) = self.window(LAUNCHER) {
            let _ = window.eval(script);
        }
    }

    pub fn close_all_ptys(&self) {
        let sessions: Vec<PtySession> = self.ptys.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.kill();
        }
    }

    pub fn toggle_launcher(self: &Arc<Self>) {
        if self.launcher_visible() {
            self.hide_launcher_and_reset();
        } else {
            self.show_launcher();
        }
    }

    pub fn show_launcher(self: &Arc<Self>) {
        let Some(window) = self.window(LAUNCHER) else { return };
        self.position_launcher(&window);
        *self.shown_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        self.focus_launcher(&window);
        #[cfg(all(target_os = "macos", debug_assertions))]
        self.describe_launcher_later();
    }

    /// Show and key the launcher. On macOS `show` makes the non-activating
    /// panel key without activating Habibi; `set_focus` would also activate
    /// the app (and leave a full-screen Space), so it is not used there.
    fn focus_launcher(&self, window: &WebviewWindow) {
        let _ = window.show();
        #[cfg(not(target_os = "macos"))]
        let _ = window.set_focus();
        // `show` orders the panel in but does not make it key, so Esc and
        // typing would still go to the frontmost app. Make it key explicitly
        // (it stays non-activating: the user's app keeps the menu bar).
        #[cfg(target_os = "macos")]
        launcher_panel::make_key(&self.app);
        let _ = window.eval("document.getElementById('command-input')?.focus()");
    }

    /// `HABIBI_SHELL_LOG=1` (debug builds): log the launcher's panel state
    /// shortly after it is shown.
    #[cfg(all(target_os = "macos", debug_assertions))]
    fn describe_launcher_later(self: &Arc<Self>) {
        if !crate::shell_log() {
            return;
        }
        let shell = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let Some(window) = shell.window(LAUNCHER) else { return };
            let Ok(ns_window) = window.ns_window() else { return };
            let pointer = ns_window as usize;
            let _ = shell.app.run_on_main_thread(move || {
                // SAFETY: live launcher window, on the main thread.
                eprintln!("[panel] launcher {}", unsafe { habibi_desktop::macos::describe_window(pointer as *mut _) });
            });
        });
    }

    /// Keep the window and page warm for instant reopening, but clear the
    /// transient route/search state before it leaves the screen.
    pub fn hide_launcher_and_reset(self: &Arc<Self>) {
        let Some(window) = self.window(LAUNCHER) else { return };
        let _ = window.eval("window.__habibiResetLauncher?.()");
        let hide = window.clone();
        // Let the reset run before the page is hidden (WebKit throttles hidden pages).
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            let _ = hide.hide();
        });
    }

    /// Hide without resetting (the teleprompter takes over the screen).
    pub fn hide_launcher(&self) {
        if let Some(window) = self.window(LAUNCHER) {
            let _ = window.hide();
        }
    }

    /// Behave like a launcher: moving focus elsewhere dismisses it, unless a
    /// privacy prompt or dialog that Habibi opened took the focus.
    pub fn launcher_blurred(self: &Arc<Self>) {
        if self.permission_in_flight.load(Ordering::SeqCst) || !self.launcher_visible() {
            return;
        }
        // A tray click or the shortcut can deliver a stale blur right after showing.
        if let Some(shown) = *self.shown_at.lock().unwrap_or_else(|e| e.into_inner())
            && shown.elapsed() < Duration::from_millis(350)
        {
            return;
        }
        self.hide_launcher_and_reset();
    }

    pub fn begin_permission_request(&self) {
        self.permission_in_flight.store(true, Ordering::SeqCst);
    }

    pub fn end_permission_request(self: &Arc<Self>) {
        self.permission_in_flight.store(false, Ordering::SeqCst);
        if self.launcher_visible()
            && let Some(window) = self.window(LAUNCHER)
        {
            self.focus_launcher(&window);
        }
    }

    /// Size for the monitor under the pointer and place it: the saved spot
    /// when it was saved on that monitor at this size, else centred.
    fn position_launcher(&self, window: &WebviewWindow) {
        let monitor = self
            .app
            .cursor_position()
            .ok()
            .and_then(|cursor| self.app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| self.app.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let (area_x, area_y) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
        let (area_w, area_h) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
        let width = 840f64.min(area_w - 80.0).max(320.0).round();
        let height = 580f64.min(area_h - 96.0).max(240.0).round();
        let _ = window.set_size(LogicalSize::new(width, height));
        let name = monitor.name().cloned().unwrap_or_default();
        if let Some(Value::Object(saved)) = self.prefs.get("launcherPosition") {
            let get = |key: &str| saved.get(key).and_then(Value::as_f64);
            if saved.get("monitor").and_then(Value::as_str) == Some(name.as_str())
                && get("width") == Some(width)
                && get("height") == Some(height)
                && let (Some(x), Some(y)) = (get("x"), get("y"))
            {
                let intersects = x < area_x + area_w && x + width > area_x && y < area_y + area_h && y + height > area_y;
                if intersects {
                    let _ = window.set_position(LogicalPosition::new(x, y));
                    return;
                }
            }
        }
        let x = area_x + (area_w - width) / 2.0;
        let y = area_y + (area_h - height) / 2.0;
        let _ = window.set_position(LogicalPosition::new(x, y));
    }

    pub fn launcher_moved(&self, position: PhysicalPosition<i32>) {
        let Some(window) = self.window(LAUNCHER) else { return };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        let Ok(Some(monitor)) = window.current_monitor() else { return };
        let scale = monitor.scale_factor();
        let Ok(size) = window.inner_size() else { return };
        self.prefs.set(
            "launcherPosition",
            json!({
                "x": position.x as f64 / scale,
                "y": position.y as f64 / scale,
                "width": (size.width as f64 / scale).round(),
                "height": (size.height as f64 / scale).round(),
                "monitor": monitor.name().cloned().unwrap_or_default(),
            }),
        );
    }
}

/// The launcher as an `NSPanel` (macOS).
#[cfg(target_os = "macos")]
mod launcher_panel {
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::objc2_app_kit::NSWindowStyleMask;
    use tauri_nspanel::{ManagerExt, WebviewWindowExt, tauri_panel};

    use super::LAUNCHER;

    tauri_panel! {
        panel!(LauncherPanel {
            config: {
                can_become_key_window: true,
                is_floating_panel: true
            }
        })
    }

    /// Swap the launcher's window class for the panel class and make it
    /// non-activating, keeping the window's existing (borderless) style.
    pub fn convert(window: &WebviewWindow) -> Result<(), String> {
        let panel = window.to_panel::<LauncherPanel>().map_err(|error| error.to_string())?;
        let ns_window = window.ns_window().map_err(|error| error.to_string())?;
        // SAFETY: reading the style mask of the live window just converted,
        // during setup on the main thread.
        let current: usize =
            unsafe { tauri_nspanel::objc2::msg_send![ns_window.cast::<tauri_nspanel::objc2::runtime::AnyObject>(), styleMask] };
        panel
            .set_style_mask(NSWindowStyleMask(current) | NSWindowStyleMask::NonactivatingPanel)
            .map_err(|error| format!("{error:?}"))
    }

    /// Order the launcher panel in and make it key.
    pub fn make_key(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel(LAUNCHER) {
            panel.show_and_make_key();
        }
    }
}
