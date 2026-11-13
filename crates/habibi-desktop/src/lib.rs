//! Per-OS desktop integration for the Habibi shell that does not need Tauri,
//! so it can be checked for macOS, Windows and Linux from one machine:
//! clipboard history and image decoding, on-device speech for the
//! teleprompter, the agent PTY, the focus timer, launcher shortcut
//! translation and the shell's preferences file.
//!
//! The Tauri shell (`src-tauri`) owns windows, the tray and IPC and calls in
//! here for everything else. No networking lives in this crate.

pub mod clipboard;
pub mod focus;
pub mod fsutil;
pub mod images;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod prefs;
pub mod pty;
pub mod shortcut;
pub mod speech;
pub mod teleprompter;

/// A short sound when the focus timer finishes ("Glass" on macOS).
pub fn play_finish_sound() {
    #[cfg(target_os = "macos")]
    macos::play_sound("Glass");
    #[cfg(target_os = "windows")]
    // SAFETY: MessageBeep has no preconditions.
    unsafe {
        let _ = windows::Win32::System::Diagnostics::Debug::MessageBeep(
            windows::Win32::UI::WindowsAndMessaging::MB_ICONASTERISK,
        );
    }
}

/// One emoji grapheme as the Swift app accepted it: a single character
/// (approximated as at most a handful of scalars with no control
/// characters), at most 64 UTF-16 units.
pub fn valid_emoji(emoji: &str) -> bool {
    !emoji.is_empty()
        && emoji.encode_utf16().count() <= 64
        && emoji.chars().all(|c| (c as u32) >= 0x20 && c as u32 != 0x7F)
        && !emoji.chars().any(char::is_whitespace)
        && emoji.chars().filter(|c| !is_emoji_joiner(*c)).count() <= 10
        && !emoji.chars().any(|c| c.is_ascii_alphanumeric())
}

fn is_emoji_joiner(c: char) -> bool {
    matches!(c as u32, 0x200D | 0xFE0E | 0xFE0F | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_validation() {
        assert!(valid_emoji("😀"));
        assert!(valid_emoji("👩‍👩‍👧‍👦"));
        assert!(valid_emoji("🇬🇧"));
        assert!(!valid_emoji(""));
        assert!(!valid_emoji("ab"));
        assert!(!valid_emoji("😀 "));
        assert!(!valid_emoji("\u{7}"));
    }
}
