//! Run a command in a new terminal window in a given folder (used to resume
//! Codex/Claude sessions and to launch imported agent skills).
//!
//! The folder, program and arguments are untrusted data. They are passed to
//! the terminal as separate values and quoted for the one shell layer the
//! terminal starts; they are never concatenated into an unquoted shell string.

use std::ffi::OsString;
use std::path::Path;

use crate::{PlatformError, PlatformResult};

/// Open the user's terminal in `cwd` running `program args...`. Arguments are
/// passed as separate values; they are never concatenated into a shell string
/// without quoting.
pub fn run_in_terminal(cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
    if program.is_empty()
        || program.starts_with('-')
        || program.contains('\0')
        || args.iter().any(|arg| arg.contains('\0'))
    {
        return Err(PlatformError::Failed(
            "That command cannot be started.".into(),
        ));
    }
    if !cwd.is_dir() {
        return Err(PlatformError::Failed(
            "Project directory unavailable".into(),
        ));
    }
    launch(cwd, program, args)
}

const FAILED: &str = "The terminal could not be opened.";

// The folder and command are untrusted data and must not become AppleScript
// source. They arrive as `argv`; `quoted form of` escapes each one for the
// shell that `do script` starts (see the original resume script in server.js).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const MACOS_SCRIPT: &str = r#"on run argv
  set command to "cd " & quoted form of (item 1 of argv) & ";"
  repeat with i from 2 to count of argv
    set command to command & " " & quoted form of (item i of argv)
  end repeat
  tell application "Terminal"
    activate
    do script command
  end tell
end run"#;

#[cfg(target_os = "macos")]
fn launch(cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
    let mut command = crate::exec::command("/usr/bin/osascript");
    command
        .arg("-e")
        .arg(MACOS_SCRIPT)
        .arg(cwd)
        .arg(program)
        .args(args);
    crate::exec::spawn_detached(command, FAILED)
}

/// Quote one value for `cmd.exe`. Inside double quotes cmd treats `&|<>^` as
/// literal text, but `%`/`!` still expand and a `"` would end the quoting, so
/// values containing them (or line breaks) are refused rather than escaped.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn cmd_quote(value: &str) -> Option<String> {
    if value
        .chars()
        .any(|c| matches!(c, '"' | '%' | '!' | '\r' | '\n' | '\0'))
    {
        return None;
    }
    Some(format!("\"{value}\""))
}

/// The `cmd.exe` command line `/S /K ""program" "arg" ...""`. With `/S`, cmd
/// strips exactly the outer pair of quotes, so every inner quote survives.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn cmd_line(program: &str, args: &[String]) -> Option<String> {
    let mut parts = vec![cmd_quote(program)?];
    for arg in args {
        parts.push(cmd_quote(arg)?);
    }
    Some(format!("/S /K \"{}\"", parts.join(" ")))
}

#[cfg(target_os = "windows")]
fn launch(cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let line = cmd_line(program, args).ok_or_else(|| {
        PlatformError::Failed("That command cannot be started safely in a Windows terminal.".into())
    })?;
    // Running through `cmd /K` resolves npm `.cmd` shims (codex, claude) and
    // keeps the window open afterwards, matching Terminal.app.
    let cwd_text = cwd.to_string_lossy();
    if !cwd_text.contains(';') {
        // Windows Terminal splits its command line into tabs at `;`; `\;` is
        // its escape for a literal semicolon.
        let mut wt = Command::new("wt.exe");
        wt.arg("-d")
            .arg(cwd)
            .arg("cmd.exe")
            .raw_arg(line.replace(';', "\\;"));
        wt.current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(child) = wt.spawn() {
            crate::exec::reap(child);
            return Ok(());
        }
    }
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg(&line)
        .current_dir(cwd)
        .creation_flags(CREATE_NEW_CONSOLE);
    crate::exec::spawn_detached(cmd, FAILED)
}

