//! Launch at login: `SMAppService.mainApp` on macOS (as the Swift app used,
//! so an existing registration is recognised), the autostart plugin elsewhere.

use serde_json::{Value, json};

use crate::shell::Shell;

fn enabled(shell: &Shell) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = shell;
        habibi_desktop::macos::login_item_enabled()
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        shell.app.autolaunch().is_enabled().unwrap_or(false)
    }
}

fn apply(shell: &Shell, value: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = shell;
        habibi_desktop::macos::set_login_item(value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = shell.app.autolaunch();
        if value { manager.enable().is_ok() } else { manager.disable().is_ok() }
    }
}

pub fn send_state(shell: &Shell, message: Option<&str>) {
    let mut payload = json!({ "enabled": enabled(shell) });
    if let Some(message) = message {
        payload["message"] = Value::String(message.into());
    }
    shell.call_launcher("__habibiLaunchAtLoginState", &payload);
}

pub fn set(shell: &Shell, value: bool) {
    let message = if apply(shell, value) {
        if value { "Habibi will start when you log in." } else { "Habibi will no longer start at login." }
    } else if cfg!(target_os = "macos") {
        "macOS could not update the login setting."
    } else {
        "Habibi could not update the login setting."
    };
    send_state(shell, Some(message));
}
