//! The teleprompter and focus-timer overlays: small always-on-top windows at
//! the top centre of the screen, each running its own local page.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use habibi_desktop::speech::{self, SpeechEvent};
use habibi_desktop::teleprompter::{Effect, Screen};
use serde_json::Value;
use tauri::{LogicalPosition, LogicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::shell::{FOCUS, Shell, TELEPROMPTER, app_url, is_app_url};

const OVERLAY_INIT: &str = include_str!("../js/overlay-init.js");

/// The camera-housing inset of the screen under the pointer (macOS only).
/// AppKit screen queries belong on the main thread, so hop there and wait.
fn top_inset(shell: &Shell) -> f64 {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        let _ = shell.app.run_on_main_thread(move || {
            // SAFETY: runs on the main thread.
            let inset = unsafe { habibi_desktop::macos::pointer_screen() }.map(|screen| screen.top_inset).unwrap_or(0.0);
            let _ = sender.send(inset);
        });
        receiver.recv_timeout(Duration::from_millis(500)).unwrap_or(0.0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = shell;
        0.0
    }
}

/// The monitor under the pointer: logical origin, size, visible width and
/// the camera-housing inset.
struct Display {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible_width: f64,
    inset: f64,
}

fn pointer_display(shell: &Shell) -> Option<Display> {
    let app = &shell.app;
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let inset = top_inset(shell);
    Some(Display {
        x: monitor.position().x as f64 / scale,
        y: monitor.position().y as f64 / scale,
        width: monitor.size().width as f64 / scale,
        height: monitor.size().height as f64 / scale,
        visible_width: monitor.work_area().size.width as f64 / scale,
        inset,
    })
}

fn overlay_window(shell: &Arc<Shell>, label: &str, page: &str, handler: &str, focusable: bool) -> Option<WebviewWindow> {
    if let Some(window) = shell.window(label) {
        return Some(window);
    }
    let expected = app_url(page);
    let init = OVERLAY_INIT.replace("__HABIBI_HANDLER__", handler).replace(
        "__HABIBI_READING_KEYS__",
        if label == TELEPROMPTER { "true" } else { "false" },
    );
    let window = WebviewWindowBuilder::new(&shell.app, label, WebviewUrl::CustomProtocol(expected.clone()))
        .title(if label == TELEPROMPTER { "Habibi Teleprompter" } else { "Habibi Focus" })
        .inner_size(370.0, 54.0)
        .decorations(false)
        .transparent(true)
        .shadow(label == FOCUS)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        .focusable(focusable)
        .initialization_script(init)
        // Only the overlay's own page may load in it.
        .on_navigation(move |url| is_app_url(url) && url.path() == expected.path())
        .build()
        .ok()?;
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        use habibi_desktop::macos::PanelKind;
        let pointer = ns_window as usize;
        let teleprompter = label == TELEPROMPTER;
        // The Swift overlays were non-activating NSPanels on every Space.
        let kind = if teleprompter { PanelKind::Reading } else { PanelKind::Pill };
        let _ = shell.app.run_on_main_thread(move || unsafe {
            // SAFETY: live window pointer, on the main thread.
            habibi_desktop::macos::configure_panel(pointer as *mut _, kind);
            if teleprompter {
                habibi_desktop::macos::round_window(pointer as *mut _, 22.0, true);
            }
        });
    }
    #[cfg(any(target_os = "macos", windows))]
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    Some(window)
}

/// Show without taking focus from whatever the user is doing.
fn present(shell: &Shell, window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        let pointer = ns_window as usize;
        let _ = shell.app.run_on_main_thread(move || unsafe {
            // SAFETY: live window pointer, on the main thread.
            habibi_desktop::macos::order_front(pointer as *mut _);
        });
        return;
    }
    let _ = shell;
    let _ = window.show();
}

fn place_top_center(window: &WebviewWindow, display: &Display, width: f64, height: f64) {
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(display.x + (display.width - width) / 2.0, display.y));
}

