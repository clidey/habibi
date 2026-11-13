//! Launchable applications: discovery, the launch allowlist, and PNG icons.
//!
//! - macOS: `.app` bundles under the standard application roots, `.icns`
//!   icons (PNG representations are read directly; `sips` converts the rest).
//! - Windows: Start Menu `.lnk` shortcuts (per-user and all-users), icons
//!   extracted from the shortcut's icon or target executable.
//! - Linux: XDG `.desktop` entries (respecting `NoDisplay`/`Hidden`), icons
//!   from the icon theme.
//!
//! An app's `path` is its stable id: the UI sends it back to open the app or
//! fetch its icon, and only paths under the discovered roots are accepted.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::{PlatformError, PlatformResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    pub name: String,
    /// The bundle, shortcut or desktop entry. Stable id sent back by the UI.
    pub path: String,
    /// The program the app runs as, when known (Windows/Linux), used to group
    /// running processes under the app.
    pub executable: Option<PathBuf>,
}

/// Every launchable app, deduplicated and filtered for a launcher. Blocking.
pub fn discover() -> Vec<App> {
    imp::discover()
}

/// The canonical path for `value` when it names an existing app inside the
/// allowed application roots, else `None`. `/api/open-app` and
/// `/api/app-icon` accept nothing else.
pub fn allowed_app(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.contains('\0') {
        return None;
    }
    imp::allowed_app(&crate::fsutil::resolve(Path::new(value)))
}

/// Launch an allowed app and wait until the OS has accepted the request, so
/// the UI can show a truthful “Opening…” state. Blocking.
pub fn launch(app: &Path) -> bool {
    imp::launch(app)
}

/// The app's icon as PNG bytes. Blocking.
pub fn icon_png(app: &Path) -> PlatformResult<Vec<u8>> {
    imp::icon_png(app)
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

fn no_icon() -> PlatformError {
    PlatformError::Failed("No icon is available for this app.".into())
}

/// Pick a PNG representation from an `.icns` file: the one whose width is
/// closest to 256px (the launcher shows small icons; 1024px ones are large).
/// `None` when the file only has legacy (non-PNG) representations.
pub fn icns_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 8 || &bytes[..4] != b"icns" {
        return None;
    }
    let total = (u32::from_be_bytes(bytes[4..8].try_into().ok()?) as usize).min(bytes.len());
    let mut offset = 8;
    let mut best: Option<(u32, &[u8])> = None;
    while offset + 8 <= total {
        let length = u32::from_be_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        if length < 8 || offset + length > total {
            break;
        }
        let data = &bytes[offset + 8..offset + length];
        if is_png(data) && data.len() >= 24 {
            let width = u32::from_be_bytes(data[16..20].try_into().ok()?);
            let distance = |w: u32| w.abs_diff(256) + if w < 128 { 1_000 } else { 0 };
            if best.is_none_or(|(current, _)| distance(width) < distance(current)) {
                best = Some((width, data));
            }
        }
        offset += length;
    }
    best.map(|(_, data)| data.to_vec())
}

/// Walk `root` up to `max_depth` directory levels, collecting entries for
/// which `accept` returns true. `descend_into` decides which directories are
/// walked (entries are classified without following symlinks).
fn walk(
    root: &Path,
    depth: usize,
    max_depth: usize,
    accept: &dyn Fn(&Path, &std::fs::FileType) -> bool,
    found: &mut Vec<PathBuf>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if accept(&path, &kind) {
            found.push(path);
            continue;
        }
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        if kind.is_dir() && !kind.is_symlink() && !hidden {
            walk(&path, depth + 1, max_depth, accept, found);
        }
    }
}

fn dedupe(apps: Vec<App>, key: impl Fn(&App) -> String) -> Vec<App> {
    let mut seen = HashSet::new();
    apps.into_iter()
        .filter(|app| seen.insert(key(app)))
        .collect()
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .is_some_and(|value| value.to_string_lossy().eq_ignore_ascii_case(extension))
}

// ---------------------------------------------------------------- macOS

