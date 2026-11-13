//! Running processes: a snapshot with cpu/memory, grouping into running apps,
//! working directories (for agent sessions), and quit / force quit.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::apps::App;

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessInfo {
    pub pid: u32,
    /// Percent of one core, like `ps -o pcpu`.
    pub cpu: f32,
    pub memory_bytes: u64,
    /// The full command line, like `ps -o command`.
    pub command: String,
    pub exe: Option<PathBuf>,
    /// Seconds since the process started.
    pub run_time: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunningApp {
    pub name: String,
    pub path: String,
    pub pids: Vec<u32>,
    /// Summed cpu percent, rounded to one decimal.
    pub cpu: f64,
    /// Summed resident memory in MB, at least 1.
    pub memory_mb: u64,
}

struct Sampler {
    system: System,
    refreshed: Instant,
}

fn sampler() -> &'static Mutex<Option<Sampler>> {
    static SAMPLER: OnceLock<Mutex<Option<Sampler>>> = OnceLock::new();
    SAMPLER.get_or_init(|| Mutex::new(None))
}

fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_exe(UpdateKind::OnlyIfNotSet)
}

/// Every visible process. CPU usage needs two samples, so the first call
/// waits one sampling interval; later calls reuse the previous sample.
/// Blocking.
pub fn snapshot() -> Vec<ProcessInfo> {
    let mut guard = sampler().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let Ok(mut system) = System::new() else {
            return Vec::new();
        };
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
        *guard = Some(Sampler {
            system,
            refreshed: Instant::now(),
        });
    }
    let Some(sampler) = guard.as_mut() else {
        return Vec::new();
    };
    let elapsed = sampler.refreshed.elapsed();
    if elapsed < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL - elapsed);
    }
    sampler
        .system
        .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
    sampler.refreshed = Instant::now();
    let mut processes: Vec<ProcessInfo> = sampler
        .system
        .processes()
        .iter()
        .filter(|(_, process)| process.thread_kind().is_none())
        .map(|(pid, process)| {
            let command = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let exe = process.exe().map(Path::to_path_buf);
            ProcessInfo {
                pid: pid.as_u32(),
                cpu: process.cpu_usage(),
                memory_bytes: process.memory(),
                command: if command.is_empty() {
                    exe.as_ref()
                        .map(|e| e.to_string_lossy().into_owned())
                        .unwrap_or_default()
                } else {
                    command
                },
                exe,
                run_time: process.run_time(),
            }
        })
        .collect();
    processes.sort_by_key(|process| process.pid);
    processes
}

/// The working directory of `pid` (the `lsof -d cwd` lookup). Blocking.
pub fn working_directory(pid: u32) -> Option<PathBuf> {
    let mut system = System::new().ok()?;
    let pids = [Pid::from_u32(pid)];
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    system
        .process(pids[0])?
        .cwd()
        .filter(|cwd| !cwd.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

/// `ps -o etime` formatting: `[[dd-]hh:]mm:ss`.
pub fn format_elapsed(seconds: u64) -> String {
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (hours, rest) = (rest / 3_600, rest % 3_600);
    let (minutes, seconds) = (rest / 60, rest % 60);
    if days > 0 {
        format!("{days}-{hours:02}:{minutes:02}:{seconds:02}")
    } else if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

/// Ask `pid` to quit (`SIGTERM`, or a normal close on Windows) or force it
/// (`SIGKILL`, `taskkill /F`). True when the request was delivered.
pub fn terminate(pid: u32, force: bool) -> bool {
    if pid <= 1 || pid == std::process::id() {
        return false;
    }
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: kill(2) has no memory-safety preconditions.
        unsafe { libc::kill(pid, signal) == 0 }
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = crate::exec::command("taskkill.exe");
        command.arg("/PID").arg(pid.to_string());
        if force {
            command.arg("/F");
        }
        crate::exec::succeeds(command)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = force;
        false
    }
}

/// The `.app` bundle a macOS process belongs to, from its command line.
/// The command can point at a symlink target in the sealed system volume, so
/// callers match both the discovered path and its real path.
pub fn macos_bundle_path(command: &str) -> Option<&str> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(/(?:Applications|System/Applications|System/Cryptexes/App/System/Applications|Users/[^/]+/Applications)/.*?\.app)(?:/|$)",
            )
            .expect("valid pattern")
        })
        .captures(command)
        .and_then(|captures| captures.get(1))
        .map(|bundle| bundle.as_str())
}

