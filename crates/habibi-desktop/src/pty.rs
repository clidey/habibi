//! The interactive agent terminal (ported from the `/pty` WebSocket in
//! `server.js`).
//!
//! This hands out a login shell, so every field from the UI is validated
//! here rather than trusted: the project directory must be an existing
//! directory strictly inside the home folder, the agent is `claude` or
//! `codex`, a session id must look like one, and sizes are clamped before
//! they reach the PTY.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};

pub const UNAVAILABLE: &str = "Project directory unavailable";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    /// Anything other than `claude` is Codex, as in the Node host.
    pub fn parse(kind: Option<&str>) -> Self {
        if kind == Some("claude") { Self::Claude } else { Self::Codex }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// `claude --resume [id]` / `codex resume [id]`.
    pub fn argv(self, session_id: &str) -> Vec<String> {
        let mut argv = match self {
            Self::Claude => vec!["claude".to_string(), "--resume".to_string()],
            Self::Codex => vec!["codex".to_string(), "resume".to_string()],
        };
        if !session_id.is_empty() {
            argv.push(session_id.to_string());
        }
        argv
    }
}

/// `/^[0-9a-f-]{16,80}$/i`, else empty.
pub fn session_id(value: Option<&str>) -> String {
    match value {
        Some(id) if (16..=80).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') => id.into(),
        _ => String::new(),
    }
}

/// `path.resolve`: absolute against the process directory, `.`/`..` removed
/// lexically (symlinks are not followed, as in Node).
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

/// The project directory, or [`UNAVAILABLE`].
pub fn validate_cwd(cwd: Option<&str>, home: &Path) -> Result<PathBuf, &'static str> {
    let cwd = resolve(Path::new(cwd.ok_or(UNAVAILABLE)?));
    let home = resolve(home);
    if cwd == home || !cwd.starts_with(&home) || !cwd.exists() {
        return Err(UNAVAILABLE);
    }
    Ok(cwd)
}

/// POSIX single-quote a word for `sh -lc`.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// True for words `cmd.exe` passes through literally: no `& | < > ^ % ! "`,
/// spaces or other metacharacters. Every word Habibi sends is fixed or a
/// validated session id, so this is a second barrier, not a filter.
pub fn cmd_safe(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The command line for an agent session on this OS.
pub fn command(agent: Agent, session_id: &str, cwd: &Path) -> Result<CommandBuilder, &'static str> {
    let argv = agent.argv(session_id);
    let mut command = if cfg!(windows) {
        // `claude`/`codex` are usually npm `.cmd` shims, which only cmd.exe
        // can run. `/d` skips AutoRun; `/c` runs the one command and exits.
        if !argv.iter().all(|word| cmd_safe(word)) {
            return Err("Invalid terminal message");
        }
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = CommandBuilder::new(shell);
        command.args(["/d", "/c"]);
        command.args(&argv);
        command
    } else {
        let shell = std::env::var("SHELL").ok().filter(|shell| !shell.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
        let mut command = CommandBuilder::new(shell);
        command.arg("-lc");
        command.arg(argv.iter().map(|word| shell_quote(word)).collect::<Vec<_>>().join(" "));
        command
    };
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    Ok(command)
}

/// `cols` 20–1000 and `rows` 5–1000; non-finite values are ignored.
pub fn clamp_size(cols: f64, rows: f64) -> Option<(u16, u16)> {
    if !cols.is_finite() || !rows.is_finite() {
        return None;
    }
    Some((cols.trunc().clamp(20.0, 1000.0) as u16, rows.trunc().clamp(5.0, 1000.0) as u16))
}

/// Incremental UTF-8 decoding so a multi-byte character split across reads
/// is not replaced with U+FFFD.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) => match error.error_len() {
                Some(_) => self.pending.len(),
                None => error.valid_up_to(),
            },
        };
        let text = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
        self.pending.drain(..valid);
        text
    }
}

pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl PtySession {
    /// Validate and start a session; `sink` receives the UI messages
    /// (`started`, `data`, `exit`, `error`).
    pub fn start(message: &Value, home: &Path, sink: Sink) -> Result<Self, &'static str> {
        let cwd = message.get("cwd").and_then(Value::as_str);
        let cwd = validate_cwd(cwd, home)?;
        let agent = Agent::parse(message.get("kind").and_then(Value::as_str));
        let id = session_id(message.get("sessionId").and_then(Value::as_str));
        let command = command(agent, &id, &cwd)?;
        let pair = native_pty_system()
            .openpty(PtySize { rows: 32, cols: 120, pixel_width: 0, pixel_height: 0 })
            .map_err(|_| "Could not start the terminal")?;
        let mut child = pair.slave.spawn_command(command).map_err(|_| "Could not start the terminal")?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|_| "Could not start the terminal")?;
        let writer = pair.master.take_writer().map_err(|_| "Could not start the terminal")?;
        sink(json!({ "type": "started", "kind": agent.name() }));
        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let data = decoder.push(&buffer[..count]);
                        if !data.is_empty() {
                            sink(json!({ "type": "data", "data": data }));
                        }
                    }
                }
            }
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            sink(json!({ "type": "exit", "exitCode": code }));
        });
        Ok(Self { master: pair.master, writer: Mutex::new(writer), killer: Mutex::new(killer) })
    }

    pub fn write(&self, data: &str) {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writer.write_all(data.as_bytes());
        let _ = writer.flush();
    }

    pub fn resize(&self, cols: f64, rows: f64) {
        if let Some((cols, rows)) = clamp_size(cols, rows) {
            let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn kill(&self) {
        let _ = self.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_must_be_an_existing_directory_strictly_inside_home() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join("project");
        std::fs::create_dir(&project).unwrap();
        assert_eq!(validate_cwd(Some(project.to_str().unwrap()), home.path()).unwrap(), project);
        assert!(validate_cwd(Some(home.path().to_str().unwrap()), home.path()).is_err());
        assert!(validate_cwd(Some(home.path().join("missing").to_str().unwrap()), home.path()).is_err());
        let escape = project.join("../..");
        assert!(validate_cwd(Some(escape.to_str().unwrap()), home.path()).is_err());
        assert!(validate_cwd(None, home.path()).is_err());
        // A sibling sharing the home prefix is outside it.
        let sibling = format!("{}-other", home.path().display());
        assert!(validate_cwd(Some(&sibling), home.path()).is_err());
    }

    #[test]
    fn kind_and_session_id_are_validated() {
        assert_eq!(Agent::parse(Some("claude")), Agent::Claude);
        assert_eq!(Agent::parse(Some("rm -rf")), Agent::Codex);
        assert_eq!(Agent::parse(None), Agent::Codex);
        assert_eq!(session_id(Some("0123456789abcdef")), "0123456789abcdef");
        assert_eq!(session_id(Some("0123456789ABCDEF-0000")), "0123456789ABCDEF-0000");
        assert_eq!(session_id(Some("short")), "");
        assert_eq!(session_id(Some("0123456789abcdef; rm -rf ~")), "");
        assert_eq!(session_id(Some(&"a".repeat(81))), "");
        assert_eq!(Agent::Claude.argv(""), ["claude", "--resume"]);
        assert_eq!(Agent::Codex.argv("0123456789abcdef"), ["codex", "resume", "0123456789abcdef"]);
    }

    #[test]
    fn quoting_is_safe_for_both_shells() {
        assert_eq!(shell_quote("claude"), "'claude'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert!(cmd_safe("--resume"));
        assert!(!cmd_safe("a&b"));
        assert!(!cmd_safe("a b"));
        assert!(!cmd_safe("%PATH%"));
        assert!(!cmd_safe(""));
    }

    #[test]
    fn resize_is_clamped_and_rejects_nan() {
        assert_eq!(clamp_size(10.0, 2.0), Some((20, 5)));
        assert_eq!(clamp_size(5000.0, 5000.0), Some((1000, 1000)));
        assert_eq!(clamp_size(80.9, 24.2), Some((80, 24)));
        assert_eq!(clamp_size(f64::NAN, 24.0), None);
        assert_eq!(clamp_size(80.0, f64::INFINITY), None);
    }

    #[test]
    fn utf8_split_across_reads_is_kept_whole() {
        let mut stream = Utf8Stream::default();
        let bytes = "é😀".as_bytes();
        let mut out = stream.push(&bytes[..1]);
        out += &stream.push(&bytes[1..4]);
        out += &stream.push(&bytes[4..]);
        assert_eq!(out, "é😀");
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_login_shell_in_the_project() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join("p");
        std::fs::create_dir(&project).unwrap();
        let command = command(Agent::Claude, "0123456789abcdef", &project).unwrap();
        let argv: Vec<String> = command.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(argv[1], "-lc");
        assert_eq!(argv[2], "'claude' '--resume' '0123456789abcdef'");
    }
}