/// System bundles include many invisible menu extras and support agents.
/// They are not launchable apps a person expects from a launcher query, and
/// most expose macOS's generic question-mark icon.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn macos_hidden_name(name: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)(?:agent|assistant|daemon|service|helper|server|launcher|messenger|url handler|authwarn|accesscontrol|mac)$",
            )
            .expect("valid pattern")
        })
        .is_match(name)
}

/// Discover bundles under the macOS roots with the rules the Node host used.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn macos_discover(roots: &[PathBuf]) -> Vec<App> {
    let mut found = Vec::new();
    for root in roots {
        // Terminal and the rest of macOS Utilities live below
        // /System/Applications. Walk only a few directory levels, stop at
        // every .app bundle, and never crawl its Contents — comprehensive
        // discovery without turning a launcher query into a filesystem crawl.
        walk(
            root,
            0,
            3,
            &|path, kind| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".app"))
                    && (kind.is_dir() || kind.is_symlink())
            },
            &mut found,
        );
    }
    let apps = found
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            App {
                name: name.trim_end_matches(".app").to_string(),
                path: path.to_string_lossy().into_owned(),
                executable: None,
            }
        })
        .collect();
    dedupe(apps, |app| app.path.to_lowercase())
        .into_iter()
        .filter(|app| !macos_hidden_name(&app.name))
        // CoreServices is mostly implementation plumbing (text input
        // switchers, preview shells, background UI helpers). Only retain its
        // two familiar user-facing entry points.
        .filter(|app| {
            !app.path.starts_with("/System/Library/CoreServices/")
                || ["Finder", "Time Machine"].contains(&app.name.as_str())
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    fn roots() -> Vec<PathBuf> {
        let home = crate::home().unwrap_or_else(|| PathBuf::from("/"));
        vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
            PathBuf::from("/System/Library/CoreServices"),
            home.join("Applications"),
        ]
    }

    pub fn discover() -> Vec<App> {
        macos_discover(&roots())
    }

    pub fn allowed_app(target: &Path) -> Option<PathBuf> {
        let text = target.to_string_lossy();
        let allowed = roots()
            .iter()
            .any(|root| text.starts_with(&format!("{}/", root.to_string_lossy())));
        (text.ends_with(".app") && allowed && target.exists()).then(|| target.to_path_buf())
    }

    pub fn launch(app: &Path) -> bool {
        // Launch Services has accepted the request once `open` exits 0.
        let mut command = crate::exec::command("/usr/bin/open");
        command.arg(app);
        crate::exec::succeeds(command)
    }

    pub fn icon_png(app: &Path) -> PlatformResult<Vec<u8>> {
        let resources = app.join("Contents").join("Resources");
        let mut icons: Vec<PathBuf> = std::fs::read_dir(&resources)
            .map_err(|_| no_icon())?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().to_lowercase().ends_with(".icns"))
            .collect();
        icons.sort();
        let stem = app
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let preferred = icons
            .iter()
            .position(|path| {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                name == "AppIcon" || name == stem
            })
            .unwrap_or(0);
        let icon = icons.get(preferred).ok_or_else(no_icon)?;
        if let Some(png) = std::fs::read(icon).ok().as_deref().and_then(icns_png) {
            return Ok(png);
        }
        // Legacy icon formats: let `sips` convert, as the Node host did.
        let directory = tempfile::tempdir().map_err(|_| no_icon())?;
        let output = directory.path().join("icon.png");
        let mut command = crate::exec::command("/usr/bin/sips");
        command
            .args(["-s", "format", "png"])
            .arg(icon)
            .arg("--out")
            .arg(&output);
        if !crate::exec::succeeds(command) {
            return Err(no_icon());
        }
        std::fs::read(&output)
            .ok()
            .filter(|bytes| is_png(bytes))
            .ok_or_else(no_icon)
    }
}

// ---------------------------------------------------------------- Windows

/// Start Menu entries that are documentation or uninstallers, not apps.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_hidden_name(name: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)\b(?:uninstall|uninstaller|readme|read me|help|documentation|website|release notes|license|manual)\b",
            )
            .expect("valid pattern")
        })
        .is_match(name)
}

