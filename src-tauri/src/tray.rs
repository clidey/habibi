//! The menu-bar status item (macOS) / tray icon (Windows, Linux).
//!
//! On macOS a click toggles the launcher, exactly like the Swift status item,
//! which had no menu. Windows and Linux add a small Open/Quit menu: Linux tray
//! hosts only show menus, and on Windows it is the expected right-click.

use std::sync::Arc;

use serde_json::json;
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::shell::Shell;

const TRAY_ID: &str = "habibi";
const LOGO: &[u8] = include_bytes!("../../assets/logo.png");

pub fn build(shell: &Arc<Shell>) -> tauri::Result<()> {
    let label = shell.shortcut_label();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(LOGO)?)
        .icon_as_template(false)
        .tooltip(format!("Habibi — {label}"))
        .show_menu_on_left_click(false);
    if !cfg!(target_os = "macos") {
        use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
        let app = &shell.app;
        let open = MenuItem::with_id(app, "open", "Open Habibi", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Habibi", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
        let menu_shell = shell.clone();
        builder = builder.menu(&menu).on_menu_event(move |_, event| match event.id().as_ref() {
            "open" => menu_shell.show_launcher(),
            "quit" => crate::quit(&menu_shell),
            _ => {}
        });
    }
    let click_shell = shell.clone();
    builder = builder.on_tray_icon_event(move |_, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            click_shell.toggle_launcher();
        }
    });
    let tray = builder.build(&shell.app)?;
    let visible = shell.prefs.get_bool("showMenuBarIcon").unwrap_or(true);
    let _ = tray.set_visible(visible);
    Ok(())
}

pub fn set_tooltip(shell: &Shell, text: &str) {
    if let Some(tray) = shell.app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

fn visible(shell: &Shell) -> bool {
    shell.prefs.get_bool("showMenuBarIcon").unwrap_or(true)
}

pub fn send_state(shell: &Shell) {
    shell.call_launcher("__habibiMenuBarIconState", &json!({ "enabled": visible(shell) }));
}

pub fn set_visible(shell: &Shell, enabled: bool) {
    shell.prefs.set("showMenuBarIcon", enabled.into());
    if let Some(tray) = shell.app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(enabled);
    }
    send_state(shell);
}