// -- teleprompter -----------------------------------------------------------

fn screen(display: &Option<Display>) -> Screen {
    match display {
        Some(display) => Screen { height: display.height, visible_width: display.visible_width, inset: display.inset },
        None => Screen { height: 900.0, visible_width: 1440.0, inset: 0.0 },
    }
}

/// Handle a `teleprompter` bridge message from the launcher. Returns false for
/// an invalid request.
pub fn teleprompter_message(shell: &Arc<Shell>, message: &Value) -> bool {
    let display = pointer_display(shell);
    let effects = {
        let mut prompter = shell.prompter.lock().unwrap_or_else(|e| e.into_inner());
        prompter.handle(message, screen(&display))
    };
    let Some(effects) = effects else { return false };
    apply(shell, effects, display.as_ref());
    true
}

/// Space / Esc / buttons from the overlay page itself, and its measured layout.
pub fn teleprompter_overlay_action(shell: &Arc<Shell>, action: &str, message: &Value) {
    match action {
        "layout" => {
            let Some(layout) = message.get("layout") else { return };
            let effects = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).measured(layout);
            // A measured height keeps the window where it is (top-anchored).
            apply(shell, effects, None);
        }
        "ready" => {
            shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).overlay_ready();
            sync_teleprompter(shell);
        }
        "toggle" => {
            let display = pointer_display(shell);
            let effects = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).toggle(screen(&display));
            apply(shell, effects, display.as_ref());
        }
        "pause" | "resume" | "reset" | "stop" => {
            teleprompter_message(shell, &serde_json::json!({ "action": action }));
        }
        _ => {}
    }
}

fn sync_teleprompter(shell: &Shell) {
    let payload = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).overlay_state();
    shell.call(TELEPROMPTER, "__habibiTeleprompterOverlayState", &payload);
}

fn apply(shell: &Arc<Shell>, effects: Vec<Effect>, display: Option<&Display>) {
    for effect in effects {
        match effect {
            Effect::Present => {
                if let Some(window) = overlay_window(shell, TELEPROMPTER, "/assets/teleprompter-overlay.html", "teleprompterOverlay", true) {
                    present(shell, &window);
                }
            }
            Effect::Hide => {
                if let Some(window) = shell.window(TELEPROMPTER) {
                    let _ = window.hide();
                }
            }
            Effect::Frame { width, height } => {
                match (shell.window(TELEPROMPTER), display) {
                    (Some(window), None) => {
                        let _ = window.set_size(LogicalSize::new(width, height));
                    }
                    (_, Some(display)) => {
                        if let Some(window) = overlay_window(
                            shell,
                            TELEPROMPTER,
                            "/assets/teleprompter-overlay.html",
                            "teleprompterOverlay",
                            true,
                        ) {
                            place_top_center(&window, display, width, height);
                        }
                    }
                    (None, None) => {}
                }
            }
            Effect::Listen { generation, vocabulary } => {
                let callback_shell = shell.clone();
                let callback: speech::SpeechCallback = Arc::new(move |event| {
                    let effects = {
                        let mut prompter = callback_shell.prompter.lock().unwrap_or_else(|e| e.into_inner());
                        match event {
                            SpeechEvent::Transcript { text, new_segment } => prompter.transcript(generation, &text, new_segment),
                            SpeechEvent::Failure(message) => prompter.speech_failed(generation, &message),
                        }
                    };
                    apply(&callback_shell, effects, None);
                });
                let _ = shell.app.run_on_main_thread(move || speech::start(vocabulary, callback));
            }
            Effect::StopListening => {
                let _ = shell.app.run_on_main_thread(speech::stop);
            }
            Effect::Clock(true) => start_clock(shell),
            Effect::Clock(false) => {
                shell.clock_generation.fetch_add(1, Ordering::SeqCst);
            }
            Effect::Notify(value) => shell.call_launcher("__habibiTeleprompterState", &value),
            Effect::Sync => sync_teleprompter(shell),
        }
    }
}

