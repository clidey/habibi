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

// ---------------------------------------------------------------- Windows
//
// A Windows command line is one string, and every program re-parses it. The
// terminal is started as `cmd.exe /S /V:OFF /K "<line>"` (cmd resolves the
// npm `.cmd` shims codex and claude install, and `/K` keeps the window open
// like Terminal.app). `<line>` is built in layers, innermost first:
//
// 1. The target program splits its arguments with the `CommandLineToArgvW`
//    rules, so each argument is quoted for them ([`argv_quote`]).
// 2. cmd expands `%NAME%` and then treats `&|<>()^"` specially outside double
//    quotes. Every ASCII punctuation or blank character of a quoted argument,
//    including its quotes, gets a `^` ([`caret_escape`]). An escaped `"`
//    never opens a quoted region, so nothing is ever inside cmd quotes and
//    every special character reaches the program literally. A `%` therefore
//    always follows a `^`, and so does a `:`: any `%NAME%` or `%NAME:~…%` cmd
//    could see has a name ending in `^`, which is not a defined variable, so
//    nothing expands (the documented way to keep `%` literal on cmd's command
//    line). `/V:OFF` turns delayed `!NAME!` expansion off whatever the
//    registry says.
// 3. A `.cmd`/`.bat` program is a batch file: it receives the line after one
//    cmd pass and re-parses its arguments again when it expands `%*` (the
//    "BatBadBut" problem). Those get the caret escaping twice, so the second
//    pass also sees only escaped characters. When it is unclear which file cmd
//    will run, the double escaping is used: for an `.exe` it garbles the
//    arguments but cannot run anything else.
// 4. The program itself is wrapped in real quotes; it may not contain `"` or
//    `%` (neither is useful in a Windows file name).
//
// Line breaks are refused: cmd ends the command at a line feed, and `^`
// before one is a line continuation, so there is no way to make cmd hand a
// newline to the program. NUL cannot appear in a Windows command line at all.

/// cmd.exe's limit for one command line, in UTF-16 units.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const CMD_MAX_UNITS: usize = 8191;

/// Quote `arg` so `CommandLineToArgvW` (and the MSVC runtime) read it back
/// verbatim: backslashes are literal except before a `"`, where `2n` of them
/// stand for `n`, and an odd one escapes the quote.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn argv_quote(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // The closing quote must not be escaped by trailing backslashes.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// Put a `^` before every ASCII punctuation and blank character, so cmd
/// (outside quotes) passes each one through literally and removes the `^`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn caret_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if c.is_ascii_punctuation() || c == ' ' || c == '\t' {
            out.push('^');
        }
        out.push(c);
    }
    out
}

/// The `cmd.exe` arguments `/S /V:OFF /K ""program" ^"arg^" ...""` that run
/// `program` with exactly `args`. `batch` is true when `program` may be a
/// `.cmd`/`.bat` file. `None` when a value cannot be carried safely.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn cmd_line(program: &str, args: &[String], batch: bool) -> Option<String> {
    let breaks = |value: &str| value.contains(['\r', '\n', '\0']);
    if program.is_empty() || breaks(program) || program.contains(['"', '%']) {
        return None;
    }
    let mut line = format!("\"{program}\"");
    for arg in args {
        if breaks(arg) {
            return None;
        }
        let mut escaped = caret_escape(&argv_quote(arg));
        if batch {
            escaped = caret_escape(&escaped);
        }
        line.push(' ');
        line.push_str(&escaped);
    }
    // With `/S`, cmd strips exactly the first and the last quote of the text
    // after `/K` and runs the rest unchanged.
    let command = format!("/S /V:OFF /K \"{line}\"");
    ("cmd.exe ".len() + command.encode_utf16().count() <= CMD_MAX_UNITS).then_some(command)
}

/// The `wt.exe` arguments that open a tab in `cwd` running
/// `cmd.exe <cmd_args>`, or `None` when Windows Terminal cannot carry them
/// (then plain `cmd.exe` is used).
///
/// Windows Terminal splits its own command line with `CommandLineToArgvW`,
/// starts a new tab at every `;` not written as `\;` (and turns each `\;`
/// back into `;`), treats everything after the first positional as the tab's
/// command, joins those values with single spaces (quoting only values that
/// contain a space), and finally runs `ExpandEnvironmentStringsW` on the
/// result. So the cmd command line is split at its spaces into pieces that
/// contain none, each piece gets `\` before every `;` and is quoted for
/// `CommandLineToArgvW`; the join then rebuilds the line exactly. The
/// environment expansion is harmless for the same reason cmd's is (every
/// `%` in an argument follows a `^`, and the program has none).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn wt_args(cwd: &str, cmd_args: &str) -> Option<String> {
    let escape = |value: &str| argv_quote(&value.replace(';', "\\;"));
    // The starting directory may be expanded too; keep `%` out of it.
    if cwd.is_empty() || cwd.contains('%') {
        return None;
    }
    let tab = format!("cmd.exe {cmd_args}");
    let pieces: Vec<&str> = tab.split(' ').collect();
    // Consecutive spaces (only possible inside the quoted program path)
    // would need empty values, which the join does not rebuild reliably.
    if pieces.iter().any(|piece| piece.is_empty()) {
        return None;
    }
    let mut out = format!("-d {}", escape(cwd));
    for piece in pieces {
        out.push(' ');
        out.push_str(&escape(piece));
    }
    Some(out)
}

