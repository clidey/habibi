//! The launcher's global shortcut: registration, conflict checks, saving.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use habibi_desktop::shortcut::LauncherShortcut;
use serde_json::json;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::shell::Shell;
use crate::tray;

fn register_raw(shell: &Shell, shortcut: LauncherShortcut) -> bool {
    let Some(accelerator) = shortcut.accelerator() else { return false };
    shell.app.global_shortcut().register(accelerator.as_str()).is_ok()
}

fn unregister_current(shell: &Shell) {
    let current = *shell.shortcut.lock().unwrap_or_else(|e| e.into_inner());
    if shell.shortcut_registered.swap(false, Ordering::SeqCst)
        && let Some(accelerator) = current.accelerator()
    {
        let _ = shell.app.global_shortcut().unregister(accelerator.as_str());
    }
}

/// Register `shortcut` as the launcher shortcut, replacing the current one.
/// Another app may already own the combination (Alfred and Raycast commonly
/// claim ⌥ Space); registration then fails, which used to leave the launcher
/// with no way in and no explanation, so say so once and point at the
/// menu-bar/tray icon that still works.
pub fn register(shell: &Arc<Shell>, shortcut: LauncherShortcut) {
    unregister_current(shell);
    *shell.shortcut.lock().unwrap_or_else(|e| e.into_inner()) = shortcut;
    let label = shortcut.label(&shell.prefs);
    if register_raw(shell, shortcut) {
        shell.shortcut_registered.store(true, Ordering::SeqCst);
        shell.announced_shortcut_failure.store(false, Ordering::SeqCst);
        tray::set_tooltip(shell, &format!("Habibi — {label}"));
        tracing::info!("registered global shortcut {label}");
        return;
    }
    tray::set_tooltip(shell, &format!("Habibi — {label} is unavailable; click to open"));
    tracing::warn!("could not register {label}: another app owns it");
    if shell.announced_shortcut_failure.swap(true, Ordering::SeqCst) {
        return;
    }
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let opener = shell.clone();
    shell
        .app
        .dialog()
        .message("Habibi is running. Open Habibi, then pick a different shortcut in Settings.")
        .title(format!("{label} is already used by another app"))
        .buttons(MessageDialogButtons::OkCancelCustom("Open Habibi".into(), "Later".into()))
        .show(move |open| {
            if open {
                opener.show_launcher();
            }
        });
}

/// Re-register the current shortcut 250 ms after wake or a session switch,
/// as the Swift app did; repeated events collapse into one repair.
pub fn schedule_repair(shell: &Arc<Shell>) {
    let generation = shell.shortcut_repair.fetch_add(1, Ordering::SeqCst) + 1;
    let shell = shell.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if shell.shortcut_repair.load(Ordering::SeqCst) != generation {
            return;
        }
        let main_shell = shell.clone();
        let _ = shell.app.run_on_main_thread(move || {
            let current = *main_shell.shortcut.lock().unwrap_or_else(|e| e.into_inner());
            register(&main_shell, current);
        });
    });
}

/// (available, message) for a candidate shortcut, as the Swift app reported.
pub fn availability(shell: &Shell, candidate: LauncherShortcut) -> (bool, String) {
    if let Err(message) = candidate.validate() {
        return (false, message);
    }
    let current = *shell.shortcut.lock().unwrap_or_else(|e| e.into_inner());
    if candidate == current && shell.shortcut_registered.load(Ordering::SeqCst) {
        return (true, "Already your Habibi shortcut.".into());
    }
    if register_raw(shell, candidate) {
        if let Some(accelerator) = candidate.accelerator() {
            let _ = shell.app.global_shortcut().unregister(accelerator.as_str());
        }
        let here = if cfg!(target_os = "macos") { "Available on this Mac." } else { "Available on this computer." };
        (true, here.into())
    } else {
        (false, "Already claimed by another shortcut.".into())
    }
}

pub fn save(shell: &Arc<Shell>, candidate: LauncherShortcut, label: &str) {
    let (available, message) = availability(shell, candidate);
    if !available {
        shell.call_launcher("__habibiShortcutValidation", &json!({ "available": false, "message": message }));
        return;
    }
    let previous = *shell.shortcut.lock().unwrap_or_else(|e| e.into_inner());
    unregister_current(shell);
    if !register_raw(shell, candidate) {
        if register_raw(shell, previous) {
            shell.shortcut_registered.store(true, Ordering::SeqCst);
        }
        let os = if cfg!(target_os = "macos") { "macOS" } else { "The system" };
        shell.call_launcher(
            "__habibiShortcutValidation",
            &json!({ "available": false, "message": format!("{os} could not claim that shortcut.") }),
        );
        return;
    }
    shell.shortcut_registered.store(true, Ordering::SeqCst);
    *shell.shortcut.lock().unwrap_or_else(|e| e.into_inner()) = candidate;
    candidate.save(&shell.prefs, label);
    tray::set_tooltip(shell, &format!("Habibi — {label}"));
    shell.call_launcher(
        "__habibiShortcutValidation",
        &json!({ "available": true, "saved": true, "message": "Saved — Habibi will use this globally." }),
    );
}
