//! The teleprompter (ported from `Teleprompter.swift` and
//! `TeleprompterSpeech.swift`).
//!
//! The overlay page (`assets/teleprompter-overlay.html`) draws the script and
//! scrolls to the `progress` fraction it is sent. The Swift app measured the
//! script with an `NSTextView`; this controller uses a simple text-layout
//! model with the same geometry (font size, line spacing, insets) so the
//! scroll speed and voice-follow position match closely without a native
//! text view. The controller is a pure state machine: every call returns the
//! [`Effect`]s the shell carries out (window, clock, microphone, UI updates).

use serde_json::{Value, json};

pub const MAX_SCRIPT_UTF16: usize = 100_000;

/// Screen geometry (logical points) of the display the overlay sits on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub height: f64,
    pub visible_width: f64,
    /// Height of the camera housing / menu-bar safe area at the top.
    pub inset: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Show the overlay window (fading in).
    Present,
    /// Hide the overlay window.
    Hide,
    /// Resize the overlay; the shell centres it at the top of the screen.
    Frame { width: f64, height: f64 },
    /// Start the microphone and recognizer; deliver results with `generation`.
    Listen { generation: u64, vocabulary: Vec<String> },
    StopListening,
    /// Run (true) or stop (false) the ~30 fps scroll clock.
    Clock(bool),
    /// Send `window.__habibiTeleprompterState(value)` to the launcher.
    Notify(Value),
    /// Send the overlay its current state.
    Sync,
}

// ---------------------------------------------------------------------------
// Word tracking

#[derive(Debug, Clone, PartialEq)]
struct Word {
    normalized: String,
    /// UTF-16 offset just past the word (what the overlay's `read` counts).
    end_utf16: usize,
    /// Byte range in the script.
    start: usize,
    end: usize,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// `[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*`
fn tokenize(text: &str) -> Vec<Word> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut utf16_before = Vec::with_capacity(chars.len() + 1);
    let mut count = 0usize;
    for (_, c) in &chars {
        utf16_before.push(count);
        count += c.len_utf16();
    }
    utf16_before.push(count);
    let mut words = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if !is_word_char(chars[index].1) {
            index += 1;
            continue;
        }
        let start = index;
        loop {
            while index < chars.len() && is_word_char(chars[index].1) {
                index += 1;
            }
            if index + 1 < chars.len() && matches!(chars[index].1, '\'' | '’') && is_word_char(chars[index + 1].1) {
                index += 1;
                continue;
            }
            break;
        }
        let start_byte = chars[start].0;
        let end_byte = chars.get(index).map(|(byte, _)| *byte).unwrap_or(text.len());
        words.push(Word {
            normalized: normalize(&text[start_byte..end_byte]),
            end_utf16: utf16_before[index],
            start: start_byte,
            end: end_byte,
        });
    }
    words
}

fn fold(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'ď' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ğ' => 'g',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => 'i',
        'ł' | 'ľ' => 'l',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ř' => 'r',
        'ś' | 'š' | 'ş' => 's',
        'ť' | 'ţ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        other => other,
    }
}

/// Case- and diacritic-insensitive, apostrophes removed.
fn normalize(word: &str) -> String {
    word.chars().flat_map(char::to_lowercase).map(fold).filter(|c| !matches!(c, '\'' | '’')).collect()
}

/// Matches only new speech near the reading position, never arbitrary
/// distant keywords.
#[derive(Debug, Clone, Default)]
pub struct WordTracker {
    words: Vec<Word>,
    next_word: usize,
    previous: Vec<String>,
}

impl WordTracker {
    pub fn new(script: &str) -> Self {
        Self { words: tokenize(script), next_word: 0, previous: Vec::new() }
    }

    pub fn next_word(&self) -> usize {
        self.next_word
    }

    pub fn finished(&self) -> bool {
        !self.words.is_empty() && self.next_word == self.words.len()
    }

    /// UTF-16 length of the script already read.
    pub fn read_length(&self) -> usize {
        if self.next_word == 0 { 0 } else { self.words[self.next_word - 1].end_utf16 }
    }

