//! Fetching and placing the WhatsApp component, shared by every OS.
//!
//! Each release publishes one component archive per OS and architecture
//! (`.github/workflows/release.yml`). Only the check that the archive is
//! genuine differs: macOS verifies the notarized bundle's signature against
//! Habibi's own team ([`super::macos`]); Windows and Linux compare the
//! archive's SHA-256 with the digest compiled into this build
//! ([`super::archive`]).

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::{Layout, component_name};

pub const MAX_ARCHIVE_BYTES: u64 = 1_073_741_824;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadError {
    /// The server answered with a non-2xx status; nothing was written.
    Status(u16),
    Unreachable,
    Interrupted,
    File,
    TooLarge,
}

impl DownloadError {
    pub fn message(self) -> String {
        match self {
            Self::Status(404) => {
                "WhatsApp support is not available for this Habibi version. Update Habibi and try again.".into()
            }
            Self::Status(status) => format!("The WhatsApp download failed (HTTP {status}). Try again."),
            Self::Unreachable => "Could not reach the WhatsApp download server.".into(),
            Self::Interrupted => "Could not download the WhatsApp component.".into(),
            Self::File => "Could not prepare the WhatsApp download.".into(),
            Self::TooLarge => "The WhatsApp download had an unexpected size.".into(),
        }
    }
}

#[async_trait]
pub trait Downloader: Send + Sync {
    /// Stream `url` into `dest`, reporting whole percentages. HTTP failures
    /// are rejected before anything is written.
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        max_bytes: u64,
        progress: &(dyn Fn(u8) + Send + Sync),
    ) -> Result<(), DownloadError>;
}

pub struct ReqwestDownloader {
    client: reqwest::Client,
}

impl ReqwestDownloader {
    pub fn new() -> Self {
        // GitHub release assets redirect to their storage host.
        Self { client: reqwest::Client::builder().build().unwrap_or_default() }
    }
}

impl Default for ReqwestDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Downloader for ReqwestDownloader {
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        max_bytes: u64,
        progress: &(dyn Fn(u8) + Send + Sync),
    ) -> Result<(), DownloadError> {
        let mut response = self.client.get(url).send().await.map_err(|_| DownloadError::Unreachable)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(DownloadError::Status(status));
        }
        let total = response.content_length().filter(|length| *length > 0);
        if total.is_some_and(|total| total > max_bytes) {
            return Err(DownloadError::TooLarge);
        }
        let mut file = tokio::fs::File::create(dest).await.map_err(|_| DownloadError::File)?;
        let mut written: u64 = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| DownloadError::Interrupted)? {
            written += chunk.len() as u64;
            if written > max_bytes {
                return Err(DownloadError::TooLarge);
            }
            file.write_all(&chunk).await.map_err(|_| DownloadError::File)?;
            if let Some(total) = total {
                progress(((written.saturating_mul(100)) / total).min(100) as u8);
            }
        }
        file.flush().await.map_err(|_| DownloadError::File)?;
        Ok(())
    }
}

/// `arm64` or `x64`, as the release assets are named.
pub fn architecture() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// This build's release asset name. macOS keeps the Swift-era name (a
/// notarized `.zip`); Windows and Linux publish a `.tar.gz` named by OS.
pub fn asset_name(version: &str) -> String {
    let arch = architecture();
    if cfg!(target_os = "macos") {
        format!("Habibi-WhatsApp-{arch}-{version}.zip")
    } else {
        let os = if cfg!(windows) { "windows" } else { "linux" };
        format!("Habibi-WhatsApp-{os}-{arch}-{version}.tar.gz")
    }
}

/// The fixed-origin, versioned release asset for this build.
pub fn asset_url(version: &str) -> String {
    format!("https://github.com/clidey/habibi/releases/download/v{version}/{}", asset_name(version))
}

/// Every archive entry must sit inside the component directory, with no
/// absolute paths, backslashes or `..` segments.
pub fn valid_archive_listing(listing: &str) -> bool {
    let name = component_name();
    let prefix = format!("{name}/");
    let entries: Vec<&str> = listing.split('\n').filter(|entry| !entry.is_empty()).collect();
    !entries.is_empty()
        && entries.iter().all(|entry| {
            (*entry == name || entry.starts_with(&prefix))
                && !entry.starts_with('/')
                && !entry.contains('\\')
                && !entry.split('/').any(|part| part == "..")
        })
}

/// Move `extracted` to `final_component` via a staging directory, restoring
/// the previous install if anything fails.
pub fn place(extracted: &Path, final_component: &Path) -> Result<(), String> {
    let failure = || "Could not install the verified WhatsApp component.".to_string();
    let final_directory = final_component.parent().ok_or_else(failure)?;
    let parent = final_directory.parent().ok_or_else(failure)?;
    let staging = parent.join(format!(".install-{}", uuid::Uuid::new_v4()));
    let mut displaced: Option<PathBuf> = None;
    let attempt = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(parent)?;
        std::fs::create_dir(&staging)?;
        std::fs::rename(extracted, staging.join(component_name()))?;
        if final_directory.exists() {
            let backup = parent.join(format!(".replaced-{}", uuid::Uuid::new_v4()));
            std::fs::rename(final_directory, &backup)?;
            displaced = Some(backup);
        }
        std::fs::rename(&staging, final_directory)
    })();
    match attempt {
        Ok(()) => {
            // Component versions are immutable release assets. Once the
            // replacement is safely installed, remove older caches so Chromium
            // is not duplicated on disk after every Habibi update.
            for entry in std::fs::read_dir(parent).into_iter().flatten().flatten() {
                let path = entry.path();
                if path != final_directory {
                    let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                }
            }
            Ok(())
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&staging);
            if let Some(displaced) = displaced.filter(|_| !final_directory.exists()) {
                let _ = std::fs::rename(displaced, final_directory);
            }
            Err(failure())
        }
    }
}