/// The file cmd runs for `program` (searching `cwd`, then `path_dirs`, with
/// `pathext`), as the lowercase extension of the first match, or `None`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_resolve_extension(
    program: &str,
    dirs: &[std::path::PathBuf],
    pathext: &[String],
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<String> {
    let has_extension = Path::new(program).extension().is_some();
    for dir in dirs {
        let base = dir.join(program);
        if has_extension && is_file(&base) {
            return base
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase());
        }
        for extension in pathext {
            let mut candidate = base.clone().into_os_string();
            candidate.push(extension);
            if is_file(Path::new(&candidate)) {
                return Some(extension.trim_start_matches('.').to_ascii_lowercase());
            }
        }
    }
    None
}

/// Whether cmd might run `program` as a batch file. cmd looks in the
/// working directory first unless `NoDefaultCurrentDirectoryInExePath` is
/// set, so both search orders are checked; anything unresolved counts as a
/// batch file because the double escaping is the safe choice.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_may_run_batch(
    program: &str,
    cwd: &Path,
    path_dirs: &[std::path::PathBuf],
    pathext: &[String],
    is_file: &dyn Fn(&Path) -> bool,
) -> bool {
    let batch = |extension: Option<String>| {
        extension.is_none_or(|extension| extension == "bat" || extension == "cmd")
    };
    if program.contains(['\\', '/', ':']) {
        let dirs = [cwd.to_path_buf()];
        return batch(windows_resolve_extension(program, &dirs, pathext, is_file));
    }
    let mut with_cwd = vec![cwd.to_path_buf()];
    with_cwd.extend(path_dirs.iter().cloned());
    batch(windows_resolve_extension(
        program, &with_cwd, pathext, is_file,
    )) || batch(windows_resolve_extension(
        program, path_dirs, pathext, is_file,
    ))
}

