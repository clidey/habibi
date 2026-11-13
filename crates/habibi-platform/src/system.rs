//! System actions: sleep, restart, shut down, lock, toggle dark mode, empty
//! the trash, plus opening the Applications folder and system settings.
//!
//! Every helper is a program with separate arguments; nothing goes through a
//! shell.
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
    #[cfg(target_os = "macos")]
    {
        crate::open::open_detached("/Applications")
    }
    #[cfg(target_os = "windows")]
    {
        crate::open::open_detached("shell:AppsFolder")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let plan = linux_open_applications_plan(linux_desktop_now(), &|program| {
            crate::exec::which(program).is_some()
        });
        first_that_works(&plan, &mut |attempt| match attempt {
            Attempt::Call(step) => {
                let mut command = crate::exec::command(step.program);
                command.args(&step.args);
                crate::exec::succeeds(command)
            }
            Attempt::Spawn(step) => {
                let mut command = crate::exec::command(step.program);
                command.args(&step.args);
                crate::exec::spawn_detached(command, FAILED).is_ok()
            }
        })
    }
}

/// One way to do something on Linux, tried in order until one works.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Attempt {
    /// Run to completion; it worked when it exits 0 (D-Bus calls).
    Call(Step),
    /// Start a program and leave it running.
    Spawn(Step),
}

/// Try each attempt until `run` reports one worked. `Unsupported` when there
/// is nothing to try.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(crate) fn first_that_works(
    attempts: &[Attempt],
    run: &mut dyn FnMut(&Attempt) -> bool,
) -> PlatformResult<()> {
    if attempts.is_empty() {
        return Err(PlatformError::Unsupported);
    }
    if attempts.iter().any(run) {
        Ok(())
    } else {
        Err(PlatformError::Failed(FAILED.into()))
    }
}

/// The Linux desktops with their own launcher and theme tools.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinuxDesktop {
    Gnome,
    Kde,
    Xfce,
    Other,
}

/// The desktop from `XDG_CURRENT_DESKTOP`, a `:`-separated list such as
/// `ubuntu:GNOME`, `KDE` or `XFCE`.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(crate) fn linux_desktop(current_desktop: &str) -> LinuxDesktop {
    let names: Vec<String> = current_desktop
        .split(':')
        .map(|name| name.trim().to_ascii_uppercase())
        .collect();
    let has = |name: &str| names.iter().any(|n| n == name);
    if has("KDE") {
        LinuxDesktop::Kde
    } else if has("GNOME") {
        LinuxDesktop::Gnome
    } else if has("XFCE") {
        LinuxDesktop::Xfce
    } else {
        LinuxDesktop::Other
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn linux_desktop_now() -> LinuxDesktop {
    linux_desktop(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default())
}

/// A session-bus method call with string arguments `args`, through `gdbus`
/// or `dbus-send` (whichever is installed), with a short timeout so a
/// missing service cannot hang the request.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn dbus_call(
    has: &dyn Fn(&str) -> bool,
    destination: &str,
    object: &str,
    method: &str,
    args: &[&str],
) -> Option<Step> {
    if has("gdbus") {
        let mut argv = vec![
            "call",
            "--session",
            "--timeout",
            "3",
            "--dest",
            destination,
            "--object-path",
            object,
            "--method",
            method,
        ];
        argv.extend(args);
        return Some(step("gdbus", &argv));
    }
    if has("dbus-send") {
        let destination = format!("--dest={destination}");
        let typed: Vec<String> = args.iter().map(|arg| format!("string:{arg}")).collect();
        let mut argv = vec![
            "--session",
            "--print-reply",
            "--reply-timeout=3000",
            destination.as_str(),
            object,
            method,
        ];
        argv.extend(typed.iter().map(String::as_str));
        return Some(step("dbus-send", &argv));
    }
    None
}

