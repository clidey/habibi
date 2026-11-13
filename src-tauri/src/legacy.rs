//! First launch on macOS: carry the Swift app's browser settings (its
//! `localStorage` at `http://127.0.0.1:4173`) into the new origin. See
//! `habibi_desktop::web_storage` for the format. Best effort: anything
//! unexpected means no import, and it is tried once.

use habibi_desktop::prefs::Preferences;

/// An init script that seeds `localStorage` before the page runs.
pub struct LegacySeed {
    pub script: String,
    /// Development only: use a fresh, non-persistent website data store so
    /// the import can be checked without touching real storage.
    pub ephemeral: bool,
}

const DONE: &str = "importedLegacyWebStorage";

/// Debug builds: `HABIBI_DEBUG_LEGACY_WEBKIT_DATA=<dir>` points the importer
/// at a *copy* of a `WebsiteData` directory, even with `HABIBI_DATA_ROOT`
/// set, and runs the launcher with ephemeral storage.
#[cfg(all(target_os = "macos", debug_assertions))]
fn debug_source() -> Option<std::path::PathBuf> {
    std::env::var_os("HABIBI_DEBUG_LEGACY_WEBKIT_DATA").map(std::path::PathBuf::from)
}

#[cfg(target_os = "macos")]
fn seed_from(website_data: &std::path::Path, ephemeral: bool) -> Option<LegacySeed> {
    let entries = habibi_desktop::web_storage::read_legacy(website_data);
    if ephemeral {
        eprintln!("[legacy] {} localStorage keys to import", entries.len());
    }
    if entries.is_empty() {
        return None;
    }
    Some(LegacySeed { script: habibi_desktop::web_storage::seed_script(&entries), ephemeral })
}

/// The seed for this launch, if the Swift app's storage should be imported.
/// `overridden` is true when `HABIBI_DATA_ROOT` points elsewhere.
pub fn seed(prefs: &Preferences, overridden: bool) -> Option<LegacySeed> {
    #[cfg(target_os = "macos")]
    {
        #[cfg(debug_assertions)]
        if let Some(source) = debug_source() {
            return seed_from(&source, true);
        }
        if overridden || prefs.get_bool(DONE) == Some(true) {
            return None;
        }
        prefs.set(DONE, true.into());
        let website_data = dirs::home_dir()?.join("Library/WebKit/com.clidey.habibi/WebsiteData");
        seed_from(&website_data, false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (prefs, overridden, DONE);
        None
    }
}
