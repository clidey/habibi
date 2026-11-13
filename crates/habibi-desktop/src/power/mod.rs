//! System sleep, display sleep and session lock notifications, as the Swift
//! app observed them through `NSWorkspace`:
//!
//! - macOS: `NSWorkspace` will-sleep / did-wake, screens-did-sleep / wake,
//!   session resign / become active, plus the `com.apple.screenIsLocked` /
//!   `screenIsUnlocked` distributed notifications.
//! - Windows: `WM_POWERBROADCAST` (`PBT_APMSUSPEND`, `PBT_APMRESUME*`, the
//!   console display state) and `WM_WTSSESSION_CHANGE` lock/unlock, received
//!   by a hidden window on its own thread.
//! - Linux: logind's `PrepareForSleep` and the session's `Lock`/`Unlock`
//!   signals on the system bus.
//!
//! [`PauseReasons`] turns those events into "capture should pause" state, so
//! one wake event cannot resume clipboard capture while the screen is still
//! locked.

use std::sync::Arc;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerEvent {
    /// The system is about to sleep.
    WillSleep,
    /// The system woke from sleep.
    DidWake,
    /// The displays went to sleep (or turned off).
    ScreensSlept,
    ScreensWoke,
    /// The session was locked or switched away from.
    SessionResigned,
    /// The session was unlocked or switched back to.
    SessionActivated,
}

impl PowerEvent {
    /// The Swift app paused the teleprompter on all three "going away" events.
    pub fn pauses_reading(self) -> bool {
        matches!(self, Self::WillSleep | Self::ScreensSlept | Self::SessionResigned)
    }

    /// Global hotkeys can be dropped across sleep or a session switch; the
    /// Swift app re-registered its shortcut after both.
    pub fn repairs_shortcut(self) -> bool {
        matches!(self, Self::DidWake | Self::SessionActivated)
    }
}

pub type PowerCallback = Arc<dyn Fn(PowerEvent) + Send + Sync>;

/// Why background capture is paused. Each pair of events owns one reason.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PauseReasons(u8);

const SLEEP: u8 = 1;
const SCREENS: u8 = 2;
const SESSION: u8 = 4;

impl PauseReasons {
    pub fn paused(self) -> bool {
        self.0 != 0
    }

    /// Apply an event; returns true when `paused()` changed.
    pub fn apply(&mut self, event: PowerEvent) -> bool {
        let before = self.paused();
        match event {
            PowerEvent::WillSleep => self.0 |= SLEEP,
            PowerEvent::DidWake => self.0 &= !SLEEP,
            PowerEvent::ScreensSlept => self.0 |= SCREENS,
            PowerEvent::ScreensWoke => self.0 &= !SCREENS,
            PowerEvent::SessionResigned => self.0 |= SESSION,
            PowerEvent::SessionActivated => self.0 &= !SESSION,
        }
        before != self.paused()
    }
}

/// Start delivering events to `callback` for the life of the process.
///
/// On macOS call this on the main thread; events arrive there. On Windows
/// and Linux events arrive on a background thread.
pub fn watch(callback: PowerCallback) {
    #[cfg(target_os = "macos")]
    macos::watch(callback);
    #[cfg(target_os = "windows")]
    windows::watch(callback);
    #[cfg(target_os = "linux")]
    linux::watch(callback);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let _ = callback;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_resumes_only_when_every_reason_is_gone() {
        let mut reasons = PauseReasons::default();
        assert!(reasons.apply(PowerEvent::SessionResigned));
        assert!(!reasons.apply(PowerEvent::WillSleep), "already paused");
        assert!(!reasons.apply(PowerEvent::DidWake), "still locked");
        assert!(reasons.paused());
        assert!(reasons.apply(PowerEvent::SessionActivated));
        assert!(!reasons.paused());
        // A stray wake with nothing paused changes nothing.
        assert!(!reasons.apply(PowerEvent::ScreensWoke));
    }

    #[test]
    fn events_match_the_swift_observers() {
        assert!(PowerEvent::ScreensSlept.pauses_reading());
        assert!(!PowerEvent::DidWake.pauses_reading());
        assert!(PowerEvent::DidWake.repairs_shortcut());
        assert!(PowerEvent::SessionActivated.repairs_shortcut());
        assert!(!PowerEvent::ScreensWoke.repairs_shortcut());
    }
}
