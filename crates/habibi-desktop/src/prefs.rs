//! Small key/value preferences for the desktop shell.
//!
//! The Swift app kept these in `UserDefaults` (`com.clidey.habibi`). The Rust
//! shell keeps one private JSON file under `state_root/.habibi/` on every OS
//! and, on macOS, imports the old `UserDefaults` values once so an upgrading
//! user keeps their shortcut, menu-bar and clipboard choices.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::fsutil;

pub const FILE_NAME: &str = "desktop-preferences.json";

/// Keys the Swift app stored in `UserDefaults` that still mean the same thing.
pub const LEGACY_KEYS: &[&str] = &[
    "launcherShortcutKeyCode",
    "launcherShortcutModifiers",
    "launcherShortcutLabel",
    "launcherShortcut",
    "showMenuBarIcon",
    "clipboardHistoryEnabled",
    "hasCompletedFirstRun",
];

pub struct Preferences {
    path: PathBuf,
    values: Mutex<Map<String, Value>>,
    existed: bool,
}

impl Preferences {
    /// Open (or start) the preferences file at `path`.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let existed = path.exists();
        let values = std::fs::read(&path)
            .ok()
            .filter(|data| data.len() < 4 * 1024 * 1024)
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        Self { path, values: Mutex::new(values), existed }
    }

    /// `state_root/.habibi/desktop-preferences.json`.
    pub fn in_state_root(state_root: &Path) -> Self {
        Self::open(state_root.join(".habibi").join(FILE_NAME))
    }

    /// True when the file did not exist before this run (first launch of the
    /// Rust shell), which is when legacy values are imported.
    pub fn is_new(&self) -> bool {
        !self.existed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Map<String, Value>> {
        self.values.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.lock().get(key).cloned()
    }

    pub fn contains(&self, key: &str) -> bool {
        self.lock().contains_key(key)
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(|value| value.as_bool())
    }

    pub fn get_i64(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(|value| value.as_i64())
    }

    pub fn get_string(&self, key: &str) -> Option<String> {
        self.get(key).and_then(|value| value.as_str().map(str::to_string))
    }

    pub fn set(&self, key: &str, value: Value) {
        let snapshot = {
            let mut values = self.lock();
            values.insert(key.to_string(), value);
            values.clone()
        };
        self.save(&snapshot);
    }

    pub fn set_many(&self, entries: impl IntoIterator<Item = (String, Value)>) {
        let snapshot = {
            let mut values = self.lock();
            for (key, value) in entries {
                values.insert(key, value);
            }
            values.clone()
        };
        self.save(&snapshot);
    }

    pub fn remove(&self, keys: &[&str]) {
        let snapshot = {
            let mut values = self.lock();
            for key in keys {
                values.remove(*key);
            }
            values.clone()
        };
        self.save(&snapshot);
    }

    fn save(&self, values: &Map<String, Value>) {
        let Ok(data) = serde_json::to_vec_pretty(values) else { return };
        if let Err(error) = fsutil::write_private(&self.path, &data) {
            tracing::warn!("could not save desktop preferences: {error}");
        }
    }

    /// Import values the Swift app left in `UserDefaults`, once, when this file
    /// is new. `read` returns the stored value for a key, if any.
    pub fn import_legacy(&self, read: impl Fn(&str) -> Option<Value>) {
        if !self.is_new() {
            return;
        }
        let imported: Vec<(String, Value)> =
            LEGACY_KEYS.iter().filter_map(|key| read(key).map(|value| (key.to_string(), value))).collect();
        if !imported.is_empty() {
            self.set_many(imported);
        }
    }
}

/// Read one value from the Swift app's `UserDefaults` domain with
/// `/usr/bin/defaults`, which needs no Objective-C bridging and never writes.
#[cfg(target_os = "macos")]
pub fn read_macos_default(domain: &str, key: &str) -> Option<Value> {
    use std::process::Command;
    let kind = Command::new("/usr/bin/defaults").args(["read-type", domain, key]).output().ok()?;
    if !kind.status.success() {
        return None;
    }
    let kind = String::from_utf8_lossy(&kind.stdout).to_ascii_lowercase();
    let value = Command::new("/usr/bin/defaults").args(["read", domain, key]).output().ok()?;
    if !value.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&value.stdout).trim_end_matches('\n').to_string();
    parse_default(&kind, &text)
}

#[cfg(any(target_os = "macos", test))]
fn parse_default(kind: &str, text: &str) -> Option<Value> {
    if kind.contains("boolean") {
        Some(Value::Bool(text.trim() == "1"))
    } else if kind.contains("integer") {
        text.trim().parse::<i64>().ok().map(Value::from)
    } else if kind.contains("string") {
        Some(Value::String(text.to_string()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_and_imports_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".habibi").join(FILE_NAME);
        let prefs = Preferences::open(&path);
        assert!(prefs.is_new());
        prefs.import_legacy(|key| (key == "showMenuBarIcon").then_some(json!(false)));
        assert_eq!(prefs.get_bool("showMenuBarIcon"), Some(false));
        prefs.set("clipboardHistoryEnabled", json!(true));
        let reopened = Preferences::open(&path);
        assert!(!reopened.is_new());
        reopened.import_legacy(|_| Some(json!(true)));
        assert_eq!(reopened.get_bool("showMenuBarIcon"), Some(false));
        assert_eq!(reopened.get_bool("clipboardHistoryEnabled"), Some(true));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn parses_defaults_output() {
        assert_eq!(parse_default("type is boolean", "1"), Some(json!(true)));
        assert_eq!(parse_default("type is integer", "2048"), Some(json!(2048)));
        assert_eq!(parse_default("type is string", "⌥ Space"), Some(json!("⌥ Space")));
        assert_eq!(parse_default("type is dictionary", "{}"), None);
    }
}