/// ~30 fps scroll clock while reading.
fn start_clock(shell: &Arc<Shell>) {
    let generation = shell.clock_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let shell = shell.clone();
    std::thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(33));
            if shell.clock_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let now = Instant::now();
            let elapsed = now.duration_since(last).as_secs_f64();
            last = now;
            let effects = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).tick(elapsed);
            apply(&shell, effects, None);
        }
    });
}

/// Sleep, display sleep or a locked session: pause reading (the user resumes
/// with Space, as in the Swift app).
pub fn pause_teleprompter(shell: &Arc<Shell>) {
    let effects = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).pause_external();
    apply(shell, effects, None);
}

pub fn stop_teleprompter(shell: &Arc<Shell>) {
    let effects = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).stop();
    apply(shell, effects, None);
}

// -- focus timer ------------------------------------------------------------

fn focus_window(shell: &Arc<Shell>) -> Option<WebviewWindow> {
    // The focus pill never takes keyboard focus; its buttons still click.
    overlay_window(shell, FOCUS, "/assets/focus-overlay.html", "focusOverlay", false)
}

fn send_focus(shell: &Arc<Shell>) {
    let (snapshot, visible) = {
        let focus = shell.focus.lock().unwrap_or_else(|e| e.into_inner());
        (focus.snapshot(), focus.visible)
    };
    if shell.launcher_visible() {
        shell.call_launcher("__habibiFocusState", &snapshot);
    }
    if visible && shell.focus_overlay_ready.load(Ordering::SeqCst) {
        let mut value = snapshot;
        value["inset"] = pointer_display(shell).map(|d| d.inset).unwrap_or(0.0).into();
        shell.call(FOCUS, "__habibiFocusState", &value);
    }
}

fn show_focus(shell: &Arc<Shell>) {
    let Some(window) = focus_window(shell) else { return };
    if let Some(display) = pointer_display(shell) {
        let width = 370f64.min(display.visible_width - 24.0);
        place_top_center(&window, &display, width, display.inset + 54.0);
    }
    present(shell, &window);
}

/// `dailyUtility` `focus` action from the launcher (or an overlay button).
pub fn focus_message(shell: &Arc<Shell>, value: &Value) -> Value {
    let outcome = {
        let mut focus = shell.focus.lock().unwrap_or_else(|e| e.into_inner());
        focus.handle(value, &shell.prefs)
    };
    if outcome.show {
        show_focus(shell);
    }
    if outcome.hide
        && let Some(window) = shell.window(FOCUS)
    {
        let _ = window.hide();
    }
    send_focus(shell);
    outcome.reply
}

pub fn focus_overlay_action(shell: &Arc<Shell>, action: &str) {
    match action {
        "ready" => {
            shell.focus_overlay_ready.store(true, Ordering::SeqCst);
            send_focus(shell);
        }
        "pause" | "resume" | "reset" | "hide" => {
            focus_message(shell, &serde_json::json!({ "action": action }));
        }
        _ => {}
    }
}

/// The one-second focus tick. Runs for the life of the app; idle when no
/// session is running.
pub fn start_focus_clock(shell: &Arc<Shell>) {
    let shell = shell.clone();
    if shell.focus.lock().unwrap_or_else(|e| e.into_inner()).visible {
        show_focus(&shell);
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let (running, finished) = {
                let mut focus = shell.focus.lock().unwrap_or_else(|e| e.into_inner());
                let running = focus.running();
                (running, running && focus.tick(&shell.prefs))
            };
            if finished {
                habibi_desktop::play_finish_sound();
                let app_shell = shell.clone();
                let _ = shell.app.run_on_main_thread(move || show_focus(&app_shell));
            }
            if running {
                send_focus(&shell);
            }
        }
    });
}
