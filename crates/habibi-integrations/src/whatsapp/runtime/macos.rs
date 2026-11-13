//! The signed, notarized WhatsApp component on macOS: verify it against this
//! app's signing team and install it atomically.
//!
//! Releases keep Node, the OpenWA supervisor, OpenWA and Chromium in a
//! separately signed/notarized, architecture-specific component under
//! Application Support, so the app download carries none of them
//! (`native/build-whatsapp-component.sh` stages it and
//! `native/package-whatsapp-component.sh` signs and notarizes it).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::download::{MAX_ARCHIVE_BYTES, place, valid_archive_listing};
use super::{COMPONENT_IDENTIFIER, Layout, component_name, component_parts};

/// Run a system tool; exit status and combined output.
fn run(executable: &str, arguments: &[&str]) -> (i32, String) {
    match Command::new(executable).args(arguments).stdin(Stdio::null()).output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            (output.status.code().unwrap_or(-1), text)
        }
        Err(_) => (-1, String::new()),
    }
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn plist_value(bundle: &Path, key: &str) -> Option<String> {
    let plist = path_str(&bundle.join("Contents").join("Info.plist"));
    let (code, output) = run("/usr/bin/plutil", &["-extract", key, "raw", "-o", "-", &plist]);
    (code == 0).then(|| output.trim().to_string())
}

fn signature_value(key: &str, bundle: &Path) -> Option<String> {
    let (code, output) = run("/usr/bin/codesign", &["-d", "--verbose=4", &path_str(bundle)]);
    if code != 0 {
        return None;
    }
    let prefix = format!("{key}=");
    output.lines().find_map(|line| line.strip_prefix(&prefix).map(str::to_string))
}

/// The `.app` this process runs from.
fn main_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app")).map(Path::to_path_buf)
}

/// `None` when `component` is this version's component, intact and signed
/// by the same team as Habibi (and, for fresh downloads, notarized).
pub fn verify_component(component: &Path, version: &str, require_gatekeeper: bool) -> Result<(), String> {
    if plist_value(component, "CFBundleIdentifier").as_deref() != Some(COMPONENT_IDENTIFIER)
        || plist_value(component, "CFBundleShortVersionString").as_deref() != Some(version)
    {
        return Err("The WhatsApp component does not match this Habibi version.".into());
    }
    if run("/usr/bin/codesign", &["--verify", "--deep", "--strict", &path_str(component)]).0 != 0 {
        return Err("macOS rejected the WhatsApp component signature.".into());
    }
    let app_team = main_bundle().and_then(|bundle| signature_value("TeamIdentifier", &bundle)).filter(|team| !team.is_empty());
    let same_team = app_team.is_some_and(|team| signature_value("TeamIdentifier", component).as_deref() == Some(team.as_str()));
    if !same_team || signature_value("Identifier", component).as_deref() != Some(COMPONENT_IDENTIFIER) {
        return Err("The WhatsApp component was not signed by the same developer as Habibi.".into());
    }
    if require_gatekeeper && run("/usr/sbin/spctl", &["-a", "-t", "exec", "-vv", &path_str(component)]).0 != 0 {
        return Err("macOS could not verify the notarized WhatsApp component.".into());
    }
    Ok(())
}

/// Validate, unpack, verify and atomically install a downloaded archive.
pub fn install_archive(archive: &Path, layout: &Layout) -> Result<PathBuf, String> {
    let size = std::fs::metadata(archive).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err("The WhatsApp download had an unexpected size.".into());
    }
    let (code, listing) = run("/usr/bin/zipinfo", &["-1", &path_str(archive)]);
    if code != 0 {
        return Err("The WhatsApp download was not a valid archive.".into());
    }
    if !valid_archive_listing(&listing) {
        return Err("The WhatsApp archive contained unexpected files.".into());
    }
    let extraction = std::env::temp_dir().join(format!("habibi-whatsapp-install-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::create_dir_all(&extraction).map_err(|_| "Could not create a temporary install directory.".to_string())?;
        if run("/usr/bin/ditto", &["-x", "-k", &path_str(archive), &path_str(&extraction)]).0 != 0 {
            return Err("Could not unpack the WhatsApp component.".to_string());
        }
        let extracted = extraction.join(component_name());
        if !extracted.exists() || !component_parts(&extracted).complete() {
            return Err("The WhatsApp component was missing from its archive.".into());
        }
        verify_component(&extracted, &layout.version, true)?;
        let final_component =
            layout.installed_component().ok_or_else(|| "Could not resolve the component install location.".to_string())?;
        place(&extracted, &final_component)?;
        Ok(final_component)
    })();
    let _ = std::fs::remove_dir_all(&extraction);
    result
}
