//! Windows: the OpenWA supervisor and everything it starts (OpenWA's Node,
//! Chromium and Chromium's helpers) run inside one Job Object created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
//!
//! Windows has no process groups, so a clean quit ends the tree with
//! `taskkill /T /F`, but a crash or a kill from Task Manager skips that. Only
//! this process holds the job handle (it is created without security
//! attributes, so it is not inheritable and no child keeps the job open), and
//! the kernel closes it when Habibi exits for any reason, which ends every
//! process in the job.
//!
//! The job allows no breakaway, so every descendant stays in it: a child
//! created with `CREATE_BREAKAWAY_FROM_JOB` fails to start rather than escape,
//! and the silent breakaway Node (libuv) sets on its own per-process job only
//! lets a grandchild leave that inner job, never this one. Jobs nest on
//! Windows 8 and later, so this works when Habibi itself was started inside a
//! job (a terminal, an IDE, a CI runner).

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows::Win32::System::Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
use windows::core::PCWSTR;

/// A Job Object that ends all of its processes when its handle is closed.
pub struct KillOnCloseJob(OwnedHandle);

impl KillOnCloseJob {
    pub fn new() -> io::Result<Self> {
        // SAFETY: no security attributes (the handle is not inheritable) and no name.
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }?;
        // SAFETY: CreateJobObjectW returned a fresh handle that nothing else owns.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a JOBOBJECT_EXTENDED_LIMIT_INFORMATION of exactly the size passed.
        unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }?;
        Ok(job)
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        // SAFETY: both handles are open for the duration of the call; `child`
        // has not been waited on, so its process handle is still valid.
        unsafe { AssignProcessToJobObject(self.handle(), HANDLE(child.as_raw_handle())) }.map_err(io::Error::from)
    }

    /// Whether `child` is in this job.
    #[cfg(test)]
    pub fn contains(&self, child: &Child) -> bool {
        let mut result = windows::core::BOOL::default();
        // SAFETY: both handles are open and `result` outlives the call.
        unsafe { windows::Win32::System::JobObjects::IsProcessInJob(HANDLE(child.as_raw_handle()), Some(self.handle()), &mut result) }
            .is_ok_and(|()| result.as_bool())
    }

    /// The number of processes currently in this job.
    #[cfg(test)]
    pub fn active_processes(&self) -> io::Result<u32> {
        use windows::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation, QueryInformationJobObject,
        };
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` is a JOBOBJECT_BASIC_ACCOUNTING_INFORMATION of exactly the size passed.
        unsafe {
            QueryInformationJobObject(
                Some(self.handle()),
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        }?;
        Ok(info.ActiveProcesses)
    }
}

/// Spawn `command` with `creation_flags` inside `job`. The process is created
/// suspended, assigned, and only then resumed, so it cannot start a child
/// before it is in the job. Without a job (or if the assignment is refused)
/// it still starts; a clean quit then ends the tree with taskkill as before.
pub fn spawn(job: Option<&KillOnCloseJob>, command: &mut Command, creation_flags: u32) -> io::Result<Child> {
    let Some(job) = job else {
        command.creation_flags(creation_flags);
        return command.spawn();
    };
    command.creation_flags(creation_flags | CREATE_SUSPENDED.0);
    let mut child = command.spawn()?;
    let _ = job.assign(&child);
    if let Err(error) = resume(child.id()) {
        // A process left suspended would never run or exit on its own.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

/// Resume every thread of the (suspended, freshly created) process `pid`.
/// `std::process::Child` does not expose the primary thread handle that
/// `CreateProcessW` returned, so the thread is found by a snapshot.
fn resume(pid: u32) -> io::Result<()> {
    // SAFETY: a snapshot of all threads; the returned handle is owned below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }?;
    // SAFETY: a fresh handle that nothing else owns.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
    let snapshot = HANDLE(snapshot.as_raw_handle());
    let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut resumed = 0;
    // SAFETY: `entry` is a THREADENTRY32 with `dwSize` set, as both calls require.
    let mut more = unsafe { Thread32First(snapshot, &mut entry) }.is_ok();
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: opening a thread by id has no memory-safety preconditions.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }?;
            // SAFETY: a fresh handle that nothing else owns.
            let thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
            // SAFETY: the thread handle is open with THREAD_SUSPEND_RESUME.
            if unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }
        // SAFETY: as for Thread32First.
        more = unsafe { Thread32Next(snapshot, &mut entry) }.is_ok();
    }
    if resumed == 0 {
        return Err(io::Error::new(io::ErrorKind::NotFound, "the new process has no thread to resume"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn wait_until(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn a_process_spawned_in_the_job_is_resumed_and_runs_to_completion() {
        let job = KillOnCloseJob::new().unwrap();
        let mut command = Command::new("cmd");
        command.args(["/d", "/c", "exit", "3"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = spawn(Some(&job), &mut command, CREATE_NO_WINDOW).unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(3), "a process left suspended would never exit");
    }

    #[test]
    fn closing_the_job_ends_the_process_and_its_children() {
        let job = KillOnCloseJob::new().unwrap();
        // cmd starting a second cmd that blocks reading the (held-open) stdin
        // pipe: a parent and a child that only end when something kills them.
        let mut command = Command::new("cmd");
        command
            .args(["/d", "/c", "cmd", "/d", "/c", "set", "/p", "line="])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = spawn(Some(&job), &mut command, CREATE_NO_WINDOW).unwrap();
        assert!(job.contains(&child));
        assert!(
            wait_until(|| job.active_processes().is_ok_and(|count| count >= 2)),
            "the grandchild inherits the job"
        );
        assert!(matches!(child.try_wait(), Ok(None)), "the tree is still running");
        drop(job);
        assert!(wait_until(|| matches!(child.try_wait(), Ok(Some(_)))), "closing the job ends the tree");
    }

    #[test]
    fn without_a_job_the_process_still_starts() {
        let mut command = Command::new("cmd");
        command.args(["/d", "/c", "exit", "0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = spawn(None, &mut command, CREATE_NO_WINDOW).unwrap();
        assert!(child.wait().unwrap().success());
    }
}
