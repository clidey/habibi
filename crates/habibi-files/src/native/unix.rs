//! Linux and other freedesktop systems: OCR through the `tesseract` CLI when
//! it is installed, and the freedesktop.org Trash specification.

use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{Invalid, Op, Recognized};
use crate::util::{private_directory, write_new};

const OCR_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OCR_OUTPUT: u64 = 1024 * 1024;

fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/usr/bin", "/usr/local/bin"].map(PathBuf::from))
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// `tesseract <file> stdout`. The input is an absolute path, so it can never
/// be read as an option.
pub(super) fn recognize_text(file: &Path) -> Op<Recognized> {
    let Some(program) = find_program("tesseract") else { return Ok(Recognized::Unavailable) };
    let mut child = Command::new(program)
        .arg(file)
        .arg("stdout")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().ok_or(Invalid)?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = (&mut stdout).take(MAX_OCR_OUTPUT).read_to_end(&mut output);
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        output
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > OCR_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Invalid);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = reader.join().map_err(|_| Invalid)?;
    if !status.success() {
        return Err(Invalid);
    }
    Ok(Recognized::Text(String::from_utf8_lossy(&output).trim().to_string()))
}

fn data_home() -> Op<PathBuf> {
    if let Some(data) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|path| path.is_absolute()) {
        return Ok(data);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).filter(|path| path.is_absolute()).ok_or(Invalid)?;
    Ok(home.join(".local/share"))
}

/// Percent-encode a path for `Path=` in a `.trashinfo` file.
fn encode_path(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut out = String::new();
    for &byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The trash directory for `file`: the home trash when it is on the same
/// device, else `$topdir/.Trash-$uid` on the file's own mount. Never falls
/// back to deleting.
fn trash_directory(file: &Path, device: u64, data_home: &Path) -> Op<PathBuf> {
    let home_trash = data_home.join("Trash");
    fs::create_dir_all(&home_trash)?;
    if fs::metadata(&home_trash)?.dev() == device {
        return Ok(home_trash);
    }
    let mut top = file.parent().ok_or(Invalid)?.to_path_buf();
    while let Some(parent) = top.parent() {
        if fs::metadata(parent)?.dev() != device {
            break;
        }
        top = parent.to_path_buf();
    }
    let uid = fs::metadata("/proc/self").map(|meta| meta.uid()).map_err(|_| Invalid)?;
    let directory = top.join(format!(".Trash-{uid}"));
    if let Ok(meta) = fs::symlink_metadata(&directory)
        && (meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != uid)
    {
        return Err(Invalid);
    }
    Ok(directory)
}

pub(super) fn trash(file: &Path) -> Op<PathBuf> {
    trash_into(file, &data_home()?)
}

pub(super) fn trash_into(file: &Path, data_home: &Path) -> Op<PathBuf> {
    let metadata = fs::symlink_metadata(file)?;
    let directory = trash_directory(file, metadata.dev(), data_home)?;
    let files = directory.join("files");
    let info = directory.join("info");
    private_directory(&directory)?;
    private_directory(&files)?;
    private_directory(&info)?;
    let name = file.file_name().ok_or(Invalid)?.to_string_lossy().into_owned();
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name.as_str(), ""),
    };
    let deleted = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S");
    let record = format!("[Trash Info]\nPath={}\nDeletionDate={deleted}\n", encode_path(file));
    for attempt in 1..1000 {
        let candidate = if attempt == 1 { name.clone() } else { format!("{stem}.{attempt}{extension}") };
        let info_file = info.join(format!("{candidate}.trashinfo"));
        // The exclusive create of the info file reserves the name.
        match write_new(&info_file, record.as_bytes(), true) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(Invalid),
        }
        let target = files.join(&candidate);
        if crate::util::exists_no_follow(&target) {
            let _ = fs::remove_file(&info_file);
            continue;
        }
        if fs::rename(file, &target).is_err() {
            let _ = fs::remove_file(&info_file);
            return Err(Invalid);
        }
        return Ok(target);
    }
    Err(Invalid)
}

/// Remove the `.trashinfo` of an item that was moved back out of the Trash.
pub(super) fn forget(trashed: &Path) {
    let Some(files) = trashed.parent() else { return };
    if files.file_name() != Some(OsStr::new("files")) {
        return;
    }
    let (Some(directory), Some(name)) = (files.parent(), trashed.file_name()) else { return };
    let mut record = name.to_os_string();
    record.push(".trashinfo");
    let _ = fs::remove_file(directory.join("info").join(record));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trash_follows_the_freedesktop_layout_and_undo_forgets_the_record() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let file = root.path().join("note 1.txt");
        fs::write(&file, "fictional").unwrap();
        let trashed = trash_into(&file, &data).unwrap();
        assert_eq!(trashed, data.join("Trash/files/note 1.txt"));
        let info = fs::read_to_string(data.join("Trash/info/note 1.txt.trashinfo")).unwrap();
        assert!(info.contains("Path=") && info.contains("note%201.txt"));
        fs::write(&file, "again").unwrap();
        assert_eq!(trash_into(&file, &data).unwrap(), data.join("Trash/files/note 1.2.txt"));
        forget(&trashed);
        assert!(!data.join("Trash/info/note 1.txt.trashinfo").exists());
    }
}