/// The target path of a Windows shell link (`.lnk`), from its LinkInfo
/// `LocalBasePath` (+ `CommonPathSuffix`). `None` for advertised/MSI or
/// network shortcuts. Pure, so it is tested on every OS.
pub fn lnk_target(bytes: &[u8]) -> Option<String> {
    let u16_at = |at: usize| {
        bytes
            .get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
    };
    let u32_at = |at: usize| {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    if u32_at(0)? != 0x4C {
        return None;
    }
    let flags = u32_at(20)?;
    let mut offset = 0x4C;
    if flags & 0x1 != 0 {
        offset += 2 + u16_at(offset)?;
    }
    if flags & 0x2 == 0 {
        return None;
    }
    let info = offset;
    let info_size = u32_at(info)?;
    let header_size = u32_at(info + 4)?;
    let info_flags = u32_at(info + 8)?;
    if info_flags & 0x1 == 0 || info_size < header_size {
        return None;
    }
    let ansi = |at: usize| -> Option<String> {
        let start = info + at;
        let rest = bytes.get(start..info + info_size)?;
        let end = rest.iter().position(|b| *b == 0)?;
        Some(rest[..end].iter().map(|b| *b as char).collect())
    };
    let wide = |at: usize| -> Option<String> {
        let start = info + at;
        let rest = bytes.get(start..info + info_size)?;
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .take_while(|u| *u != 0)
            .collect();
        String::from_utf16(&units).ok()
    };
    let base = if header_size >= 0x24 && u32_at(info + 28).is_some_and(|o| o != 0) {
        wide(u32_at(info + 28)?)?
    } else {
        ansi(u32_at(info + 16)?)?
    };
    let suffix = if header_size >= 0x24 && u32_at(info + 32).is_some_and(|o| o != 0) {
        wide(u32_at(info + 32)?).unwrap_or_default()
    } else {
        u32_at(info + 24).and_then(ansi).unwrap_or_default()
    };
    let target = format!("{base}{suffix}");
    (!target.is_empty()).then_some(target)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    fn roots() -> Vec<PathBuf> {
        let tail = Path::new("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        let mut roots = Vec::new();
        if let Some(roaming) = dirs::data_dir() {
            roots.push(roaming.join(&tail));
        }
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        roots.push(program_data.join(&tail));
        roots
    }

    pub fn discover() -> Vec<App> {
        let mut found = Vec::new();
        for root in roots() {
            walk(
                &root,
                0,
                3,
                &|path, kind| kind.is_file() && has_extension(path, "lnk"),
                &mut found,
            );
        }
        let apps = found
            .into_iter()
            .map(|path| App {
                name: path
                    .file_stem()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                executable: std::fs::read(&path)
                    .ok()
                    .as_deref()
                    .and_then(lnk_target)
                    .map(PathBuf::from),
                path: path.to_string_lossy().into_owned(),
            })
            .filter(|app| !app.name.is_empty() && !windows_hidden_name(&app.name))
            .collect();
        // The same app is often in both the per-user and all-users menus.
        dedupe(apps, |app| app.name.to_lowercase())
    }

    pub fn allowed_app(target: &Path) -> Option<PathBuf> {
        let allowed = roots()
            .iter()
            .any(|root| crate::fsutil::starts_with(target, root) && target != root);
        (has_extension(target, "lnk") && allowed && target.is_file()).then(|| target.to_path_buf())
    }

    pub fn launch(app: &Path) -> bool {
        crate::open::open_and_wait_blocking(&app.to_string_lossy())
    }

    // The shortcut path is passed in an environment variable, never as
    // script source. The script itself is a constant.
    const ICON_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = $env:HABIBI_ICON_SOURCE
if ($source.ToLower().EndsWith('.lnk')) {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($source)
  $location = [Environment]::ExpandEnvironmentVariables(($shortcut.IconLocation -split ',')[0])
  if ($location -and (Test-Path -LiteralPath $location -PathType Leaf)) { $source = $location }
  elseif ($shortcut.TargetPath -and (Test-Path -LiteralPath $shortcut.TargetPath -PathType Leaf)) { $source = $shortcut.TargetPath }
}
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source)
$bitmap = $icon.ToBitmap()
$bitmap.Save($env:HABIBI_ICON_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)
"#;

    pub fn icon_png(app: &Path) -> PlatformResult<Vec<u8>> {
        let directory = tempfile::tempdir().map_err(|_| no_icon())?;
        let output = directory.path().join("icon.png");
        let encoded = crate::exec::base64(
            &ICON_SCRIPT
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<u8>>(),
        );
        let mut command = crate::exec::command("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ])
            .env("HABIBI_ICON_SOURCE", app)
            .env("HABIBI_ICON_OUTPUT", &output);
        if !crate::exec::succeeds(command) {
            return Err(no_icon());
        }
        std::fs::read(&output)
            .ok()
            .filter(|bytes| is_png(bytes))
            .ok_or_else(no_icon)
    }
}

// ---------------------------------------------------------------- Linux

/// The `[Desktop Entry]` fields a launcher needs.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DesktopEntry {
    pub name: String,
    pub exec: String,
    pub icon: String,
    pub try_exec: String,
    pub kind: String,
    pub no_display: bool,
    pub hidden: bool,
}

impl DesktopEntry {
    /// True for an application a launcher should list.
    pub fn visible(&self) -> bool {
        self.kind == "Application"
            && !self.no_display
            && !self.hidden
            && !self.name.is_empty()
            && !self.exec.is_empty()
    }
}

/// Parse the unlocalized keys of the `[Desktop Entry]` group.
pub fn parse_desktop_entry(text: &str) -> DesktopEntry {
    let mut entry = DesktopEntry::default();
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().to_string();
        match key.trim() {
            "Name" => entry.name = value,
            "Exec" => entry.exec = value,
            "Icon" => entry.icon = value,
            "TryExec" => entry.try_exec = value,
            "Type" => entry.kind = value,
            "NoDisplay" => entry.no_display = value == "true",
            "Hidden" => entry.hidden = value == "true",
            _ => {}
        }
    }
    entry
}

