//! On-device speech recognition for the teleprompter.
//!
//! - macOS: `SFSpeechRecognizer` with `requiresOnDeviceRecognition`.
//! - Windows: `Windows.Media.SpeechRecognition` with a list constraint built
//!   from the script's own words, which Windows recognizes locally.
//! - Linux: not available; the teleprompter scrolls at the chosen pace.
//!
//! No recording files, network fallback, or microphone activity while paused.

use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub enum SpeechEvent {
    /// The best transcription so far. `new_segment` is true for the first
    /// result of a new recognition segment.
    Transcript { text: String, new_segment: bool },
    /// Recognition stopped; the message is safe to show the user.
    Failure(String),
}

pub type SpeechCallback = Arc<dyn Fn(SpeechEvent) + Send + Sync>;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// True when this platform has an on-device recognizer.
pub fn available() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// Start listening. `vocabulary` is the script's words (used on Windows).
///
/// On macOS this must be called on the main thread; results arrive there.
pub fn start(vocabulary: Vec<String>, callback: SpeechCallback) {
    #[cfg(target_os = "macos")]
    {
        let _ = vocabulary;
        macos::start(callback);
    }
    #[cfg(target_os = "windows")]
    windows::start(vocabulary, callback);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = vocabulary;
        callback(SpeechEvent::Failure(
            "Voice following is not available on this computer. Choose Automatic scrolling instead.".into(),
        ));
    }
}

/// Stop listening and release the microphone. On macOS call it on the main thread.
pub fn stop() {
    #[cfg(target_os = "macos")]
    macos::stop();
    #[cfg(target_os = "windows")]
    windows::stop();
}