/// Validates, unpacks, verifies and installs a downloaded archive.
pub type Installer = fn(&Path, &Layout) -> Result<PathBuf, String>;

/// Download this version's component and install it with `install`; the
/// installed component path on success, a user-safe message otherwise.
pub async fn download_and_install(
    downloader: &dyn Downloader,
    layout: &Layout,
    notify: &(dyn Fn(Value) + Send + Sync),
    install: Installer,
) -> Result<PathBuf, String> {
    notify(json!({ "state": "downloading" }));
    let archive = std::env::temp_dir().join(format!("habibi-whatsapp-{}.download", uuid::Uuid::new_v4()));
    let last = std::sync::Mutex::new(0u8);
    let progress = |percentage: u8| {
        let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
        if percentage != *last {
            *last = percentage;
            notify(json!({ "state": "downloading", "progress": percentage }));
        }
    };
    let downloaded = downloader.download(&asset_url(&layout.version), &archive, MAX_ARCHIVE_BYTES, &progress).await;
    if let Err(error) = downloaded {
        let _ = std::fs::remove_file(&archive);
        return Err(error.message());
    }
    notify(json!({ "state": "verifying" }));
    let (archive_path, layout) = (archive.clone(), layout.clone());
    let installed = tokio::task::spawn_blocking(move || install(&archive_path, &layout))
        .await
        .unwrap_or_else(|_| Err("Could not install the WhatsApp component.".into()));
    let _ = std::fs::remove_file(&archive);
    installed
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn archives_may_only_contain_the_component() {
        let name = component_name();
        assert!(valid_archive_listing(&format!("{name}/\n{name}/Contents/Info.plist\n")));
        for bad in [
            String::new(),
            format!("{name}/\nother/file"),
            format!("{name}/../../escape"),
            format!("/{name}/x"),
            format!("{name}/a\\b"),
            format!("{name}-other/x"),
        ] {
            assert!(!valid_archive_listing(&bad), "{bad}");
        }
    }

    #[test]
    fn downloads_are_versioned_and_fixed_origin() {
        let url = asset_url("1.2.3");
        assert!(url.starts_with("https://github.com/clidey/habibi/releases/download/v1.2.3/Habibi-WhatsApp-"));
        let suffix = if cfg!(target_os = "macos") { "-1.2.3.zip" } else { "-1.2.3.tar.gz" };
        assert!(url.ends_with(suffix), "{url}");
        if cfg!(windows) {
            assert!(url.contains("/Habibi-WhatsApp-windows-"));
        } else if cfg!(target_os = "linux") {
            assert!(url.contains("/Habibi-WhatsApp-linux-"));
        }
        assert_eq!(
            DownloadError::Status(404).message(),
            "WhatsApp support is not available for this Habibi version. Update Habibi and try again."
        );
        assert_eq!(DownloadError::Status(500).message(), "The WhatsApp download failed (HTTP 500). Try again.");
    }

    struct Failing(DownloadError, Mutex<Vec<String>>);

    #[async_trait]
    impl Downloader for Failing {
        async fn download(&self, url: &str, dest: &Path, _: u64, progress: &(dyn Fn(u8) + Send + Sync)) -> Result<(), DownloadError> {
            self.1.lock().unwrap().push(url.to_string());
            progress(40);
            progress(40);
            assert!(!dest.exists(), "nothing is written before the status check");
            Err(self.0)
        }
    }

    fn never_installs(_: &Path, _: &Layout) -> Result<PathBuf, String> {
        panic!("an HTTP failure must never reach archive handling")
    }

    #[tokio::test]
    async fn http_failures_never_reach_archive_handling() {
        let root = tempfile::tempdir().unwrap();
        let paths = habibi_core::Paths::new(root.path().join("app"), root.path().join("state"), root.path());
        let mut layout = Layout::detect(&paths);
        layout.version = "1.2.3".into();
        let downloader = Failing(DownloadError::Status(404), Mutex::new(Vec::new()));
        let states = Mutex::new(Vec::new());
        let notify = |value: Value| states.lock().unwrap().push(value);
        let error = download_and_install(&downloader, &layout, &notify, never_installs).await.unwrap_err();
        assert!(error.contains("not available for this Habibi version"));
        assert_eq!(downloader.1.lock().unwrap()[0], asset_url("1.2.3"));
        let states = states.lock().unwrap().clone();
        assert_eq!(states, vec![json!({ "state": "downloading" }), json!({ "state": "downloading", "progress": 40 })]);
        assert!(!layout.components_dir.exists());
    }
}
