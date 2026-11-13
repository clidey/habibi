//! The focus timer (ported from `FocusTimer.swift`). The shell owns the
//! overlay window and the one-second tick; this is the state machine.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::prefs::Preferences;

const KEY: &str = "focusSession";

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct FocusSession {
    pub duration: f64,
    pub remaining: f64,
    /// Unix seconds when a running session ends.
    pub deadline: Option<f64>,
    pub state: String,
    pub label: String,
}

impl Default for FocusSession {
    fn default() -> Self {
        Self { duration: 1500.0, remaining: 1500.0, deadline: None, state: "idle".into(), label: "Focus".into() }
    }
}

impl FocusSession {
    pub fn tick(&mut self, now: f64) {
        if self.state != "running" {
            return;
        }
        let Some(end) = self.deadline else { return };
        self.remaining = (end - now).ceil().max(0.0);
        if self.remaining == 0.0 {
            self.state = "finished".into();
            self.deadline = None;
        }
    }

    pub fn start(&mut self, seconds: f64, label: &str, now: f64) -> bool {
        if !seconds.is_finite() || !(60.0..=14_400.0).contains(&seconds) || label.encode_utf16().count() > 100 {
            return false;
        }
        self.duration = seconds;
        self.remaining = seconds;
        self.deadline = Some(now + seconds);
        self.state = "running".into();
        self.label = if label.is_empty() { "Focus".into() } else { label.into() };
        true
    }

    pub fn pause(&mut self, now: f64) {
        self.tick(now);
        if self.state == "running" {
            self.state = "paused".into();
            self.deadline = None;
        }
    }

    pub fn resume(&mut self, now: f64) {
        if self.state == "paused" && self.remaining > 0.0 {
            self.state = "running".into();
            self.deadline = Some(now + self.remaining);
        }
    }

    pub fn reset(&mut self) {
        self.state = "idle".into();
        self.deadline = None;
        self.remaining = self.duration;
    }
}

/// What the shell should do after a timer action.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct FocusOutcome {
    pub reply: Value,
    pub show: bool,
    pub hide: bool,
}

pub struct FocusTimer {
    pub session: FocusSession,
    pub visible: bool,
}

impl FocusTimer {
    pub fn load(prefs: &Preferences) -> Self {
        let mut session = FocusSession::default();
        if let Some(Value::Object(saved)) = prefs.get(KEY) {
            session.duration = saved.get("duration").and_then(Value::as_f64).unwrap_or(1500.0);
            session.remaining = saved.get("remaining").and_then(Value::as_f64).unwrap_or(session.duration);
            session.state = saved.get("state").and_then(Value::as_str).unwrap_or("idle").into();
            session.label = saved.get("label").and_then(Value::as_str).unwrap_or("Focus").into();
            session.deadline = saved.get("deadline").and_then(Value::as_f64);
            session.tick(now());
        }
        Self { session, visible: false }
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "ok": true,
            "state": self.session.state,
            "remaining": self.session.remaining,
            "duration": self.session.duration,
            "label": self.session.label,
            "visible": self.visible,
        })
    }

    pub fn running(&self) -> bool {
        self.session.state == "running"
    }

    pub fn save(&self, prefs: &Preferences) {
        let mut value = Map::new();
        value.insert("state".into(), self.session.state.clone().into());
        value.insert("duration".into(), self.session.duration.into());
        value.insert("remaining".into(), self.session.remaining.into());
        value.insert("label".into(), self.session.label.clone().into());
        if let Some(deadline) = self.session.deadline {
            value.insert("deadline".into(), deadline.into());
        }
        prefs.set(KEY, Value::Object(value));
    }

    /// Handle a `{ action, seconds?, label? }` request from the UI or overlay.
    pub fn handle(&mut self, value: &Value, prefs: &Preferences) -> FocusOutcome {
        let action = value.get("action").and_then(Value::as_str).unwrap_or("state");
        let mut outcome = FocusOutcome::default();
        let now = now();
        match action {
            "start" => {
                let seconds = value.get("seconds").and_then(Value::as_f64).unwrap_or(1500.0);
                let label = value.get("label").and_then(Value::as_str).unwrap_or("Focus");
                if !self.session.start(seconds, label, now) {
                    outcome.reply = json!({ "ok": false, "error": "Choose a timer between 1 minute and 4 hours." });
                    return outcome;
                }
                self.visible = true;
                outcome.show = true;
            }
            "pause" => self.session.pause(now),
            "resume" => self.session.resume(now),
            "reset" => self.session.reset(),
            "show" => {
                self.visible = true;
                outcome.show = true;
            }
            "hide" => {
                self.visible = false;
                outcome.hide = true;
            }
            "state" => self.session.tick(now),
            _ => {
                outcome.reply = json!({ "ok": false, "error": "Unknown timer action." });
                return outcome;
            }
        }
        self.save(prefs);
        outcome.reply = self.snapshot();
        outcome
    }

    /// One-second tick. Returns true when the session just finished (the
    /// shell plays a sound and shows the overlay).
    pub fn tick(&mut self, prefs: &Preferences) -> bool {
        let was_running = self.running();
        self.session.tick(now());
        if was_running && self.session.state == "finished" {
            self.visible = true;
            self.save(prefs);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_bounds_and_transitions() {
        let mut session = FocusSession::default();
        assert!(!session.start(30.0, "x", 0.0));
        assert!(!session.start(f64::NAN, "x", 0.0));
        assert!(!session.start(20_000.0, "x", 0.0));
        assert!(session.start(120.0, "", 0.0));
        assert_eq!(session.label, "Focus");
        session.pause(30.2);
        assert_eq!(session.state, "paused");
        assert_eq!(session.remaining, 90.0);
        session.resume(100.0);
        session.tick(190.0);
        assert_eq!(session.state, "finished");
        session.reset();
        assert_eq!((session.state.as_str(), session.remaining), ("idle", 120.0));
    }

    #[test]
    fn persists_and_reports_errors() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = Preferences::open(dir.path().join("p.json"));
        let mut timer = FocusTimer::load(&prefs);
        let outcome = timer.handle(&json!({ "action": "start", "seconds": 10 }), &prefs);
        assert_eq!(outcome.reply["ok"], false);
        let outcome = timer.handle(&json!({ "action": "start", "seconds": 600, "label": "Write" }), &prefs);
        assert!(outcome.show);
        assert_eq!(outcome.reply["state"], "running");
        let reloaded = FocusTimer::load(&prefs);
        assert_eq!(reloaded.session.label, "Write");
        assert!(reloaded.session.deadline.is_some());
        assert_eq!(timer.handle(&json!({ "action": "nope" }), &prefs).reply["ok"], false);
    }
}