/// Split an `Exec` value into argv per the Desktop Entry spec and drop field
/// codes (`%f`, `%U`, …); `%%` is a literal `%`. Returns `None` for malformed
/// quoting.
pub fn desktop_exec_argv(exec: &str) -> Option<Vec<String>> {
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut quoted = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has_token = true;
            }
            '\\' if quoted => current.push(chars.next()?),
            ' ' | '\t' if !quoted => {
                if has_token {
                    argv.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            // Field codes are dropped; launching never passes files.
            '%' => {
                if chars.next()? == '%' {
                    current.push('%');
                    has_token = true;
                }
            }
            other => {
                current.push(other);
                has_token = true;
            }
        }
    }
    if quoted {
        return None;
    }
    if has_token {
        argv.push(current);
    }
    Some(argv)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::*;
    use crate::exec::which;

    fn data_dirs() -> Vec<PathBuf> {
        let home = crate::home().unwrap_or_else(|| PathBuf::from("/"));
        let mut dirs = vec![
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(".local/share")),
        ];
        let system = std::env::var("XDG_DATA_DIRS")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
        dirs.extend(
            system
                .split(':')
                .map(PathBuf::from)
                .filter(|p| p.is_absolute()),
        );
        dirs.push(home.join(".local/share/flatpak/exports/share"));
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
        let mut seen = HashSet::new();
        dirs.retain(|dir| seen.insert(dir.clone()));
        dirs
    }

    fn roots() -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = data_dirs()
            .into_iter()
            .map(|dir| dir.join("applications"))
            .collect();
        roots.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
        roots
    }

    fn program(entry: &DesktopEntry) -> Option<PathBuf> {
        let argv = desktop_exec_argv(&entry.exec)?;
        let mut tokens = argv.iter().map(String::as_str);
        let mut first = tokens.next()?;
        if first == "env" {
            first = tokens.find(|token| !token.contains('='))?;
        }
        which(first)
    }

    fn read_entry(path: &Path) -> Option<DesktopEntry> {
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 {
            return None;
        }
        let entry = parse_desktop_entry(&std::fs::read_to_string(path).ok()?);
        if !entry.visible() || (!entry.try_exec.is_empty() && which(&entry.try_exec).is_none()) {
            return None;
        }
        Some(entry)
    }

    pub fn discover() -> Vec<App> {
        let mut apps = Vec::new();
        let mut ids = HashSet::new();
        for root in roots() {
            let mut found = Vec::new();
            walk(
                &root,
                0,
                2,
                &|path, kind| !kind.is_dir() && has_extension(path, "desktop"),
                &mut found,
            );
            for path in found {
                // Desktop file ids: earlier data dirs take precedence.
                let id = path
                    .strip_prefix(&root)
                    .map(|rel| rel.to_string_lossy().replace('/', "-"))
                    .unwrap_or_default();
                if !ids.insert(id) {
                    continue;
                }
                let Some(entry) = read_entry(&path) else {
                    continue;
                };
                apps.push(App {
                    executable: program(&entry),
                    name: entry.name,
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
        dedupe(apps, |app| app.name.to_lowercase())
    }

    pub fn allowed_app(target: &Path) -> Option<PathBuf> {
        let allowed = roots()
            .iter()
            .any(|root| target.starts_with(root) && target != root);
        (has_extension(target, "desktop") && allowed && read_entry(target).is_some())
            .then(|| target.to_path_buf())
    }

    pub fn launch(app: &Path) -> bool {
        if let Some(gio) = which("gio") {
            let mut command = crate::exec::command(gio);
            command.arg("launch").arg(app);
            return crate::exec::succeeds(command);
        }
        if let (Some(gtk), Some(id)) = (which("gtk-launch"), app.file_name()) {
            let mut command = crate::exec::command(gtk);
            command.arg(id);
            return crate::exec::succeeds(command);
        }
        let Some(argv) = read_entry(app).and_then(|entry| desktop_exec_argv(&entry.exec)) else {
            return false;
        };
        let Some((program, args)) = argv.split_first() else {
            return false;
        };
        let mut command = crate::exec::command(program);
        command.args(args);
        if let Some(home) = crate::home() {
            command.current_dir(home);
        }
        crate::exec::spawn_detached(command, "").is_ok()
    }

    pub fn icon_png(app: &Path) -> PlatformResult<Vec<u8>> {
        let entry = read_entry(app).ok_or_else(no_icon)?;
        let name = entry.icon;
        if name.is_empty() {
            return Err(no_icon());
        }
        let read = |path: &Path| std::fs::read(path).ok().filter(|bytes| is_png(bytes));
        let icon = Path::new(&name);
        if icon.is_absolute() {
            return read(icon).ok_or_else(no_icon);
        }
        if name.contains('/') || name.contains("..") {
            return Err(no_icon());
        }
        let file = format!("{name}.png");
        let home = crate::home().unwrap_or_else(|| PathBuf::from("/"));
        let mut bases = vec![home.join(".icons")];
        bases.extend(data_dirs().into_iter().map(|dir| dir.join("icons")));
        const SIZES: &[&str] = &[
            "256x256", "128x128", "512x512", "192x192", "96x96", "64x64", "48x48", "32x32",
        ];
        for base in &bases {
            let mut themes = vec![base.join("hicolor")];
            if let Ok(entries) = std::fs::read_dir(base) {
                let mut others: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| !p.ends_with("hicolor"))
                    .collect();
                others.sort();
                themes.extend(others);
            }
            for theme in &themes {
                for size in SIZES {
                    if let Some(bytes) = read(&theme.join(size).join("apps").join(&file)) {
                        return Ok(bytes);
                    }
                }
            }
        }
        read(&Path::new("/usr/share/pixmaps").join(&file)).ok_or_else(no_icon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_rules_hide_support_bundles_and_core_services_plumbing() {
        assert!(macos_hidden_name("Siri Agent"));
        assert!(macos_hidden_name("Some Helper"));
        assert!(!macos_hidden_name("Safari"));
        let root = tempfile::tempdir().unwrap();
        let apps = root.path().join("Applications");
        for bundle in [
            "Safari.app",
            "Utilities/Terminal.app",
            "Utilities/Terminal.app/Contents/Nested.app",
            "Updater Helper.app",
            ".hidden/Secret.app",
            "a/b/c/d/Deep.app",
        ] {
            std::fs::create_dir_all(apps.join(bundle)).unwrap();
        }
        let found = macos_discover(&[apps.clone(), apps.clone()]);
        let names: Vec<_> = found.iter().map(|app| app.name.as_str()).collect();
        assert_eq!(names, ["Safari", "Terminal"]);
    }

    #[test]
    fn icns_png_prefers_a_launcher_sized_png() {
        let png = |width: u32| {
            let mut data = PNG_SIGNATURE.to_vec();
            data.extend([0, 0, 0, 13]);
            data.extend(b"IHDR");
            data.extend(width.to_be_bytes());
            data.extend(width.to_be_bytes());
            data
        };
        let mut body = Vec::new();
        for (kind, data) in [
            (b"ic10", png(1024)),
            (b"ic08", png(256)),
            (b"is32", vec![1, 2, 3]),
        ] {
            body.extend(kind);
            body.extend(((data.len() + 8) as u32).to_be_bytes());
            body.extend(&data);
        }
        let mut file = b"icns".to_vec();
        file.extend(((body.len() + 8) as u32).to_be_bytes());
        file.extend(body);
        assert_eq!(icns_png(&file), Some(png(256)));
        assert_eq!(icns_png(b"nope"), None);
    }

    #[test]
    fn lnk_targets_are_read_from_link_info() {
        // Header (no ID list, HasLinkInfo) + LinkInfo with an ANSI base path.
        let mut bytes = vec![0u8; 0x4C];
        bytes[0] = 0x4C;
        bytes[20] = 0x02;
        let path = b"C:\\Program Files\\App\\app.exe\0";
        let header = 0x1C_u32;
        let mut info = Vec::new();
        let size = header as usize + path.len() + 1;
        info.extend((size as u32).to_le_bytes());
        info.extend(header.to_le_bytes());
        info.extend(1u32.to_le_bytes());
        info.extend(0u32.to_le_bytes());
        info.extend(header.to_le_bytes());
        info.extend(0u32.to_le_bytes());
        info.extend(((header as usize + path.len()) as u32).to_le_bytes());
        info.extend(path);
        info.push(0);
        bytes.extend(info);
        assert_eq!(
            lnk_target(&bytes).as_deref(),
            Some("C:\\Program Files\\App\\app.exe")
        );
        assert_eq!(lnk_target(&[0; 10]), None);
    }

    #[test]
    fn desktop_entries_respect_visibility_and_exec_quoting() {
        let entry = parse_desktop_entry(
            "[Desktop Entry]\nType=Application\nName=Files\nName[de]=Dateien\nExec=\"/opt/my app/files\" --new %U\nIcon=org.files\n[Desktop Action x]\nName=Other\n",
        );
        assert_eq!(entry.name, "Files");
        assert!(entry.visible());
        assert_eq!(
            desktop_exec_argv(&entry.exec).unwrap(),
            ["/opt/my app/files", "--new"]
        );
        assert_eq!(desktop_exec_argv("app 100%%").unwrap(), ["app", "100%"]);
        assert!(desktop_exec_argv("\"broken").is_none());
        assert!(
            !parse_desktop_entry(
                "[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true"
            )
            .visible()
        );
        assert!(
            !parse_desktop_entry("[Desktop Entry]\nType=Application\nName=X\nExec=x\nHidden=true")
                .visible()
        );
        assert!(!parse_desktop_entry("[Desktop Entry]\nType=Link\nName=X\nExec=x").visible());
    }

    #[test]
    fn windows_rules_hide_uninstallers_and_documentation() {
        assert!(windows_hidden_name("Uninstall Foo"));
        assert!(windows_hidden_name("Foo Website"));
        assert!(!windows_hidden_name("Visual Studio Code"));
    }

    #[test]
    fn the_allowlist_rejects_paths_outside_application_roots() {
        assert_eq!(allowed_app(""), None);
        assert_eq!(allowed_app("/etc/passwd"), None);
        assert_eq!(allowed_app("/Applications/../etc/Evil.app"), None);
        assert_eq!(allowed_app("/tmp/Evil.app"), None);
    }
}
