use std::path::{Path, PathBuf};

/// Where Habibi reads bundled resources and keeps local state.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Bundled, read-only resources: `skills/`, `assets/`, `index.html`.
    pub app_root: PathBuf,
    /// Per-user writable state. Services keep their files under
    /// `state_root/.habibi/` (and OpenWA under `state_root/.openwa/`), exactly
    /// as the Node host did, so existing installs keep their data.
    pub state_root: PathBuf,
    /// The user's home directory.
    pub home: PathBuf,
}

impl Paths {
    pub fn new(app_root: impl Into<PathBuf>, state_root: impl Into<PathBuf>, home: impl Into<PathBuf>) -> Self {
        Self { app_root: app_root.into(), state_root: state_root.into(), home: home.into() }
    }

    /// `state_root/.habibi/<relative>`.
    pub fn state(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.state_root.join(".habibi").join(relative)
    }

    /// True when `candidate` is strictly inside the home directory.
    pub fn is_inside_home(&self, candidate: &Path) -> bool {
        candidate != self.home && candidate.starts_with(&self.home)
    }
}
