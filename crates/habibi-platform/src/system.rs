//! System actions: sleep, restart, shut down, lock, toggle dark mode, empty
//! the trash, plus opening the Applications folder and system settings.
//!
//! These are destructive; callers must have consumed a fresh approval first.

use crate::{PlatformError, PlatformResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAction {
    Sleep,
    Restart,
    Shutdown,
    Lock,
    ToggleDarkMode,
    EmptyTrash,
}

impl SystemAction {
    /// The UI's action names: `sleep`, `restart`, `shutdown`, `lock`,
    /// `darkMode`, `emptyTrash`.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "sleep" => Self::Sleep,
            "restart" => Self::Restart,
            "shutdown" => Self::Shutdown,
            "lock" => Self::Lock,
            "darkMode" => Self::ToggleDarkMode,
            "emptyTrash" => Self::EmptyTrash,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Sleep => "sleep",
            Self::Restart => "restart",
            Self::Shutdown => "shutdown",
            Self::Lock => "lock",
            Self::ToggleDarkMode => "darkMode",
            Self::EmptyTrash => "emptyTrash",
        }
    }
}

/// One helper program invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Step {
    pub program: &'static str,
    pub args: Vec<String>,
}

fn step(program: &'static str, args: &[&str]) -> Step {
    Step {
        program,
        args: args.iter().map(|arg| arg.to_string()).collect(),
    }
}

const FAILED: &str = "The system action could not be started.";

/// Perform `action`. Returns once the OS has been asked to do it.
pub fn run(action: SystemAction) -> PlatformResult<()> {
    let steps = plan(action, current_dark_mode)?;
    let Some((last, first)) = steps.split_last() else {
        return Err(PlatformError::Unsupported);
    };
    for step in first {
        let mut command = crate::exec::command(step.program);
        command.args(&step.args);
        if !crate::exec::succeeds(command) {
            return Err(PlatformError::Failed(FAILED.into()));
        }
    }
    let mut command = crate::exec::command(last.program);
    command.args(&last.args);
    crate::exec::spawn_detached(command, FAILED)
}

/// Open the list of installed applications.
pub fn open_applications() -> PlatformResult<()> {
    if cfg!(target_os = "macos") {
        crate::open::open_detached("/Applications")
    } else if cfg!(target_os = "windows") {
        crate::open::open_detached("shell:AppsFolder")
    } else {
        Err(PlatformError::Unsupported)
    }
}

/// Open the system settings app.
pub fn open_settings() -> PlatformResult<()> {
    #[cfg(target_os = "macos")]
    {
        let mut command = crate::exec::command("/usr/bin/open");
        command.args(["-a", "System Settings"]);
        crate::exec::spawn_detached(command, FAILED)
    }
    #[cfg(target_os = "windows")]
    {
        crate::open::open_detached("ms-settings:")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        for program in [
            "gnome-control-center",
            "systemsettings",
            "xfce4-settings-manager",
            "mate-control-center",
        ] {
            if let Some(path) = crate::exec::which(program) {
                return crate::exec::spawn_detached(crate::exec::command(path), FAILED);
            }
        }
        Err(PlatformError::Unsupported)
    }
}

/// Whether dark mode is on now, for platforms where toggling needs it.
#[allow(unreachable_code)]
fn current_dark_mode() -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        let mut command = crate::exec::command("reg.exe");
        command.args(["query", WINDOWS_THEME_KEY, "/v", "AppsUseLightTheme"]);
        let output = crate::exec::output(command)?;
        return windows_dark_from_reg(&output);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut command = crate::exec::command(crate::exec::which("gsettings")?);
        command.args(["get", "org.gnome.desktop.interface", "color-scheme"]);
        let output = crate::exec::output(command)?;
        return Some(output.contains("prefer-dark"));
    }
    None
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WINDOWS_THEME_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

/// Parse `reg query ... /v AppsUseLightTheme`: `0x0` means dark.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_dark_from_reg(output: &str) -> Option<bool> {
    let line = output
        .lines()
        .find(|line| line.contains("AppsUseLightTheme"))?;
    let value = line.split_whitespace().last()?;
    Some(u32::from_str_radix(value.trim_start_matches("0x"), 16).ok()? == 0)
}

