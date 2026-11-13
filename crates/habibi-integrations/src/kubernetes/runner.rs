//! Runs `kubectl`. Injectable so tests never reach a real cluster.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncReadExt;

/// How a bounded kubectl read ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// The process exited; `code` is 1 when it was ended by a signal.
    Exited { code: i32, stdout: String, stderr: String },
    /// Stdout passed the limit and the process was stopped.
    TooLarge,
    /// Still running after the time limit and stopped.
    TimedOut,
    /// The program does not exist.
    NotFound,
    /// It exists but could not be started.
    StartFailed,
}

#[async_trait]
pub trait KubectlRunner: Send + Sync {
    /// Run `kubectl` with exactly `args` (never through a shell).
    async fn run(&self, args: &[String], max_output_bytes: usize) -> RunOutcome;
}

/// Stderr is only shown as a short message, so keep a bounded prefix.
const MAX_STDERR_BYTES: usize = 256 * 1024;

/// The real `kubectl` (`kubectl.exe` on Windows).
pub struct SystemKubectl {
    program: PathBuf,
    path: Option<String>,
    timeout: Duration,
}

impl SystemKubectl {
    pub fn new() -> Self {
        let path = child_path();
        let program = resolve(if cfg!(windows) { "kubectl.exe" } else { "kubectl" }, path.as_deref());
        Self { program, path, timeout: Duration::from_secs(10) }
    }

    /// Any other program, for exercising the runner itself in tests.
    #[cfg(test)]
    pub fn with_program(program: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self { program: program.into(), path: None, timeout }
    }
}

impl Default for SystemKubectl {
    fn default() -> Self {
        Self::new()
    }
}

/// The macOS app is started by launchd with a minimal `PATH`. The Swift app
/// gave the Node service `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, so
/// kubectl and its credential plugins (installed by Homebrew) were found;
/// keep those directories first. Elsewhere the inherited `PATH` is used.
fn child_path() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let mut entries: Vec<String> =
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].iter().map(|s| s.to_string()).collect();
    if let Ok(existing) = std::env::var("PATH") {
        for entry in existing.split(':').filter(|entry| !entry.is_empty()) {
            if !entries.iter().any(|known| known == entry) {
                entries.push(entry.to_string());
            }
        }
    }
    Some(entries.join(":"))
}

fn resolve(name: &str, path: Option<&str>) -> PathBuf {
    let search = path.map(str::to_string).or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    let separator = if cfg!(windows) { ';' } else { ':' };
    search
        .split(separator)
        .filter(|entry| !entry.is_empty())
        .map(|entry| PathBuf::from(entry).join(name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

#[async_trait]
impl KubectlRunner for SystemKubectl {
    async fn run(&self, args: &[String], max_output_bytes: usize) -> RunOutcome {
        let mut command = tokio::process::Command::new(&self.program);
        command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return RunOutcome::NotFound,
            Err(_) => return RunOutcome::StartFailed,
        };
        let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return RunOutcome::StartFailed;
        };
        let work = async move {
            let errors = tokio::spawn(async move {
                let mut kept = Vec::new();
                let mut chunk = [0u8; 8192];
                while let Ok(read) = stderr.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    if kept.len() < MAX_STDERR_BYTES {
                        kept.extend_from_slice(&chunk[..read.min(MAX_STDERR_BYTES - kept.len())]);
                    }
                }
                kept
            });
            let mut output = Vec::new();
            let mut chunk = [0u8; 16384];
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        output.extend_from_slice(&chunk[..read]);
                        if output.len() > max_output_bytes {
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            errors.abort();
                            return RunOutcome::TooLarge;
                        }
                    }
                }
            }
            let code = match child.wait().await {
                Ok(status) => status.code().unwrap_or(1),
                Err(_) => 1,
            };
            let stderr = errors.await.unwrap_or_default();
            RunOutcome::Exited {
                code,
                stdout: String::from_utf8_lossy(&output).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            }
        };
        // Dropping the future on timeout drops the child, which kills it.
        tokio::time::timeout(self.timeout, work).await.unwrap_or(RunOutcome::TimedOut)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    #[tokio::test]
    async fn the_runner_bounds_output_time_and_reports_missing_programs() {
        let runner = SystemKubectl::with_program("/bin/sh", Duration::from_secs(5));
        assert_eq!(
            runner.run(&sh("printf ok; printf bad >&2; exit 3"), 100).await,
            RunOutcome::Exited { code: 3, stdout: "ok".into(), stderr: "bad".into() }
        );
        assert_eq!(runner.run(&sh("while :; do printf xxxxxxxxxx; done"), 1000).await, RunOutcome::TooLarge);
        let slow = SystemKubectl::with_program("/bin/sh", Duration::from_millis(200));
        assert_eq!(slow.run(&sh("sleep 5"), 1000).await, RunOutcome::TimedOut);
        let missing = SystemKubectl::with_program("/nonexistent/kubectl", Duration::from_secs(1));
        assert_eq!(missing.run(&[], 10).await, RunOutcome::NotFound);
    }
}