/// How a Linux terminal emulator takes a working directory and a command.
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) fn linux_argv(
    terminal: &str,
    cwd: &Path,
    program: &str,
    args: &[String],
) -> Vec<OsString> {
    let mut argv: Vec<OsString> = Vec::new();
    let with_dir = |flag: &str| {
        let mut value = OsString::from(flag);
        value.push(cwd.as_os_str());
        value
    };
    match terminal {
        "gnome-terminal" | "mate-terminal" | "tilix" => {
            argv.push(with_dir("--working-directory="));
            argv.push("--".into());
        }
        "konsole" => {
            argv.extend(["--workdir".into(), cwd.as_os_str().to_owned(), "-e".into()]);
        }
        // `-e` takes a single shell-parsed string here; `-x` takes argv.
        "xfce4-terminal" => {
            argv.push(with_dir("--working-directory="));
            argv.push("-x".into());
        }
        "alacritty" => {
            argv.extend([
                "--working-directory".into(),
                cwd.as_os_str().to_owned(),
                "-e".into(),
            ]);
        }
        "kitty" => {
            argv.push(with_dir("--directory="));
        }
        "foot" => {
            argv.push(with_dir("--working-directory="));
        }
        "wezterm" => {
            argv.extend([
                "start".into(),
                "--cwd".into(),
                cwd.as_os_str().to_owned(),
                "--".into(),
            ]);
        }
        _ => argv.push("-e".into()),
    }
    argv.push(program.into());
    argv.extend(args.iter().map(OsString::from));
    argv
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))]
const LINUX_TERMINALS: &[&str] = &[
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "kitty",
    "xterm",
];

#[cfg_attr(target_os = "macos", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))]
const KNOWN_STYLES: &[&str] = &[
    "gnome-terminal",
    "mate-terminal",
    "tilix",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "kitty",
    "foot",
    "wezterm",
];

/// The terminal binary to run and the style name its arguments follow.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn linux_terminal() -> Option<(std::path::PathBuf, String)> {
    use crate::exec::which;
    let style_of = |path: &Path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    if let Some(value) = std::env::var_os("TERMINAL").filter(|value| !value.is_empty())
        && let Some(path) = which(&value.to_string_lossy())
    {
        let style = style_of(&path);
        return Some((path, style));
    }
    for name in LINUX_TERMINALS {
        let Some(path) = which(name) else { continue };
        if *name == "x-terminal-emulator" {
            // Debian's alternative points at the real emulator (sometimes via
            // a `.wrapper` script with its own `-e` rules). Use the real
            // emulator directly when it is one whose arguments we know.
            let real = std::fs::canonicalize(&path)
                .ok()
                .map(|real| style_of(&real))
                .unwrap_or_default();
            if let Some(known) = KNOWN_STYLES.iter().find(|known| real.starts_with(**known))
                && let Some(direct) = which(known)
            {
                return Some((direct, known.to_string()));
            }
            return Some((path, "x-terminal-emulator".into()));
        }
        return Some((path, name.to_string()));
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn launch(cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
    let Some((terminal, style)) = linux_terminal() else {
        return Err(PlatformError::Unsupported);
    };
    let mut command = crate::exec::command(terminal);
    command
        .args(linux_argv(&style, cwd, program, args))
        .current_dir(cwd);
    crate::exec::spawn_detached(command, FAILED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_script_takes_every_value_as_argv() {
        assert!(MACOS_SCRIPT.contains("quoted form of (item 1 of argv)"));
        assert!(MACOS_SCRIPT.contains("quoted form of (item i of argv)"));
    }

    #[test]
    fn cmd_quoting_refuses_values_cmd_would_expand() {
        assert_eq!(
            cmd_line("codex", &["resume".into(), "a&b".into()]).unwrap(),
            "/S /K \"\"codex\" \"resume\" \"a&b\"\""
        );
        for bad in ["%PATH%", "a\"b", "!x!", "a\nb"] {
            assert!(cmd_line("codex", &[bad.into()]).is_none(), "{bad}");
        }
    }

    #[test]
    fn linux_terminals_receive_argv_not_a_shell_string() {
        let cwd = Path::new("/home/a/my project");
        let args = vec!["--resume".to_string(), "x; rm -rf ~".to_string()];
        let argv = linux_argv("gnome-terminal", cwd, "claude", &args);
        assert_eq!(
            argv,
            [
                "--working-directory=/home/a/my project",
                "--",
                "claude",
                "--resume",
                "x; rm -rf ~"
            ]
            .map(OsString::from)
        );
        let argv = linux_argv("xterm", cwd, "claude", &args);
        assert_eq!(argv[0], OsString::from("-e"));
        assert_eq!(argv.last().unwrap(), &OsString::from("x; rm -rf ~"));
        assert_eq!(
            linux_argv("xfce4-terminal", cwd, "codex", &[])[1],
            OsString::from("-x")
        );
    }

    #[test]
    fn rejects_option_like_programs_and_missing_folders() {
        assert!(run_in_terminal(Path::new("/"), "-e", &[]).is_err());
        assert!(run_in_terminal(Path::new("/definitely/not/here"), "codex", &[]).is_err());
    }
}