    pub fn consume(&mut self, transcript: &str, new_segment: bool) {
        let spoken: Vec<String> = tokenize(transcript).into_iter().map(|word| word.normalized).collect();
        let mut common = 0;
        if !new_segment {
            while common < self.previous.len().min(spoken.len()) && self.previous[common] == spoken[common] {
                common += 1;
            }
        }
        let mut index = common;
        while index < spoken.len() && self.next_word < self.words.len() {
            if spoken[index] == self.words[self.next_word].normalized {
                self.next_word += 1;
            } else if index + 1 < spoken.len() && self.next_word + 1 < self.words.len() {
                // Skipped words need two consecutive matches, avoiding jumps on
                // incidental speech.
                let limit = (self.words.len() - 1).min(self.next_word + 12);
                if let Some(found) = (self.next_word..limit).find(|&candidate| {
                    self.words[candidate].normalized == spoken[index]
                        && self.words[candidate + 1].normalized == spoken[index + 1]
                }) {
                    self.next_word = found + 2;
                    index += 1;
                }
            }
            index += 1;
        }
        self.previous = spoken;
    }
}

// ---------------------------------------------------------------------------
// Layout model

#[derive(Debug, Clone, Default, PartialEq)]
struct Layout {
    /// Laid-out text height.
    text_height: f64,
    /// Visible scroll viewport height.
    viewport: f64,
    /// Maximum scroll offset.
    maximum: f64,
    pixels_per_second: f64,
    read_duration: f64,
    line_height: f64,
    /// Line index of each word.
    word_lines: Vec<usize>,
}

/// Average advance of the medium-weight system font, as a fraction of size.
const CHARACTER_WIDTH: f64 = 0.53;

/// Greedy word wrap. Returns the number of lines and each word's line.
fn wrap(script: &str, words: &[Word], font_size: f64, width: f64) -> (usize, Vec<usize>) {
    let per_line = ((width.max(1.0)) / (font_size * CHARACTER_WIDTH)).floor().max(1.0) as usize;
    let mut word_lines = Vec::with_capacity(words.len());
    let mut line = 0usize;
    let mut column = 0usize;
    let mut cursor = 0usize;
    for word in words {
        let gap = &script[cursor..word.start];
        let breaks = gap.matches('\n').count();
        let length = script[word.start..word.end].chars().count();
        if breaks > 0 {
            line += breaks;
            column = 0;
        } else if column > 0 {
            if column + 1 + length > per_line {
                line += 1;
                column = 0;
            } else {
                column += 1;
            }
        }
        word_lines.push(line);
        if column == 0 && length > per_line {
            let extra = (length - 1) / per_line;
            line += extra;
            column = length - extra * per_line;
        } else {
            column += length;
        }
        cursor = word.end;
    }
    let trailing = script[cursor..].matches('\n').count();
    let lines = if words.is_empty() { 1 + trailing } else { line + 1 };
    (lines.max(1), word_lines)
}

// ---------------------------------------------------------------------------
// Controller

pub struct Teleprompter {
    script: String,
    pace: f64,
    font_size: f64,
    overlay_width: f64,
    mode: String,
    voice_supported: bool,
    tracker: WordTracker,
    layout: Layout,
    offset: f64,
    target_offset: f64,
    reading_seconds: f64,
    generation: u64,
    state: String,
    presented: bool,
    clock: bool,
    error: Option<String>,
    inset: f64,
    sent_script: bool,
    frame: (f64, f64),
}

impl Teleprompter {
    /// `voice_supported` is false where no on-device recognizer exists
    /// (Linux); "Follow my voice" then scrolls at the chosen pace.
    pub fn new(voice_supported: bool) -> Self {
        Self {
            script: String::new(),
            pace: 140.0,
            font_size: 24.0,
            overlay_width: 620.0,
            mode: "voice".into(),
            voice_supported,
            tracker: WordTracker::default(),
            layout: Layout::default(),
            offset: 0.0,
            target_offset: 0.0,
            reading_seconds: 0.0,
            generation: 0,
            state: "stopped".into(),
            presented: false,
            clock: false,
            error: None,
            inset: 0.0,
            sent_script: false,
            frame: (0.0, 0.0),
        }
    }