/// Ways to show the installed applications on a Linux desktop, best first.
///
/// - GNOME: the Shell's `ShowApplications` (GNOME 41 and later only allow it
///   from their own components, so it usually fails), then GNOME Software's
///   Installed page.
/// - KDE Plasma: open the application launcher (`activateLauncherMenu`, the
///   Alt+F1 action), then Discover's Installed page.
/// - Xfce: the application finder.
///
/// Anything else is unsupported rather than guessed at.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(crate) fn linux_open_applications_plan(
    desktop: LinuxDesktop,
    has: &dyn Fn(&str) -> bool,
) -> Vec<Attempt> {
    let mut plan = Vec::new();
    match desktop {
        LinuxDesktop::Gnome => {
            plan.extend(
                dbus_call(
                    has,
                    "org.gnome.Shell",
                    "/org/gnome/Shell",
                    "org.gnome.Shell.ShowApplications",
                    &[],
                )
                .map(Attempt::Call),
            );
            if has("gnome-software") {
                plan.push(Attempt::Spawn(step(
                    "gnome-software",
                    &["--mode=installed"],
                )));
            }
        }
        LinuxDesktop::Kde => {
            plan.extend(
                dbus_call(
                    has,
                    "org.kde.plasmashell",
                    "/PlasmaShell",
                    "org.kde.PlasmaShell.activateLauncherMenu",
                    &[],
                )
                .map(Attempt::Call),
            );
            if has("plasma-discover") {
                plan.push(Attempt::Spawn(step(
                    "plasma-discover",
                    &["--mode", "Installed"],
                )));
            }
        }
        LinuxDesktop::Xfce => {
            if has("xfce4-appfinder") {
                plan.push(Attempt::Spawn(step("xfce4-appfinder", &[])));
            }
        }
        LinuxDesktop::Other => {}
    }
    plan
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
        let has = |program: &str| crate::exec::which(program).is_some();
        let read = |step: Step| {
            let mut command = crate::exec::command(step.program);
            command.args(&step.args);
            crate::exec::output(command)
        };
        return linux_dark_mode(linux_desktop_now(), &has, &mut |step| read(step));
    }
    None
}

/// Whether dark mode is on, asking the place the toggle writes to first and
/// the freedesktop settings portal (which every desktop backend answers)
/// otherwise. `read` runs a step and returns its stdout on success.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(crate) fn linux_dark_mode(
    desktop: LinuxDesktop,
    has: &dyn Fn(&str) -> bool,
    read: &mut dyn FnMut(Step) -> Option<String>,
) -> Option<bool> {
    let portal = |read: &mut dyn FnMut(Step) -> Option<String>| {
        let call = dbus_call(
            has,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings.Read",
            &["org.freedesktop.appearance", "color-scheme"],
        )?;
        portal_prefers_dark(&read(call)?)
    };
    if desktop == LinuxDesktop::Kde {
        // A custom KDE scheme name says little; the portal reports what the
        // colors actually are.
        if let Some(dark) = portal(read) {
            return Some(dark);
        }
        let tool = ["kreadconfig6", "kreadconfig5"]
            .into_iter()
            .find(|tool| has(tool))?;
        let scheme = read(step(
            tool,
            &[
                "--file",
                "kdeglobals",
                "--group",
                "General",
                "--key",
                "ColorScheme",
            ],
        ))?;
        return Some(scheme.to_ascii_lowercase().contains("dark"));
    }
    if has("gsettings")
        && let Some(output) = read(step(
            "gsettings",
            &["get", "org.gnome.desktop.interface", "color-scheme"],
        ))
    {
        return Some(output.contains("prefer-dark"));
    }
    portal(read)
}

/// Parse the portal's `color-scheme` reply (`(<<uint32 1>>,)` from gdbus,
/// `variant variant uint32 1` from dbus-send): 1 means prefer dark, 0 (no
/// preference) and 2 (prefer light) mean light.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(crate) fn portal_prefers_dark(output: &str) -> Option<bool> {
    let (_, rest) = output.rsplit_once("uint32")?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    match digits.parse::<u32>().ok()? {
        1 => Some(true),
        0 | 2 => Some(false),
        _ => None,
    }
}

