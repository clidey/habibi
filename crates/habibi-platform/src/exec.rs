//! Small helpers for starting helper programs. Arguments are always passed as
//! separate values, never through a shell.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::{PlatformError, PlatformResult};

/// A command with no console window on Windows and no inherited stdio.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Reap `child` on a background thread so a detached helper never lingers
/// as a zombie for the lifetime of the app.
pub(crate) fn reap(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// Start `command` without waiting for it, like `spawn(..., { detached: true }).unref()`.
pub(crate) fn spawn_detached(mut command: Command, failure: &str) -> PlatformResult<()> {
    match command.spawn() {
        Ok(child) => {
            reap(child);
            Ok(())
        }
        Err(_) => Err(PlatformError::Failed(failure.into())),
    }
}

/// Run to completion; true when it exited successfully.
pub(crate) fn succeeds(mut command: Command) -> bool {
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Run to completion and return stdout when it exited successfully.
#[allow(dead_code)]
pub(crate) fn output(mut command: Command) -> Option<String> {
    command.stdout(Stdio::piped());
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Find `name` on `PATH` (with `PATHEXT` on Windows).
#[allow(dead_code)]
pub(crate) fn which(name: &str) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    #[cfg(target_os = "windows")]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(str::to_string)
        .chain(std::iter::once(String::new()))
        .collect();
    #[cfg(not(target_os = "windows"))]
    let extensions = [String::new()];
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let file = directory.join(format!("{name}{extension}"));
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

/// Standard base64 with padding (used for PowerShell `-EncodedCommand`).
#[allow(dead_code)]
pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
    }
}