    fn voice(&self) -> bool {
        self.mode == "voice" && self.voice_supported
    }

    fn effective_mode(&self) -> &str {
        if self.voice() { "voice" } else { "automatic" }
    }

    pub fn state(&self) -> &str {
        &self.state
    }

    pub fn presented(&self) -> bool {
        self.presented
    }

    pub fn clock_running(&self) -> bool {
        self.clock
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "state": self.state,
            "visible": self.presented,
            "pace": self.pace,
            "fontSize": self.font_size,
            "mode": self.effective_mode(),
        })
    }

    /// The overlay page reloaded; send it the script again.
    pub fn overlay_ready(&mut self) {
        self.sent_script = false;
    }

    /// The payload for `window.__habibiTeleprompterOverlayState`.
    pub fn overlay_state(&mut self) -> Value {
        let mut payload = json!({
            "state": self.state,
            "mode": self.effective_mode(),
            "pace": self.pace,
            "fontSize": self.font_size,
            "inset": self.inset,
            "progress": (self.offset / self.layout.maximum.max(1.0)).clamp(0.0, 1.0),
            "read": self.tracker.read_length(),
            "error": self.error.clone().unwrap_or_default(),
        });
        if !self.sent_script {
            payload["script"] = Value::String(self.script.clone());
            self.sent_script = true;
        }
        payload
    }

    fn configure(&mut self, settings: &Value) {
        let bounded = |key: &str, fallback: f64, low: f64, high: f64| {
            settings.get(key).and_then(Value::as_f64).filter(|value| value.is_finite()).map(|v| v.clamp(low, high)).unwrap_or(fallback)
        };
        self.pace = bounded("pace", self.pace, 60.0, 260.0);
        self.font_size = bounded("fontSize", self.font_size, 16.0, 40.0);
        self.overlay_width = bounded("width", self.overlay_width, 380.0, 900.0);
        if let Some(mode) = settings.get("mode").and_then(Value::as_str).filter(|m| ["voice", "automatic"].contains(m)) {
            self.mode = mode.into();
        }
    }

    /// Size the overlay for `screen` and lay the script out in it.
    fn layout(&mut self, screen: Screen, effects: &mut Vec<Effect>) {
        let width = self.overlay_width.min(screen.visible_width - 32.0).max(120.0);
        self.inset = screen.inset;
        let line_height = self.font_size * 1.2 + self.font_size * 0.3;
        let words = tokenize(&self.script);
        let measure = |width: f64| {
            let (lines, word_lines) = wrap(&self.script, &words, self.font_size, width);
            (lines as f64 * line_height, word_lines)
        };
        let (measured, _) = measure(width - 44.0);
        let reading_height = (measured.max(self.font_size * 1.3) + 24.0).min(self.font_size * 3.9 + 24.0);
        let height = (screen.inset + 38.0 + reading_height).min(screen.height * 0.4);
        if (width, height) != self.frame {
            self.frame = (width, height);
            effects.push(Effect::Frame { width, height });
        }
        let viewport = (height - screen.inset - 38.0).max(1.0);
        // Text sits inside 10 pt scroll margins and a 12 pt text inset.
        let (text_height, word_lines) = measure(width - 20.0 - 24.0);
        let document = if text_height + 24.0 <= viewport { viewport } else { text_height + viewport * 0.65 + 24.0 };
        let word_count = words.len().max(1) as f64;
        self.layout = Layout {
            text_height,
            viewport,
            maximum: (document - viewport).max(0.0),
            pixels_per_second: (text_height / word_count * self.pace / 60.0).max(4.0),
            read_duration: word_count / self.pace * 60.0,
            line_height,
            word_lines,
        };
        if self.voice() {
            self.highlight();
        }
        effects.push(Effect::Sync);
    }

    fn highlight(&mut self) {
        if self.layout.word_lines.is_empty() {
            return;
        }
        let index = self.tracker.next_word().min(self.layout.word_lines.len() - 1);
        self.target_offset = (self.layout.word_lines[index] as f64 * self.layout.line_height).max(0.0);
    }

    fn set_state(&mut self, value: &str, effects: &mut Vec<Effect>) {
        self.state = value.into();
        effects.push(Effect::Sync);
        effects.push(Effect::Notify(self.snapshot()));
    }

    fn stop_clock(&mut self, effects: &mut Vec<Effect>) {
        if self.clock {
            self.clock = false;
            effects.push(Effect::Clock(false));
        }
    }

    fn start_clock(&mut self, effects: &mut Vec<Effect>) {
        if !self.clock {
            self.clock = true;
            effects.push(Effect::Clock(true));
        }
    }

    fn pause(&mut self, notify: bool, effects: &mut Vec<Effect>) {
        self.stop_clock(effects);
        self.generation += 1;
        effects.push(Effect::StopListening);
        if self.state == "running" || self.presented {
            if notify {
                self.set_state("paused", effects);
            } else {
                self.state = "paused".into();
            }
        }
    }

    fn restart_reading(&mut self) {
        self.tracker = WordTracker::new(&self.script);
        self.reading_seconds = 0.0;
        self.target_offset = 0.0;
        self.offset = 0.0;
    }

    fn resume(&mut self, screen: Screen, effects: &mut Vec<Effect>) {
        if !self.presented || self.script.is_empty() || self.state == "running" {
            return;
        }
        self.error = None;
        if self.state == "finished" {
            self.restart_reading();
            self.layout(screen, effects);
        }
        self.set_state("running", effects);
        if self.voice() {
            self.generation += 1;
            let mut vocabulary: Vec<String> = Vec::new();
            for word in &self.tracker.words {
                if !vocabulary.contains(&word.normalized) && vocabulary.len() < 2000 {
                    vocabulary.push(word.normalized.clone());
                }
            }
            effects.push(Effect::Listen { generation: self.generation, vocabulary });
            return;
        }
        if self.layout.maximum > 0.0 && self.offset >= self.layout.maximum - 1.0 {
            self.offset = 0.0;
        }
        self.start_clock(effects);
    }

    fn finish(&mut self, effects: &mut Vec<Effect>) {
        self.pause(false, effects);
        self.set_state("finished", effects);
    }

    pub fn stop(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.pause(false, &mut effects);
        self.presented = false;
        self.set_state("stopped", &mut effects);
        effects.push(Effect::Hide);
        effects
    }

    /// Pause from outside (sleep, screen change). No-op when not reading.
    pub fn pause_external(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.state == "running" {
            self.pause(true, &mut effects);
        }
        effects
    }

    pub fn toggle(&mut self, screen: Screen) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.state == "running" {
            self.pause(true, &mut effects);
        } else {
            self.resume(screen, &mut effects);
        }
        effects
    }

    /// Handle a bridge message. `None` means the request was invalid (the
    /// shell reports "Paste a script of up to 100,000 characters to start.").
    pub fn handle(&mut self, settings: &Value, screen: Screen) -> Option<Vec<Effect>> {
        let action = settings.get("action").and_then(Value::as_str).unwrap_or("state");
        let mut effects = Vec::new();
        match action {
            "start" => {
                let script = settings.get("script").and_then(Value::as_str)?;
                if script.trim().is_empty() || script.encode_utf16().count() > MAX_SCRIPT_UTF16 {
                    return None;
                }
                self.pause(false, &mut effects);
                self.script = script.to_string();
                self.error = None;
                self.sent_script = false;
                self.restart_reading();
                self.configure(settings);
                self.frame = (0.0, 0.0);
                self.layout(screen, &mut effects);
                self.presented = true;
                effects.push(Effect::Present);
                self.resume(screen, &mut effects);
            }
            "pause" => self.pause(true, &mut effects),
            "resume" => self.resume(screen, &mut effects),
            "stop" => effects = self.stop(),
            "reset" => {
                let reading = self.state == "running";
                self.pause(false, &mut effects);
                self.restart_reading();
                self.layout(screen, &mut effects);
                if reading {
                    self.resume(screen, &mut effects);
                } else {
                    let next = if self.presented { "paused" } else { "stopped" };
                    self.set_state(next, &mut effects);
                }
            }
            "configure" => {
                let reading = self.state == "running";
                let fraction = self.offset / self.layout.maximum.max(1.0);
                self.pause(false, &mut effects);
                self.configure(settings);
                if self.presented {
                    self.layout(screen, &mut effects);
                    self.offset = fraction * self.layout.maximum;
                }
                if reading {
                    self.resume(screen, &mut effects);
                } else {
                    effects.push(Effect::Notify(self.snapshot()));
                }
            }
            "state" => effects.push(Effect::Notify(self.snapshot())),
            _ => return None,
        }
        Some(effects)
    }

    /// Advance the scroll clock by `elapsed` seconds.
    pub fn tick(&mut self, elapsed: f64) -> Vec<Effect> {
        let mut effects = Vec::new();
        if !self.clock {
            return effects;
        }
        if !self.presented {
            self.pause(false, &mut effects);
            return effects;
        }
        let elapsed = elapsed.clamp(0.0, 0.1);
        self.reading_seconds += elapsed;
        let maximum = self.layout.maximum;
        let destination = if self.voice() { maximum.min(self.target_offset) } else { maximum };
        self.offset = destination.min(self.offset + elapsed * self.layout.pixels_per_second);
        effects.push(Effect::Sync);
        if self.voice() && self.offset >= destination {
            self.stop_clock(&mut effects);
            if self.tracker.finished() {
                self.finish(&mut effects);
            }
        } else if !self.voice() && self.reading_seconds >= self.layout.read_duration && self.offset >= maximum {
            self.finish(&mut effects);
        }
        effects
    }

    /// A transcript from the recognizer started with `generation`.
    pub fn transcript(&mut self, generation: u64, text: &str, new_segment: bool) -> Vec<Effect> {
        let mut effects = Vec::new();
        if generation != self.generation || self.state != "running" {
            return effects;
        }
        let previous = self.tracker.next_word();
        self.tracker.consume(text, new_segment);
        if previous == self.tracker.next_word() {
            return effects;
        }
        self.highlight();
        effects.push(Effect::Sync);
        if (self.target_offset.min(self.layout.maximum) - self.offset).abs() > 0.5 {
            self.start_clock(&mut effects);
        } else if self.tracker.finished() {
            self.finish(&mut effects);
        }
        effects
    }

    /// The recognizer started with `generation` failed with a user-safe message.
    pub fn speech_failed(&mut self, generation: u64, message: &str) -> Vec<Effect> {
        let mut effects = Vec::new();
        if generation != self.generation {
            return effects;
        }
        self.pause(true, &mut effects);
        self.error = Some("Voice unavailable".into());
        effects.push(Effect::Sync);
        let mut value = self.snapshot();
        value["error"] = Value::String(message.into());
        effects.push(Effect::Notify(value));
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Screen = Screen { height: 900.0, visible_width: 1440.0, inset: 0.0 };

    #[test]
    fn tokenizes_like_the_swift_regex() {
        let words: Vec<String> = tokenize("Don’t stop — it's 3 o'clock, Élan!").into_iter().map(|w| w.normalized).collect();
        assert_eq!(words, ["dont", "stop", "its", "3", "oclock", "elan"]);
    }

    #[test]
    fn tracks_spoken_words_and_skips_only_on_two_matches() {
        let mut tracker = WordTracker::new("one two three four five six");
        tracker.consume("one two", true);
        assert_eq!(tracker.next_word(), 2);
        // Partial results repeat the prefix; only new words count.
        tracker.consume("one two three", false);
        assert_eq!(tracker.next_word(), 3);
        // A single distant word does not jump.
        tracker.consume("six", true);
        assert_eq!(tracker.next_word(), 3);
        // Two consecutive matches skip ahead.
        tracker.consume("five six", true);
        assert_eq!(tracker.next_word(), 6);
        assert!(tracker.finished());
        assert_eq!(tracker.read_length(), "one two three four five six".len());
    }

    #[test]
    fn read_length_counts_utf16_units() {
        let mut tracker = WordTracker::new("😀 hi there");
        tracker.consume("hi", true);
        assert_eq!(tracker.read_length(), 2 + 1 + 2);
    }

    #[test]
    fn rejects_empty_or_oversized_scripts() {
        let mut prompter = Teleprompter::new(true);
        assert!(prompter.handle(&json!({ "action": "start", "script": "   " }), SCREEN).is_none());
        let long = "a".repeat(MAX_SCRIPT_UTF16 + 1);
        assert!(prompter.handle(&json!({ "action": "start", "script": long }), SCREEN).is_none());
        assert!(prompter.handle(&json!({ "action": "bogus" }), SCREEN).is_none());
    }

    #[test]
    fn automatic_mode_scrolls_to_the_end_and_finishes() {
        let mut prompter = Teleprompter::new(true);
        let script = "word ".repeat(120);
        let effects =
            prompter.handle(&json!({ "action": "start", "script": script, "mode": "automatic", "pace": 260 }), SCREEN).unwrap();
        assert!(effects.contains(&Effect::Present));
        assert!(effects.contains(&Effect::Clock(true)));
        assert!(effects.iter().any(|e| matches!(e, Effect::Frame { .. })));
        assert_eq!(prompter.state(), "running");
        let mut finished = false;
        for _ in 0..20_000 {
            if prompter.tick(0.1).iter().any(|e| matches!(e, Effect::Notify(v) if v["state"] == "finished")) {
                finished = true;
                break;
            }
        }
        assert!(finished);
        assert_eq!(prompter.overlay_state()["progress"], 1.0);
    }

    #[test]
    fn voice_mode_listens_and_follows_transcripts() {
        let mut prompter = Teleprompter::new(true);
        let effects = prompter.handle(&json!({ "action": "start", "script": "hello there friend" }), SCREEN).unwrap();
        let generation = effects
            .iter()
            .find_map(|e| match e {
                Effect::Listen { generation, vocabulary } => {
                    assert_eq!(vocabulary, &["hello", "there", "friend"]);
                    Some(*generation)
                }
                _ => None,
            })
            .unwrap();
        assert!(prompter.transcript(generation + 1, "hello", true).is_empty(), "stale recognizers are ignored");
        prompter.transcript(generation, "hello there friend", true);
        assert_eq!(prompter.state(), "finished");
        let failed = prompter.speech_failed(generation, "nope");
        assert!(failed.is_empty(), "a finished session has a new generation");
    }

    #[test]
    fn linux_voice_mode_falls_back_to_timed_scroll() {
        let mut prompter = Teleprompter::new(false);
        let effects = prompter.handle(&json!({ "action": "start", "script": "a b c" }), SCREEN).unwrap();
        assert!(!effects.iter().any(|e| matches!(e, Effect::Listen { .. })));
        assert!(effects.contains(&Effect::Clock(true)));
        assert_eq!(prompter.snapshot()["mode"], "automatic");
    }

    #[test]
    fn overlay_gets_the_script_once_until_it_reloads() {
        let mut prompter = Teleprompter::new(true);
        prompter.handle(&json!({ "action": "start", "script": "hi" }), SCREEN).unwrap();
        assert!(prompter.overlay_state().get("script").is_some());
        assert!(prompter.overlay_state().get("script").is_none());
        prompter.overlay_ready();
        assert!(prompter.overlay_state().get("script").is_some());
        let effects = prompter.stop();
        assert!(effects.contains(&Effect::Hide));
        assert!(!prompter.presented());
    }

    #[test]
    fn wrapping_counts_lines() {
        let script = "aaaa bbbb\ncccc";
        let words = tokenize(script);
        // 5 characters per line at font 10 (width 26.5 / 5.3).
        let (lines, word_lines) = wrap(script, &words, 10.0, 26.5);
        assert_eq!(word_lines, [0, 1, 2]);
        assert_eq!(lines, 3);
    }
}
