//! The launcher's global shortcut.
//!
//! The UI captures shortcuts as macOS virtual key codes plus Carbon modifier
//! bits (`shortcut-capture.js`), and the Swift app persisted exactly those
//! numbers. Keeping that representation means existing preferences carry over
//! unchanged; this module translates it into an accelerator string the
//! cross-platform global-shortcut registry understands.

use crate::prefs::Preferences;

pub const CMD: u32 = 256;
pub const SHIFT: u32 = 512;
pub const OPTION: u32 = 2048;
pub const CONTROL: u32 = 4096;

pub const KEY_SPACE: u32 = 49;
pub const KEY_TAB: u32 = 48;
pub const KEY_L: u32 = 37;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LauncherShortcut {
    pub key_code: u32,
    pub modifiers: u32,
}

/// (mac virtual key code, accelerator code, display name)
const KEYS: &[(u32, &str, &str)] = &[
    (49, "Space", "Space"),
    (36, "Enter", "Enter"),
    (53, "Escape", "Esc"),
    (48, "Tab", "Tab"),
    (51, "Backspace", "Backspace"),
    (117, "Delete", "Delete"),
    (126, "ArrowUp", "↑"),
    (125, "ArrowDown", "↓"),
    (123, "ArrowLeft", "←"),
    (124, "ArrowRight", "→"),
    (115, "Home", "Home"),
    (119, "End", "End"),
    (116, "PageUp", "Page Up"),
    (121, "PageDown", "Page Down"),
];

