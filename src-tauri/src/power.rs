//! Sleep, display sleep and session lock, as the Swift app handled them:
//! pause the teleprompter, pause clipboard capture until every reason has
//! cleared (then skip whatever was copied meanwhile), and re-register the
//! global shortcut after wake or a session switch.

use std::sync::{Arc, Mutex};

use habibi_desktop::power::{PauseReasons, PowerCallback, PowerEvent};

use crate::shell::Shell;
use crate::{overlays, shortcut};

fn handle(shell: &Arc<Shell>, reasons: &Mutex<PauseReasons>, event: PowerEvent) {
    if event.pauses_reading() {
        overlays::pause_teleprompter(shell);
    }
    let paused = {
        let mut reasons = reasons.lock().unwrap_or_else(|e| e.into_inner());
        reasons.apply(event).then(|| reasons.paused())
    };
    if let Some(paused) = paused {
        shell.clipboard.lock().unwrap_or_else(|e| e.into_inner()).set_sleeping(paused);
    }
    if event.repairs_shortcut() {
        shortcut::schedule_repair(shell);
    }
    if crate::shell_log() {
        let capture = shell.clipboard.lock().unwrap_or_else(|e| e.into_inner()).sleeping();
        let reading = shell.prompter.lock().unwrap_or_else(|e| e.into_inner()).state().to_string();
        eprintln!("[power] {event:?}: clipboard paused={capture} teleprompter={reading}");
    }
}

/// Start watching. Call once from setup, on the main thread.
pub fn install(shell: &Arc<Shell>) {
    let weak = Arc::downgrade(shell);
    let reasons = Arc::new(Mutex::new(PauseReasons::default()));
    let callback: PowerCallback = Arc::new(move |event| {
        if let Some(shell) = weak.upgrade() {
            handle(&shell, &reasons, event);
        }
    });
    habibi_desktop::power::watch(callback);
}
