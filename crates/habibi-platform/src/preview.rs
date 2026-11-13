//! Quick Look on macOS (`qlmanage -p`); elsewhere the file opens with its
//! default app.

use std::path::Path;
use std::process::Child;
use std::sync::Mutex;

use crate::PlatformResult;

/// Show a preview of `path` without tracking it (`/api/preview-file`).
pub fn preview_file(path: &Path) -> PlatformResult<()> {
    #[cfg(target_os = "macos")]
    {
        let mut command = crate::exec::command("/usr/bin/qlmanage");
        command.arg("-p").arg(path);
        crate::exec::spawn_detached(command, "The preview could not be opened.")
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::open::open_detached(&path.to_string_lossy())
    }
}

/// The one toggleable Quick Look panel (`/api/quick-look`).
#[derive(Default)]
pub struct QuickLook {
    panel: Mutex<Option<Child>>,
}

impl QuickLook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Close the panel if it is still open; true when one was closed.
    pub fn close_if_open(&self) -> bool {
        let mut panel = self.panel.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut child) = panel.take() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => {
                crate::processes::terminate(child.id(), false);
                crate::exec::reap(child);
                true
            }
            _ => false,
        }
    }

    /// Open the panel for `path` (on other platforms, open the file).
    pub fn open(&self, path: &Path) -> PlatformResult<()> {
        #[cfg(target_os = "macos")]
        {
            let mut command = crate::exec::command("/usr/bin/qlmanage");
            command.arg("-p").arg(path);
            let child = command.spawn().map_err(|_| {
                crate::PlatformError::Failed("The preview could not be opened.".into())
            })?;
            *self.panel.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            crate::open::open_detached(&path.to_string_lossy())
        }
    }
}
