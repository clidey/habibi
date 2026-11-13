//! Open a URL, file or folder with the user's default handler
//! (`open` on macOS, `ShellExecute` on Windows, `xdg-open` on Linux).

use std::process::{Command, Stdio};

use crate::PlatformResult;

fn command(target: &str) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/open");
        command.arg(target);
        command
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `explorer` hands the target to the shell's default handler without
        // `cmd /c start` re-parsing it, so `&` in a URL cannot start a command.
        let mut command = Command::new("explorer.exe");
        command.arg(target).creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    }
}

/// Start opening `target` without waiting for the handler.
pub fn open_detached(target: &str) -> PlatformResult<()> {
    let mut command = command(target);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::exec::spawn_detached(command, "That could not be opened.")
}

/// Blocking variant of [`open_and_wait`] for synchronous callers.
pub fn open_and_wait_blocking(target: &str) -> bool {
    let mut command = command(target);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.status() {
        Ok(status) => cfg!(target_os = "windows") || status.success(),
        Err(_) => false,
    }
}

/// Open `target` and wait until the OS has accepted it, so the UI can show a
/// truthful “Opening…” state. (`explorer.exe` exits 1 even on success, so on
/// Windows a successful spawn is the best signal available.)
pub async fn open_and_wait(target: &str) -> bool {
    let mut command = tokio::process::Command::from(command(target));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.status().await {
        Ok(status) => cfg!(target_os = "windows") || status.success(),
        Err(_) => false,
    }
}
