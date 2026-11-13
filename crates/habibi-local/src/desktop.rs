//! Every OS side effect the routes perform, behind one interface so route
//! logic is tested without opening apps, locking the screen or killing
//! processes. [`System`] is the real implementation over `habibi_platform`.

use std::path::{Path, PathBuf};

use habibi_platform::PlatformResult;
use habibi_platform::apps::App;
use habibi_platform::processes::{ProcessInfo, RunningApp};
use habibi_platform::system::SystemAction;

/// Blocking calls; routes run them on the blocking pool.
pub trait Desktop: Send + Sync {
    fn open_detached(&self, target: &str) -> bool;
    fn open_and_wait(&self, target: &str) -> bool;
    fn discover_apps(&self) -> Vec<App>;
    fn allowed_app(&self, path: &str) -> Option<PathBuf>;
    fn launch_app(&self, app: &Path) -> bool;
    fn app_icon(&self, app: &Path) -> Option<Vec<u8>>;
    fn processes(&self) -> Vec<ProcessInfo>;
    fn running_apps(&self, apps: &[App], processes: &[ProcessInfo]) -> Vec<RunningApp>;
    fn working_directory(&self, pid: u32) -> Option<PathBuf>;
    fn terminate(&self, pid: u32, force: bool) -> bool;
    fn system_action(&self, action: SystemAction) -> PlatformResult<()>;
    fn open_applications(&self) -> PlatformResult<()>;
    fn open_settings(&self) -> PlatformResult<()>;
    fn preview_file(&self, path: &Path) -> PlatformResult<()>;
    /// True when an open Quick Look panel was closed.
    fn quick_look_close(&self) -> bool;
    fn quick_look_open(&self, path: &Path) -> PlatformResult<()>;
    fn run_in_terminal(&self, cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()>;
}

#[derive(Default)]
pub struct System {
    quick_look: habibi_platform::preview::QuickLook,
}

impl Desktop for System {
    fn open_detached(&self, target: &str) -> bool {
        habibi_platform::open::open_detached(target).is_ok()
    }

    fn open_and_wait(&self, target: &str) -> bool {
        habibi_platform::open::open_and_wait_blocking(target)
    }

    fn discover_apps(&self) -> Vec<App> {
        habibi_platform::apps::discover()
    }

    fn allowed_app(&self, path: &str) -> Option<PathBuf> {
        habibi_platform::apps::allowed_app(path)
    }

    fn launch_app(&self, app: &Path) -> bool {
        habibi_platform::apps::launch(app)
    }

    fn app_icon(&self, app: &Path) -> Option<Vec<u8>> {
        habibi_platform::apps::icon_png(app).ok()
    }

    fn processes(&self) -> Vec<ProcessInfo> {
        habibi_platform::processes::snapshot()
    }

    fn running_apps(&self, apps: &[App], processes: &[ProcessInfo]) -> Vec<RunningApp> {
        habibi_platform::processes::running_apps(apps, processes)
    }

    fn working_directory(&self, pid: u32) -> Option<PathBuf> {
        habibi_platform::processes::working_directory(pid)
    }

    fn terminate(&self, pid: u32, force: bool) -> bool {
        habibi_platform::processes::terminate(pid, force)
    }

    fn system_action(&self, action: SystemAction) -> PlatformResult<()> {
        habibi_platform::system::run(action)
    }

    fn open_applications(&self) -> PlatformResult<()> {
        habibi_platform::system::open_applications()
    }

    fn open_settings(&self) -> PlatformResult<()> {
        habibi_platform::system::open_settings()
    }

    fn preview_file(&self, path: &Path) -> PlatformResult<()> {
        habibi_platform::preview::preview_file(path)
    }

    fn quick_look_close(&self) -> bool {
        self.quick_look.close_if_open()
    }

    fn quick_look_open(&self, path: &Path) -> PlatformResult<()> {
        self.quick_look.open(path)
    }

    fn run_in_terminal(&self, cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
        habibi_platform::terminal::run_in_terminal(cwd, program, args)
    }
}
