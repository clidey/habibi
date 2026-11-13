//! Update checks through `tauri-plugin-updater`.
//!
//! CONFIG PLACEHOLDER: `plugins.updater.pubkey` in `tauri.conf.json` ships
//! as `REPLACE_WITH_UPDATER_PUBLIC_KEY`. Until it is replaced with the real
//! minisign public key (see the header of `.github/workflows/release.yml`),
//! checks are skipped so nothing is downloaded or installed.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri_plugin_updater::UpdaterExt;

use crate::shell::Shell;

const PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

fn configured(shell: &Shell) -> bool {
    shell
        .app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(Value::as_str)
        .map(|key| !key.is_empty() && key != PLACEHOLDER)
        .unwrap_or(false)
}

fn send(shell: &Shell, state: &str, version: Option<&str>, available: bool) {
    let mut payload = json!({ "state": state, "available": available });
    if let Some(version) = version {
        payload["version"] = Value::String(version.into());
    }
    shell.call_launcher("__habibiUpdateState", &payload);
}

pub fn check(shell: Arc<Shell>) {
    if !configured(&shell) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = shell.app.updater() else { return };
        if let Ok(Some(update)) = updater.check().await {
            let version = update.version.clone();
            *shell.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
            send(&shell, "available", Some(&version), true);
        }
    });
}

pub fn install(shell: Arc<Shell>) {
    let Some(update) = shell.update.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
    tauri::async_runtime::spawn(async move {
        let version = update.version.clone();
        send(&shell, "downloading", Some(&version), true);
        let installing = shell.clone();
        let installing_version = version.clone();
        let result = update
            .download_and_install(|_, _| {}, move || send(&installing, "installing", Some(&installing_version), true))
            .await;
        match result {
            Ok(()) => shell.app.restart(),
            Err(_) => {
                send(&shell, "available", Some(&version), true);
                *shell.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
            }
        }
    });
}