#[cfg(target_os = "windows")]
fn launch(cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let path_dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let pathext: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(str::to_string)
        .collect();
    let batch = windows_may_run_batch(program, cwd, &path_dirs, &pathext, &|path| path.is_file());
    let line = cmd_line(program, args, batch).ok_or_else(|| {
        PlatformError::Failed("That command cannot be started safely in a Windows terminal.".into())
    })?;
    if let Some(wt_line) = wt_args(&cwd.to_string_lossy(), &line) {
        let mut wt = Command::new("wt.exe");
        wt.raw_arg(wt_line)
            .current_dir(cwd)
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

    // Models of the Windows parsers the quoting goes through. They follow the
    // documented rules and are deliberately pessimistic where cmd's
    // behaviour is murky (see each one).

    /// Why a model rejected a command line (shown when a test fails).
    #[derive(Debug)]
    #[allow(dead_code)]
    struct Injected(String);

    /// `CommandLineToArgvW` for the arguments after the program name.
    fn split_argv(line: &str) -> Vec<String> {
        let chars: Vec<char> = line.chars().collect();
        let mut args = Vec::new();
        let mut i = 0;
        loop {
            while i < chars.len() && matches!(chars[i], ' ' | '\t') {
                i += 1;
            }
            if i >= chars.len() {
                return args;
            }
            let mut current = String::new();
            let mut quoted = false;
            while i < chars.len() {
                match chars[i] {
                    '\\' => {
                        let start = i;
                        while i < chars.len() && chars[i] == '\\' {
                            i += 1;
                        }
                        let count = i - start;
                        if chars.get(i) == Some(&'"') {
                            current.extend(std::iter::repeat_n('\\', count / 2));
                            if count % 2 == 1 {
                                current.push('"');
                                i += 1;
                            }
                        } else {
                            current.extend(std::iter::repeat_n('\\', count));
                        }
                    }
                    '"' if quoted && chars.get(i + 1) == Some(&'"') => {
                        current.push('"');
                        i += 2;
                    }
                    '"' => {
                        quoted = !quoted;
                        i += 1;
                    }
                    ' ' | '\t' if !quoted => break,
                    c => {
                        current.push(c);
                        i += 1;
                    }
                }
            }
            args.push(current);
        }
    }

    /// `%NAME%` expansion (cmd's first pass, or `ExpandEnvironmentStringsW`
    /// when `modifiers` is false). Pessimistic: every non-empty name that
    /// does not end in `^` counts as defined, and every `%` is tried as the
    /// start of a reference.
    fn expand_percent(line: &str, modifiers: bool) -> Result<String, Injected> {
        let chars: Vec<char> = line.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if *c != '%' {
                continue;
            }
            let Some(end) = chars[i + 1..].iter().position(|c| *c == '%') else {
                continue;
            };
            let body: String = chars[i + 1..i + 1 + end].iter().collect();
            let name = if modifiers {
                body.split(':').next().unwrap_or_default()
            } else {
                body.as_str()
            };
            if !name.is_empty() && !name.ends_with('^') {
                return Err(Injected(format!("%{body}% would expand")));
            }
        }
        Ok(line.to_string())
    }

    /// cmd's special-character pass: outside quotes `^` makes the next
    /// character literal (an escaped `"` opens no quotes), and an unescaped
    /// operator would start another command.
    fn cmd_carets(line: &str) -> Result<String, Injected> {
        let mut out = String::new();
        let mut quoted = false;
        let mut chars = line.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    quoted = !quoted;
                    out.push(c);
                }
                _ if quoted => out.push(c),
                '^' => out.extend(chars.next()),
                '&' | '|' | '<' | '>' | '(' | ')' => {
                    return Err(Injected(format!("unescaped {c} in {line}")));
                }
                _ => out.push(c),
            }
        }
        Ok(out)
    }

    /// What `cmd.exe <cmd_args>` starts: the program and its argv. For a
    /// batch file, `%*` re-parses the argument text once more.
    fn run_cmd(cmd_args: &str, batch: bool) -> Result<(String, Vec<String>), Injected> {
        let rest = cmd_args.strip_prefix("/S /V:OFF /K ").expect("switches");
        // `/S`: drop the first and the last quote, run the rest as typed.
        let rest = rest
            .strip_prefix('"')
            .and_then(|r| r.strip_suffix('"'))
            .expect("outer quotes");
        let line = cmd_carets(&expand_percent(rest, true)?)?;
        let line = line.strip_prefix('"').expect("quoted program");
        let end = line.find('"').expect("closing quote");
        let mut tail = line[end + 1..].to_string();
        if batch {
            tail = cmd_carets(&tail)?;
        }
        Ok((line[..end].to_string(), split_argv(&tail)))
    }

    /// What Windows Terminal does with `wt.exe <raw>`: the starting directory
    /// and the command line it gives the new tab.
    fn run_wt(raw: &str) -> Result<(String, String), Injected> {
        let mut values = Vec::new();
        for arg in split_argv(raw) {
            let chars: Vec<char> = arg.chars().collect();
            for (i, c) in chars.iter().enumerate() {
                if *c == ';' && (i == 0 || chars[i - 1] != '\\') {
                    return Err(Injected(format!("`;` starts a new wt command in {arg}")));
                }
            }
            values.push(arg.replace("\\;", ";"));
        }
        assert_eq!(values[0], "-d");
        let mut line = String::new();
        for value in &values[2..] {
            if !line.is_empty() {
                line.push(' ');
            }
            if value.contains(' ') {
                line.push_str(&format!("\"{value}\""));
            } else {
                line.push_str(value);
            }
        }
        Ok((values[1].clone(), expand_percent(&line, false)?))
    }

    const CWD: &str = r"C:\Users\a\my project; 100%\";

    /// Both launch paths deliver `args` to `program` verbatim.
    fn assert_verbatim(program: &str, args: &[String]) {
        for batch in [false, true] {
            let line = cmd_line(program, args, batch).expect("quotable");
            let (got_program, got) = run_cmd(&line, batch).unwrap();
            assert_eq!(got_program, program);
            assert_eq!(got, args, "batch={batch} line={line}");
            if CWD.contains('%') {
                assert!(wt_args(CWD, &line).is_none());
            }
            let cwd = CWD.replace('%', "");
            let raw = wt_args(&cwd, &line).expect("wt can carry it");
            let (got_cwd, tab) = run_wt(&raw).unwrap();
            assert_eq!(got_cwd, cwd);
            assert_eq!(tab.strip_prefix("cmd.exe "), Some(line.as_str()));
        }
    }

    const ADVERSARIAL: &[&str] = &[
        "",
        " ",
        "a  b",
        "\tx\t",
        "&",
        "a&b",
        "&& calc",
        "|",
        "a|b",
        "^",
        "^^",
        "a^",
        "^\"",
        "%",
        "%%",
        "%PATH%",
        "100%",
        "%x%y%",
        "%PATH:~0,1%",
        "%PATH:a=b%",
        "%=C:%",
        "!x!",
        "!PATH!",
        "\"",
        "a\"b",
        "\"\"",
        "\" & calc & \"",
        "\"&calc",
        "\\",
        "a\\",
        "a\\\\",
        "\\\"",
        "a\\\\\"b",
        "\\\\server\\share\\",
        "C:\\Program Files\\",
        "(x)",
        "<x>",
        ">nul",
        "2>&1",
        ";",
        "a;b",
        "\\;",
        "--",
        "-d",
        "/K",
        "new-tab",
        "a,b=c",
        "*?[]{}`~@#$'",
        "héllo wörld",
        "日本語",
        "emoji 😀 \u{200b}",
    ];

    #[test]
    fn windows_arguments_reach_the_program_verbatim() {
        for arg in ADVERSARIAL {
            assert_verbatim("codex", &[arg.to_string()]);
        }
        let all: Vec<String> = ADVERSARIAL.iter().map(|arg| arg.to_string()).collect();
        assert_verbatim("claude", &all);
        assert_verbatim(r"C:\Program Files\A&B (x86)\tool!.exe", &all);
    }

    #[test]
    fn windows_quoting_is_exactly_as_documented() {
        assert_eq!(argv_quote(""), "\"\"");
        assert_eq!(argv_quote("a b"), "\"a b\"");
        assert_eq!(argv_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(argv_quote("a\\"), "\"a\\\\\"");
        assert_eq!(argv_quote("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(argv_quote("a\\b"), "\"a\\b\"");
        assert_eq!(caret_escape("a&b c%"), "a^&b^ c^%");
        assert_eq!(
            cmd_line("codex", &["resume".into(), "a&b".into()], false).unwrap(),
            "/S /V:OFF /K \"\"codex\" ^\"resume^\" ^\"a^&b^\"\""
        );
        assert_eq!(
            cmd_line("codex", &["&".into()], true).unwrap(),
            "/S /V:OFF /K \"\"codex\" ^^^\"^^^&^^^\"\""
        );
    }

    #[test]
    fn single_escaping_would_not_protect_a_batch_file() {
        // Why batch targets get the second escaping: their `%*` re-parse
        // turns an argument's `"` into a real quote.
        let line = cmd_line("codex", &["\"&calc".into()], false).unwrap();
        assert!(run_cmd(&line, true).is_err());
        // The double escaping is still harmless when the target is an .exe.
        let line = cmd_line("codex", &["\"&calc".into()], true).unwrap();
        assert!(run_cmd(&line, false).is_ok());
    }

    #[test]
    fn windows_refuses_what_cmd_cannot_carry() {
        for bad in ["a\nb", "a\rb", "a\0b", "\r\n"] {
            assert!(cmd_line("codex", &[bad.into()], false).is_none(), "{bad:?}");
            assert!(cmd_line("codex", &[bad.into()], true).is_none(), "{bad:?}");
        }
        for bad in ["", "co\"dex", "%COMSPEC%", "a\nb"] {
            assert!(cmd_line(bad, &[], false).is_none(), "{bad:?}");
        }
        assert!(cmd_line("codex", &["x".repeat(8_200)], false).is_none());
        let line = cmd_line(r"C:\a  b\x.exe", &[], false).unwrap();
        assert!(wt_args(r"C:\p", &line).is_none());
        assert!(wt_args(r"C:\%USERPROFILE%", "/S /V:OFF /K \"\"x\"\"").is_none());
    }

    #[test]
    fn batch_detection_follows_cmds_search_order() {
        use std::path::PathBuf;
        let cwd = PathBuf::from(r"C:\proj");
        let bin = PathBuf::from(r"C:\bin");
        let npm = PathBuf::from(r"C:\npm");
        let pathext: Vec<String> = [".COM", ".EXE", ".BAT", ".CMD"].map(String::from).to_vec();
        let files: Vec<PathBuf> = vec![
            bin.join("git.EXE"),
            npm.join("codex.CMD"),
            cwd.join("tool.EXE"),
            bin.join("tool.CMD"),
            cwd.join("run.bat"),
        ];
        // Windows file names are case-insensitive.
        let lower = |path: &Path| path.to_string_lossy().to_lowercase();
        let is_file = |path: &Path| files.iter().any(|file| lower(file) == lower(path));
        let dirs = [bin.clone(), npm.clone()];
        let batch = |program: &str| windows_may_run_batch(program, &cwd, &dirs, &pathext, &is_file);
        assert!(!batch("git"));
        assert!(batch("codex"));
        // cwd has tool.exe, PATH has tool.cmd: either may run.
        assert!(batch("tool"));
        assert!(batch("run.bat"));
        // Paths only join like Windows paths on Windows.
        #[cfg(target_os = "windows")]
        {
            assert!(batch(r".\run"));
            assert!(!batch(r"C:\bin\git.exe"));
        }
        // Not found: assume the worst.
        assert!(batch("missing"));
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