/// Group processes under the app `owner` assigns them to, summing cpu and
/// memory; sorted by cpu, then memory, then name. Habibi itself is skipped.
pub fn group<'a>(
    processes: &[ProcessInfo],
    mut owner: impl FnMut(&ProcessInfo) -> Option<&'a App>,
) -> Vec<RunningApp> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (RunningApp, f64, f64)> = HashMap::new();
    for process in processes {
        let Some(app) = owner(process) else { continue };
        if app.name == "Habibi" {
            continue;
        }
        let entry = groups.entry(app.path.clone()).or_insert_with(|| {
            order.push(app.path.clone());
            (
                RunningApp {
                    name: app.name.clone(),
                    path: app.path.clone(),
                    pids: Vec::new(),
                    cpu: 0.0,
                    memory_mb: 0,
                },
                0.0,
                0.0,
            )
        });
        entry.0.pids.push(process.pid);
        entry.1 += f64::from(process.cpu);
        entry.2 += process.memory_bytes as f64 / 1024.0 / 1024.0;
    }
    let mut apps: Vec<RunningApp> = order
        .into_iter()
        .filter_map(|path| groups.remove(&path))
        .map(|(mut app, cpu, memory)| {
            app.cpu = (cpu * 10.0).round() / 10.0;
            app.memory_mb = (memory.round() as u64).max(1);
            app
        })
        .collect();
    apps.sort_by(|a, b| {
        b.cpu
            .total_cmp(&a.cpu)
            .then(b.memory_mb.cmp(&a.memory_mb))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    apps
}

/// Running apps among `apps` (from [`crate::apps::discover`]). Blocking.
pub fn running_apps(apps: &[App], processes: &[ProcessInfo]) -> Vec<RunningApp> {
    let mut by_path: HashMap<String, &App> = HashMap::new();
    for app in apps {
        if cfg!(target_os = "macos") {
            by_path.insert(app.path.clone(), app);
            if let Ok(real) = std::fs::canonicalize(&app.path) {
                by_path.insert(real.to_string_lossy().into_owned(), app);
            }
        } else if let Some(executable) = &app.executable {
            let key = |path: &Path| {
                let text = path.to_string_lossy().into_owned();
                if cfg!(target_os = "windows") {
                    text.to_lowercase()
                } else {
                    text
                }
            };
            by_path.insert(key(executable), app);
            if let Ok(real) = std::fs::canonicalize(executable) {
                by_path.insert(key(&real), app);
            }
        }
    }
    let mut real_paths: HashMap<String, Option<String>> = HashMap::new();
    let mut lookup = |candidate: &str| -> Option<&App> {
        if let Some(app) = by_path.get(candidate) {
            return Some(*app);
        }
        let real = real_paths.entry(candidate.to_string()).or_insert_with(|| {
            std::fs::canonicalize(candidate)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        });
        real.as_ref().and_then(|real| by_path.get(real).copied())
    };
    group(processes, |process| {
        if cfg!(target_os = "macos") {
            macos_bundle_path(&process.command).and_then(&mut lookup)
        } else {
            let exe = process.exe.as_ref()?.to_string_lossy().into_owned();
            let exe = if cfg!(target_os = "windows") {
                exe.to_lowercase()
            } else {
                exe
            };
            lookup(&exe)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, cpu: f32, mb: u64, command: &str) -> ProcessInfo {
        ProcessInfo {
            pid,
            cpu,
            memory_bytes: mb * 1024 * 1024,
            command: command.into(),
            exe: None,
            run_time: 0,
        }
    }

    #[test]
    fn bundle_paths_come_from_the_command_line() {
        assert_eq!(
            macos_bundle_path("/Applications/Safari.app/Contents/MacOS/Safari -psn"),
            Some("/Applications/Safari.app")
        );
        assert_eq!(
            macos_bundle_path("/Users/a/Applications/Tool.app/Contents/Frameworks/Helper.app/x"),
            Some("/Users/a/Applications/Tool.app")
        );
        assert_eq!(macos_bundle_path("/usr/bin/ssh host"), None);
    }

    #[test]
    fn processes_group_per_app_with_rounded_totals() {
        let safari = App {
            name: "Safari".into(),
            path: "/Applications/Safari.app".into(),
            executable: None,
        };
        let notes = App {
            name: "Notes".into(),
            path: "/System/Applications/Notes.app".into(),
            executable: None,
        };
        let habibi = App {
            name: "Habibi".into(),
            path: "/Applications/Habibi.app".into(),
            executable: None,
        };
        let list = [
            process(10, 1.25, 100, "safari"),
            process(11, 2.0, 50, "safari"),
            process(12, 0.0, 0, "notes"),
            process(13, 50.0, 10, "habibi"),
            process(14, 9.0, 10, "other"),
        ];
        let apps = group(&list, |p| match p.command.as_str() {
            "safari" => Some(&safari),
            "notes" => Some(&notes),
            "habibi" => Some(&habibi),
            _ => None,
        });
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "Safari");
        assert_eq!(apps[0].pids, [10, 11]);
        assert_eq!(apps[0].cpu, 3.3);
        assert_eq!(apps[0].memory_mb, 150);
        assert_eq!(apps[1].memory_mb, 1);
    }

    #[test]
    fn elapsed_matches_ps_etime() {
        assert_eq!(format_elapsed(65), "01:05");
        assert_eq!(format_elapsed(3_661), "01:01:01");
        assert_eq!(format_elapsed(2 * 86_400 + 5), "2-00:00:05");
    }

    #[test]
    fn terminate_refuses_init_and_self() {
        assert!(!terminate(1, false));
        assert!(!terminate(std::process::id(), true));
    }
}
