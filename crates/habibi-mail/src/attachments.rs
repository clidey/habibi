//! Files attached to an outgoing email. Ported from
//! `src/server/services/mail-attachments.ts`.

use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::js;

pub const MAX_ATTACHMENTS: usize = 5;
pub const MAX_ATTACHMENT_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub filename: String,
    pub content: Vec<u8>,
}

/// Why an attachment list was refused. The route shows one fixed message for
/// all of these; the variants exist for tests.
#[derive(Debug, PartialEq)]
pub enum AttachmentError {
    TooMany,
    Invalid,
    OutsideHome,
    TooLarge,
    Changed,
    Unreadable,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && js::length(name) <= 200 && !name.contains(['\r', '\n', '\0', '/', '\\'])
}

/// The file at `target`, opened without following a final symlink.
fn open_regular(target: &Path) -> Result<std::fs::File, AttachmentError> {
    let link = std::fs::symlink_metadata(target).map_err(|_| AttachmentError::Unreadable)?;
    if link.file_type().is_symlink() {
        return Err(AttachmentError::Unreadable);
    }
    let file = std::fs::File::open(target).map_err(|_| AttachmentError::Unreadable)?;
    // `O_NOFOLLOW` in the Node version: make sure the file opened is the one
    // checked above, not something swapped in through a symlink meanwhile.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata().map_err(|_| AttachmentError::Unreadable)?;
        if opened.dev() != link.dev() || opened.ino() != link.ino() {
            return Err(AttachmentError::Changed);
        }
    }
    Ok(file)
}

/// Resolve and snapshot explicitly attached files, only after the send
/// approval was consumed. `None` (no `attachments` key) is an empty list.
pub fn read_mail_attachments(value: Option<&Value>, home: &Path) -> Result<Vec<Attachment>, AttachmentError> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let Value::Array(items) = value else { return Err(AttachmentError::TooMany) };
    if items.len() > MAX_ATTACHMENTS || home.as_os_str().is_empty() {
        return Err(AttachmentError::TooMany);
    }
    let base = std::fs::canonicalize(home).map_err(|_| AttachmentError::OutsideHome)?;
    let mut total = 0u64;
    let mut result = Vec::new();
    for item in items {
        let (Some(Value::String(path)), Some(Value::String(name))) = (item.get("path"), item.get("name")) else {
            return Err(AttachmentError::Invalid);
        };
        if !Path::new(path).is_absolute() || !valid_name(name) {
            return Err(AttachmentError::Invalid);
        }
        let target = std::fs::canonicalize(path).map_err(|_| AttachmentError::Unreadable)?;
        if target == base || !target.starts_with(&base) {
            return Err(AttachmentError::OutsideHome);
        }
        let mut file = open_regular(&target)?;
        let metadata = file.metadata().map_err(|_| AttachmentError::Unreadable)?;
        let size = metadata.len();
        total += size;
        if !metadata.is_file() || size > MAX_ATTACHMENT_BYTES || total > MAX_TOTAL_BYTES {
            return Err(AttachmentError::TooLarge);
        }
        let mut content = Vec::with_capacity(size as usize);
        (&mut file).take(size + 1).read_to_end(&mut content).map_err(|_| AttachmentError::Unreadable)?;
        let after = file.metadata().map_err(|_| AttachmentError::Unreadable)?.len();
        if content.len() as u64 != size || after != size {
            return Err(AttachmentError::Changed);
        }
        result.push(Attachment { filename: name.clone(), content });
    }
    Ok(result)
}

/// The MIME type nodemailer would have picked from the file name.
pub fn content_type(filename: &str) -> &'static str {
    let extension = filename.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "pdf" => "application/pdf",
        "txt" | "text" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ics" => "text/calendar",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn missing_attachments_are_an_empty_list() {
        let home = home();
        assert_eq!(read_mail_attachments(None, home.path()), Ok(vec![]));
    }

    #[test]
    fn reads_files_inside_home_with_the_given_names() {
        let home = home();
        let file = home.path().join("plan.txt");
        std::fs::write(&file, b"hello").unwrap();
        let list = json!([{ "path": file.to_string_lossy(), "name": "plan.txt" }]);
        let files = read_mail_attachments(Some(&list), home.path()).unwrap();
        assert_eq!(files, vec![Attachment { filename: "plan.txt".into(), content: b"hello".to_vec() }]);
    }

    #[test]
    fn refuses_files_outside_home_bad_names_and_too_many() {
        let home = home();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let list = json!([{ "path": outside.path().to_string_lossy(), "name": "x.txt" }]);
        assert_eq!(read_mail_attachments(Some(&list), home.path()), Err(AttachmentError::OutsideHome));

        let file = home.path().join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        for name in ["", "a/b", "a\\b", "a\nb", &"x".repeat(201)] {
            let list = json!([{ "path": file.to_string_lossy(), "name": name }]);
            assert_eq!(read_mail_attachments(Some(&list), home.path()), Err(AttachmentError::Invalid), "{name:?}");
        }
        let relative = json!([{ "path": "a.txt", "name": "a.txt" }]);
        assert_eq!(read_mail_attachments(Some(&relative), home.path()), Err(AttachmentError::Invalid));
        let six: Vec<_> = (0..6).map(|_| json!({ "path": file.to_string_lossy(), "name": "a.txt" })).collect();
        assert_eq!(read_mail_attachments(Some(&json!(six)), home.path()), Err(AttachmentError::TooMany));
        assert_eq!(read_mail_attachments(Some(&json!("x")), home.path()), Err(AttachmentError::TooMany));
    }

    #[test]
    fn enforces_size_limits_and_regular_files() {
        let home = home();
        let big = home.path().join("big.bin");
        std::fs::File::create(&big).unwrap().set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        let list = json!([{ "path": big.to_string_lossy(), "name": "big.bin" }]);
        assert_eq!(read_mail_attachments(Some(&list), home.path()), Err(AttachmentError::TooLarge));

        let parts: Vec<_> = (0..3)
            .map(|index| {
                let path = home.path().join(format!("p{index}.bin"));
                std::fs::File::create(&path).unwrap().set_len(7 * 1024 * 1024).unwrap();
                json!({ "path": path.to_string_lossy(), "name": format!("p{index}.bin") })
            })
            .collect();
        assert_eq!(read_mail_attachments(Some(&json!(parts)), home.path()), Err(AttachmentError::TooLarge));

        let folder = home.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        let list = json!([{ "path": folder.to_string_lossy(), "name": "folder" }]);
        assert!(read_mail_attachments(Some(&list), home.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_home_is_refused() {
        let home = home();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let link = home.path().join("link.txt");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let list = json!([{ "path": link.to_string_lossy(), "name": "link.txt" }]);
        assert_eq!(read_mail_attachments(Some(&list), home.path()), Err(AttachmentError::OutsideHome));
    }
}
