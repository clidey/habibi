//! The Habibi desktop shell: hosts `habibi_server` in a Tauri v2 app with a
//! launcher window, menu-bar/tray icon, global shortcut, overlays and the
//! native bridge the UI already speaks (see ARCHITECTURE.md).

mod bridge;
mod commands;
mod login;
mod overlays;
mod paths;
mod protocol;
mod shell;
mod shortcut;
mod tray;
mod updates;

use std::sync::Arc;
use std::time::Duration;

use habibi_desktop::prefs::Preferences;
use habibi_desktop::shortcut::LauncherShortcut;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

use crate::shell::{LAUNCHER, Shell};

/// Stop everything that holds the microphone or a child process, then exit.
pub(crate) fn quit(shell: &Arc<Shell>) {
    overlays::stop_teleprompter(shell);
    shell.close_all_ptys();
    let _ = shell.app.run_on_main_thread(habibi_desktop::speech::stop);
    shell.app.exit(0);
}

fn shell_of(app: &tauri::AppHandle) -> Option<Arc<Shell>> {
    app.try_state::<Arc<Shell>>().map(|state| state.inner().clone())
}

/// Clipboard history: poll once a second while enabled.
fn start_clipboard_watch(shell: &Arc<Shell>) {
    let shell = shell.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let added = {
                let mut clipboard = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner());
                clipboard.enabled() && clipboard.capture()
            };
            if added && shell.launcher_visible() {
                shell.call_launcher("__habibiDailyChanged", &serde_json::Value::String("clipboard".into()));
            }
        }
    });
}

/// Habibi has no Dock icon and no window until its shortcut is pressed. If
/// another launcher already owns that combination the first launch looks
/// like a failed start, so open the panel once on first run.
fn present_first_run(shell: &Arc<Shell>) {
    if shell.prefs.get_bool("hasCompletedFirstRun") == Some(true) {
        return;
    }
    shell.prefs.set("hasCompletedFirstRun", true.into());
    let shell = shell.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        if !shell.launcher_visible() {
            let app_shell = shell.clone();
            let _ = shell.app.run_on_main_thread(move || app_shell.show_launcher());
        }
    });
}

#[cfg(target_os = "macos")]
fn install_edit_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    // The webview still relies on the AppKit responder chain for ⌘X/C/V/A.
    // Without these targetless items macOS plays the rejected-shortcut sound
    // before the page sees a text paste. The menu bar itself never shows
    // (accessory app).
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&edit])?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_paste_capture(shell: &Arc<Shell>) {
    let Some(window) = shell.window(LAUNCHER) else { return };
    let Ok(ns_window) = window.ns_window() else { return };
    let pointer = ns_window as usize;
    let paste_shell = shell.clone();
    let _ = shell.app.run_on_main_thread(move || {
        // SAFETY: on the main thread; the launcher window lives for the whole app.
        unsafe {
            habibi_desktop::macos::install_paste_monitor(move || {
                // SAFETY: still on the main thread inside the event monitor.
                let key = habibi_desktop::macos::is_key_window(pointer as *mut _);
                if !key || !bridge::clipboard_has_image(&paste_shell) {
                    return false;
                }
                if let Some(window) = paste_shell.window(LAUNCHER) {
                    let _ = window.eval("window.__habibiNativePasteImage?.()");
                }
                true
            });
        }
    });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let handle = app.handle().clone();
    let resolved = paths::resolve(&handle)?;
    let prefs = Arc::new(Preferences::in_state_root(&resolved.paths.state_root));
    #[cfg(target_os = "macos")]
    if !resolved.overridden {
        // First launch of the Rust shell: carry over the Swift app's settings.
        prefs.import_legacy(|key| habibi_desktop::prefs::read_macos_default("com.clidey.habibi", key));
    }
    // Built inside the async runtime so services that start background work
    // (the file index watcher) attach to it.
    let server_paths = resolved.paths.clone();
    let server = tauri::async_runtime::block_on(async move { habibi_server::Server::new(server_paths) });
    let shell = Arc::new(Shell::new(handle.clone(), server, resolved.paths, prefs));
    app.manage(shell.clone());
    let events = Arc::downgrade(&shell);
    shell.server.set_event_sink(Some(Arc::new(move |callback: &str, payload: serde_json::Value| {
        if let Some(shell) = events.upgrade() {
            shell.call_launcher(callback, &payload);
        }
    })));

    #[cfg(target_os = "macos")]
    install_edit_menu(&handle)?;
    let launcher = shell.create_launcher()?;
    let events = shell.clone();
    launcher.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => events.launcher_blurred(),
        WindowEvent::Moved(position) => events.launcher_moved(*position),
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            events.hide_launcher_and_reset();
        }
        WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
            let files: Vec<String> =
                paths.iter().filter(|path| path.is_file()).map(|path| path.to_string_lossy().into_owned()).collect();
            if !files.is_empty() {
                events.call_launcher("__habibiNativeDroppedFiles", &serde_json::json!(files));
            }
        }
        _ => {}
    });
    tray::build(&shell)?;
    let initial = LauncherShortcut::load(&shell.prefs);
    shortcut::register(&shell, initial);
    #[cfg(target_os = "macos")]
    install_paste_capture(&shell);
    start_clipboard_watch(&shell);
    overlays::start_focus_clock(&shell);
    updates::check(shell.clone());
    present_first_run(&shell);
    Ok(())
}

pub fn run() {
    paths::extend_tool_path();
    let builder = tauri::Builder::default()
        // Must be first: a second launch hands over and shows the launcher.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(shell) = shell_of(app) {
                shell.show_launcher();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && let Some(shell) = shell_of(app)
                    {
                        shell.toggle_launcher();
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
    let app = builder
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |context, request, responder| {
            let Some(shell) = shell_of(context.app_handle()) else {
                responder.respond(tauri::http::Response::builder().status(503).body(Vec::new()).unwrap_or_default());
                return;
            };
            tauri::async_runtime::spawn(async move {
                responder.respond(protocol::serve(shell, request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::api,
            commands::native_message,
            commands::overlay_message,
            commands::pty_start,
            commands::pty_input,
            commands::pty_resize,
            commands::pty_close,
        ])
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("error while building Habibi");
    app.run(|handle, event| match event {
        // Habibi lives in the menu bar / tray; closing windows never quits it.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(shell) = shell_of(handle)
                && !shell.launcher_visible()
            {
                shell.show_launcher();
            }
        }
        RunEvent::Exit => {
            if let Some(shell) = shell_of(handle) {
                shell.close_all_ptys();
                // Stop the OpenWA runtime so no Node/Chromium is left behind.
                let server = shell.server.clone();
                tauri::async_runtime::block_on(async move { server.shutdown().await });
            }
        }
        _ => {
            let _ = handle;
        }
    });
}