const LETTER_CODES: [u32; 26] =
    [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
const DIGIT_CODES: [u32; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];

/// The accelerator key code (`KeyA`, `Digit1`, `Space`, …) and display name.
fn key(key_code: u32) -> Option<(String, String)> {
    if let Some((_, code, name)) = KEYS.iter().find(|(value, _, _)| *value == key_code) {
        return Some((code.to_string(), name.to_string()));
    }
    if let Some(index) = LETTER_CODES.iter().position(|value| *value == key_code) {
        let letter = (b'A' + index as u8) as char;
        return Some((format!("Key{letter}"), letter.to_string()));
    }
    if let Some(index) = DIGIT_CODES.iter().position(|value| *value == key_code) {
        return Some((format!("Digit{index}"), index.to_string()));
    }
    None
}

impl LauncherShortcut {
    /// ⌥ Space, the Swift app's default.
    pub const DEFAULT: Self = Self { key_code: KEY_SPACE, modifiers: OPTION };

    pub fn new(key_code: u32, modifiers: u32) -> Self {
        Self { key_code, modifiers: modifiers & (CMD | SHIFT | OPTION | CONTROL) }
    }

    /// The saved shortcut, migrating the two original named choices.
    pub fn load(prefs: &Preferences) -> Self {
        if let (Some(key_code), Some(modifiers)) =
            (prefs.get_i64("launcherShortcutKeyCode"), prefs.get_i64("launcherShortcutModifiers"))
            && let (Ok(key_code), Ok(modifiers)) = (u32::try_from(key_code), u32::try_from(modifiers))
        {
            return Self::new(key_code, modifiers);
        }
        // Migrate the two original friendly choices without making existing
        // users reconfigure their launcher.
        let legacy = prefs.get_string("launcherShortcut").unwrap_or_else(|| "optionSpace".into());
        Self { key_code: KEY_SPACE, modifiers: if legacy == "controlSpace" { CONTROL } else { OPTION } }
    }

    pub fn save(&self, prefs: &Preferences, label: &str) {
        prefs.set_many([
            ("launcherShortcutKeyCode".to_string(), self.key_code.into()),
            ("launcherShortcutModifiers".to_string(), self.modifiers.into()),
            ("launcherShortcutLabel".to_string(), label.into()),
        ]);
    }

    /// `Alt+Space`, `Super+Shift+KeyK`, … or `None` for an unknown key.
    pub fn accelerator(&self) -> Option<String> {
        let (code, _) = key(self.key_code)?;
        let mut parts = Vec::new();
        if self.modifiers & CMD != 0 {
            parts.push("Super");
        }
        if self.modifiers & CONTROL != 0 {
            parts.push("Control");
        }
        if self.modifiers & OPTION != 0 {
            parts.push("Alt");
        }
        if self.modifiers & SHIFT != 0 {
            parts.push("Shift");
        }
        let mut value = parts.join("+");
        if !value.is_empty() {
            value.push('+');
        }
        value.push_str(&code);
        Some(value)
    }

    /// The label the UI shows, preferring the one it saved with the shortcut.
    pub fn label(&self, prefs: &Preferences) -> String {
        if let Some(stored) = prefs.get_string("launcherShortcutLabel").filter(|label| !label.is_empty()) {
            return stored;
        }
        self.default_label(cfg!(target_os = "macos"))
    }

    pub fn default_label(&self, mac: bool) -> String {
        let name = key(self.key_code).map(|(_, name)| name).unwrap_or_else(|| "Shortcut".into());
        if mac {
            let mut value = String::new();
            for (bit, symbol) in [(CMD, "⌘ "), (OPTION, "⌥ "), (CONTROL, "⌃ "), (SHIFT, "⇧ ")] {
                if self.modifiers & bit != 0 {
                    value.push_str(symbol);
                }
            }
            value + &name
        } else {
            let mut parts = Vec::new();
            for (bit, word) in [(CMD, "Win"), (CONTROL, "Ctrl"), (OPTION, "Alt"), (SHIFT, "Shift")] {
                if self.modifiers & bit != 0 {
                    parts.push(word.to_string());
                }
            }
            parts.push(name);
            parts.join("+")
        }
    }

    /// Combinations the operating system keeps for itself.
    pub fn reserved_reason(&self) -> Option<&'static str> {
        // Command-Space is valid when the user has freed it from Spotlight or
        // another launcher. Registration is the source of truth there.
        if cfg!(target_os = "macos") {
            if self.key_code == KEY_TAB && self.modifiers == CMD {
                return Some("Command-Tab belongs to macOS app switching.");
            }
        } else {
            if self.key_code == KEY_TAB && self.modifiers == OPTION {
                return Some("Alt-Tab belongs to app switching.");
            }
            if cfg!(target_os = "windows") && self.key_code == KEY_L && self.modifiers == CMD {
                return Some("Windows-L locks this PC.");
            }
        }
        None
    }

    /// The checks that do not need the OS: a modifier, a known key, not
    /// reserved. `Err` carries the message the UI shows.
    pub fn validate(&self) -> Result<String, String> {
        if self.modifiers & (CMD | OPTION | CONTROL) == 0 {
            return Err(if cfg!(target_os = "macos") {
                "Add ⌘, ⌥, or ⌃ to the shortcut.".into()
            } else {
                "Add Ctrl, Alt, or Win to the shortcut.".into()
            });
        }
        if let Some(reason) = self.reserved_reason() {
            return Err(reason.into());
        }
        self.accelerator().ok_or_else(|| "Choose a letter, number, or Space.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_carbon_values_to_accelerators() {
        assert_eq!(LauncherShortcut::DEFAULT.accelerator().as_deref(), Some("Alt+Space"));
        assert_eq!(LauncherShortcut::new(40, CMD | SHIFT).accelerator().as_deref(), Some("Super+Shift+KeyK"));
        assert_eq!(LauncherShortcut::new(18, CONTROL).accelerator().as_deref(), Some("Control+Digit1"));
        assert_eq!(LauncherShortcut::new(999, CONTROL).accelerator(), None);
    }

    #[test]
    fn labels_match_the_swift_format_on_mac() {
        assert_eq!(LauncherShortcut::DEFAULT.default_label(true), "⌥ Space");
        assert_eq!(LauncherShortcut::new(KEY_SPACE, CMD | SHIFT).default_label(true), "⌘ ⇧ Space");
        assert_eq!(LauncherShortcut::new(KEY_SPACE, CONTROL | OPTION).default_label(false), "Ctrl+Alt+Space");
    }

    #[test]
    fn requires_a_modifier_and_rejects_reserved() {
        assert!(LauncherShortcut::new(KEY_SPACE, SHIFT).validate().is_err());
        assert!(LauncherShortcut::new(KEY_SPACE, 0).validate().is_err());
        if cfg!(target_os = "macos") {
            assert!(LauncherShortcut::new(KEY_TAB, CMD).validate().is_err());
        } else {
            assert!(LauncherShortcut::new(KEY_TAB, OPTION).validate().is_err());
        }
        assert!(LauncherShortcut::DEFAULT.validate().is_ok());
    }

    #[test]
    fn loads_saved_and_legacy_values() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = Preferences::open(dir.path().join("p.json"));
        assert_eq!(LauncherShortcut::load(&prefs), LauncherShortcut::DEFAULT);
        prefs.set("launcherShortcut", json!("controlSpace"));
        assert_eq!(LauncherShortcut::load(&prefs), LauncherShortcut::new(KEY_SPACE, CONTROL));
        LauncherShortcut::new(40, CMD).save(&prefs, "⌘ K");
        assert_eq!(LauncherShortcut::load(&prefs), LauncherShortcut::new(40, CMD));
        assert_eq!(LauncherShortcut::load(&prefs).label(&prefs), "⌘ K");
    }
}