/// The steps that switch dark mode to `!dark` on a Linux desktop: Plasma's
/// color scheme tool (or its global theme tool), else GNOME's
/// `color-scheme` setting, which GNOME and the GTK desktops that follow it
/// read. The portal cannot write settings. `None` when no tool is present.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(crate) fn linux_dark_mode_steps(
    desktop: LinuxDesktop,
    dark: bool,
    has: &dyn Fn(&str) -> bool,
) -> Option<Vec<Step>> {
    if desktop == LinuxDesktop::Kde {
        if has("plasma-apply-colorscheme") {
            let scheme = if dark { "BreezeLight" } else { "BreezeDark" };
            return Some(vec![step("plasma-apply-colorscheme", &[scheme])]);
        }
        if has("lookandfeeltool") {
            let package = if dark {
                "org.kde.breeze.desktop"
            } else {
                "org.kde.breezedark.desktop"
            };
            return Some(vec![step("lookandfeeltool", &["-a", package])]);
        }
        return None;
    }
    if !has("gsettings") {
        return None;
    }
    let scheme = if dark { "default" } else { "prefer-dark" };
    Some(vec![step(
        "gsettings",
        &["set", "org.gnome.desktop.interface", "color-scheme", scheme],
    )])
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
                linux_dark_mode_steps(linux_desktop_now(), dark, &|program| {
                    crate::exec::which(program).is_some()
                })
                .ok_or(PlatformError::Unsupported)?
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
            // Linux dark mode depends on the desktop's tools; tested below.
            if cfg!(not(any(target_os = "macos", target_os = "windows")))
                && action == SystemAction::ToggleDarkMode
            {
                continue;
            }
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

    fn only<'a>(programs: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |program| programs.contains(&program)
    }

    #[test]
    fn linux_desktops_come_from_xdg_current_desktop() {
        assert_eq!(linux_desktop("ubuntu:GNOME"), LinuxDesktop::Gnome);
        assert_eq!(linux_desktop("KDE"), LinuxDesktop::Kde);
        assert_eq!(linux_desktop("XFCE"), LinuxDesktop::Xfce);
        assert_eq!(linux_desktop("Budgie:GNOME"), LinuxDesktop::Gnome);
        assert_eq!(linux_desktop("X-Cinnamon"), LinuxDesktop::Other);
        assert_eq!(linux_desktop(""), LinuxDesktop::Other);
    }

    #[test]
    fn linux_open_applications_tries_the_desktops_launcher_first() {
        let gnome =
            linux_open_applications_plan(LinuxDesktop::Gnome, &only(&["gdbus", "gnome-software"]));
        assert_eq!(gnome.len(), 2);
        let Attempt::Call(call) = &gnome[0] else {
            panic!("D-Bus call first")
        };
        assert_eq!(call.program, "gdbus");
        assert!(
            call.args
                .contains(&"org.gnome.Shell.ShowApplications".to_string())
        );
        assert_eq!(
            gnome[1],
            Attempt::Spawn(step("gnome-software", &["--mode=installed"]))
        );

        let kde = linux_open_applications_plan(
            LinuxDesktop::Kde,
            &only(&["dbus-send", "plasma-discover"]),
        );
        assert_eq!(
            kde,
            [
                Attempt::Call(step(
                    "dbus-send",
                    &[
                        "--session",
                        "--print-reply",
                        "--reply-timeout=3000",
                        "--dest=org.kde.plasmashell",
                        "/PlasmaShell",
                        "org.kde.PlasmaShell.activateLauncherMenu",
                    ]
                )),
                Attempt::Spawn(step("plasma-discover", &["--mode", "Installed"])),
            ]
        );
        assert_eq!(
            linux_open_applications_plan(LinuxDesktop::Xfce, &only(&["xfce4-appfinder"])),
            [Attempt::Spawn(step("xfce4-appfinder", &[]))]
        );
        assert!(linux_open_applications_plan(LinuxDesktop::Other, &only(&["gdbus"])).is_empty());
        assert!(linux_open_applications_plan(LinuxDesktop::Gnome, &only(&[])).is_empty());
    }

    #[test]
    fn attempts_stop_at_the_first_that_works() {
        let plan = [
            Attempt::Call(step("a", &[])),
            Attempt::Spawn(step("b", &[])),
            Attempt::Spawn(step("c", &[])),
        ];
        let mut tried = Vec::new();
        let result = first_that_works(&plan, &mut |attempt| {
            let (Attempt::Call(step) | Attempt::Spawn(step)) = attempt;
            tried.push(step.program);
            step.program == "b"
        });
        assert!(result.is_ok());
        assert_eq!(tried, ["a", "b"]);
        assert!(matches!(
            first_that_works(&plan, &mut |_| false),
            Err(PlatformError::Failed(_))
        ));
        assert!(matches!(
            first_that_works(&[], &mut |_| true),
            Err(PlatformError::Unsupported)
        ));
    }

    #[test]
    fn linux_dark_mode_toggles_with_the_desktops_own_tool() {
        let gnome = only(&["gsettings", "plasma-apply-colorscheme"]);
        assert_eq!(
            linux_dark_mode_steps(LinuxDesktop::Gnome, false, &gnome).unwrap(),
            [step(
                "gsettings",
                &[
                    "set",
                    "org.gnome.desktop.interface",
                    "color-scheme",
                    "prefer-dark"
                ]
            )]
        );
        assert_eq!(
            linux_dark_mode_steps(LinuxDesktop::Other, true, &gnome).unwrap()[0].args[3],
            "default"
        );
        assert_eq!(
            linux_dark_mode_steps(LinuxDesktop::Kde, true, &gnome).unwrap(),
            [step("plasma-apply-colorscheme", &["BreezeLight"])]
        );
        assert_eq!(
            linux_dark_mode_steps(LinuxDesktop::Kde, false, &only(&["lookandfeeltool"])).unwrap(),
            [step(
                "lookandfeeltool",
                &["-a", "org.kde.breezedark.desktop"]
            )]
        );
        assert_eq!(
            linux_dark_mode_steps(LinuxDesktop::Kde, false, &only(&["gsettings"])),
            None
        );
        assert_eq!(
            linux_dark_mode_steps(LinuxDesktop::Gnome, false, &only(&[])),
            None
        );
    }

    #[test]
    fn portal_replies_parse_from_both_dbus_tools() {
        assert_eq!(portal_prefers_dark("(<<uint32 1>>,)\n"), Some(true));
        assert_eq!(portal_prefers_dark("(<<uint32 2>>,)"), Some(false));
        assert_eq!(portal_prefers_dark("(<uint32 0>,)"), Some(false));
        assert_eq!(
            portal_prefers_dark(
                "method return time=1 sender=:1.5\n   variant       variant          uint32 1\n"
            ),
            Some(true)
        );
        assert_eq!(portal_prefers_dark("(<<uint32 7>>,)"), None);
        assert_eq!(portal_prefers_dark("Error: No such interface"), None);
    }

    #[test]
    fn linux_dark_mode_reads_the_toggled_setting_then_the_portal() {
        // GNOME: gsettings answers.
        let mut asked = Vec::new();
        let dark = linux_dark_mode(
            LinuxDesktop::Gnome,
            &only(&["gsettings", "gdbus"]),
            &mut |s| {
                asked.push(s.program);
                Some("'prefer-dark'\n".into())
            },
        );
        assert_eq!(
            (dark, asked.as_slice()),
            (Some(true), ["gsettings"].as_slice())
        );
        // gsettings fails (old GNOME): the portal answers.
        let dark = linux_dark_mode(
            LinuxDesktop::Gnome,
            &only(&["gsettings", "gdbus"]),
            &mut |s| (s.program == "gdbus").then(|| "(<<uint32 2>>,)".into()),
        );
        assert_eq!(dark, Some(false));
        // KDE: the portal first, then the scheme name.
        let dark = linux_dark_mode(
            LinuxDesktop::Kde,
            &only(&["dbus-send", "kreadconfig6"]),
            &mut |s| (s.program == "dbus-send").then(|| "variant variant uint32 1".into()),
        );
        assert_eq!(dark, Some(true));
        let dark = linux_dark_mode(LinuxDesktop::Kde, &only(&["kreadconfig5"]), &mut |s| {
            assert_eq!(s.args[..2], ["--file", "kdeglobals"]);
            Some("BreezeDark\n".into())
        });
        assert_eq!(dark, Some(true));
        assert_eq!(
            linux_dark_mode(LinuxDesktop::Other, &only(&[]), &mut |_| None),
            None
        );
    }
}