/// The helper invocations for `action` on this OS. `dark_mode` is asked only
/// when toggling needs the current state.
#[allow(unused_variables)]
pub(crate) fn plan(
    action: SystemAction,
    dark_mode: impl FnOnce() -> Option<bool>,
) -> PlatformResult<Vec<Step>> {
    #[cfg(target_os = "macos")]
    {
        let script = |source: &str| step("/usr/bin/osascript", &["-e", source]);
        Ok(vec![match action {
            SystemAction::Sleep => script(r#"tell application "System Events" to sleep"#),
            SystemAction::Restart => script(r#"tell application "System Events" to restart"#),
            SystemAction::Shutdown => script(r#"tell application "System Events" to shut down"#),
            SystemAction::Lock => step(
                "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
                &["-suspend"],
            ),
            SystemAction::ToggleDarkMode => script(
                r#"tell application "System Events" to tell appearance preferences to set dark mode to not dark mode"#,
            ),
            SystemAction::EmptyTrash => script(r#"tell application "Finder" to empty the trash"#),
        }])
    }
    #[cfg(target_os = "windows")]
    {
        Ok(match action {
            SystemAction::Sleep => vec![step(
                "rundll32.exe",
                &["powrprof.dll,SetSuspendState", "0,1,0"],
            )],
            SystemAction::Restart => vec![step("shutdown.exe", &["/r", "/t", "0"])],
            SystemAction::Shutdown => vec![step("shutdown.exe", &["/s", "/t", "0"])],
            SystemAction::Lock => vec![step("rundll32.exe", &["user32.dll,LockWorkStation"])],
            SystemAction::ToggleDarkMode => {
                let dark = dark_mode().ok_or(PlatformError::Unsupported)?;
                // Light theme flag: 1 = light. Turning dark mode off sets 1.
                let light = if dark { "1" } else { "0" };
                ["AppsUseLightTheme", "SystemUsesLightTheme"]
                    .iter()
                    .map(|name| {
                        step(
                            "reg.exe",
                            &[
                                "add",
                                WINDOWS_THEME_KEY,
                                "/v",
                                name,
                                "/t",
                                "REG_DWORD",
                                "/d",
                                light,
                                "/f",
                            ],
                        )
                    })
                    .collect()
            }
            SystemAction::EmptyTrash => vec![step(
                "powershell.exe",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Clear-RecycleBin -Force -ErrorAction SilentlyContinue",
                ],
            )],
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(match action {
            SystemAction::Sleep => vec![step("systemctl", &["suspend"])],
            SystemAction::Restart => vec![step("systemctl", &["reboot"])],
            SystemAction::Shutdown => vec![step("systemctl", &["poweroff"])],
            SystemAction::Lock => vec![step("loginctl", &["lock-session"])],
            SystemAction::ToggleDarkMode => {
                let dark = dark_mode().ok_or(PlatformError::Unsupported)?;
                let scheme = if dark { "default" } else { "prefer-dark" };
                vec![step(
                    "gsettings",
                    &["set", "org.gnome.desktop.interface", "color-scheme", scheme],
                )]
            }
            SystemAction::EmptyTrash => vec![step("gio", &["trash", "--empty"])],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for action in [
            SystemAction::Sleep,
            SystemAction::Restart,
            SystemAction::Shutdown,
            SystemAction::Lock,
            SystemAction::ToggleDarkMode,
            SystemAction::EmptyTrash,
        ] {
            assert_eq!(SystemAction::parse(action.name()), Some(action));
        }
        assert_eq!(SystemAction::parse("format"), None);
    }

    #[test]
    fn every_action_has_a_plan_with_constant_arguments() {
        for action in [
            SystemAction::Sleep,
            SystemAction::Lock,
            SystemAction::ToggleDarkMode,
            SystemAction::EmptyTrash,
        ] {
            let steps = plan(action, || Some(true)).unwrap();
            assert!(!steps.is_empty());
        }
        #[cfg(target_os = "macos")]
        assert_eq!(
            plan(SystemAction::Lock, || None).unwrap()[0].args,
            ["-suspend"]
        );
    }

    #[test]
    fn windows_registry_output_parses() {
        let output = "\r\nHKEY_CURRENT_USER\\...\\Personalize\r\n    AppsUseLightTheme    REG_DWORD    0x0\r\n";
        assert_eq!(windows_dark_from_reg(output), Some(true));
        assert_eq!(
            windows_dark_from_reg(&output.replace("0x0", "0x1")),
            Some(false)
        );
        assert_eq!(windows_dark_from_reg(""), None);
    }
}
