//! The local converter the Swift `HabibiFileTools` helper used to be, now
//! in-process. Same JSON contract per action:
//!
//! - `{ action: "inspect", path }` → `{ ok, pages?, text, width?, height? }`
//! - `{ action: "image", sources: [path], destination, width?, quality?, targetBytes? }` → `{ ok, bytes }`
//! - `{ action: "pdf", sources, destination, pages?: [{ path, page, rotate? }], quality? }` → `{ ok, pages, bytes }`
//! - `{ action: "trash", path }` → `{ ok, path }` (where the item now is)
//!
//! It never accepts shell commands or contacts a provider; the service has
//! already checked selected-path access and approvals. Every bound the Swift
//! helper enforced is kept: 128 KB request, 200 MB inputs and PDF output,
//! 64 megapixel images, 500 PDF pages, 12 inspected pages of 1,500
//! characters, 12,000 characters of text.

mod image_ops;
mod pdf;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(unix, not(target_os = "macos")))]
mod unix;
#[cfg(windows)]
mod win;

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::error::{FileError, FileResult, PROCESS_ERROR};

/// Runs one helper action. The real implementation is [`LocalNativeTools`];
/// tests substitute a fake, as the Node tests did.
pub trait NativeFileTools: Send + Sync {
    fn run(&self, request: &Value) -> FileResult<Value>;
}

/// The in-process PDF, image, OCR and Trash implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct LocalNativeTools;

impl NativeFileTools for LocalNativeTools {
    fn run(&self, request: &Value) -> FileResult<Value> {
        run_local(request)
    }
}

/// Any failure inside an action. Like the helper's `{"ok":false}`, it says
/// nothing about why.
#[derive(Debug)]
pub(crate) struct Invalid;

impl<E: std::error::Error> From<E> for Invalid {
    fn from(_: E) -> Self {
        Invalid
    }
}

pub(crate) type Op<T> = Result<T, Invalid>;

const MAX_REQUEST: usize = 128_000;
const MAX_INPUT: u64 = 200 * 1024 * 1024;
pub(crate) const MAX_PIXELS: u64 = 64_000_000;
pub(crate) const MAX_TEXT: usize = 12_000;
/// `execFile(..., { timeout: 90_000 })` on the old helper.
const TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) const OCR_UNAVAILABLE: &str = "[Text recognition is not available on this computer]";

pub fn run_local(request: &Value) -> FileResult<Value> {
    let too_large = serde_json::to_vec(request).map(|bytes| bytes.len() > MAX_REQUEST).unwrap_or(true);
    let action = request.get("action").and_then(Value::as_str).unwrap_or("");
    let result = if too_large {
        Err(Invalid)
    } else {
        match action {
            // Not run under the timeout: a Trash move that finished after we
            // reported failure would leave a file in the Trash with no undo record.
            "trash" => trash(request),
            "inspect" | "image" | "pdf" => {
                let request = request.clone();
                with_timeout(move || match request.get("action").and_then(Value::as_str) {
                    Some("inspect") => inspect(&request),
                    Some("image") => image_ops::convert(&request),
                    _ => pdf::build(&request),
                })
            }
            _ => Err(Invalid),
        }
    };
    match result {
        Ok(mut map) => {
            map.insert("ok".into(), Value::Bool(true));
            Ok(Value::Object(map))
        }
        Err(Invalid) => Err(FileError::user(PROCESS_ERROR)),
    }
}

/// Run on a worker thread so a pathological file cannot hold the request
/// forever. A panic in a decoder also lands here as a failure.
fn with_timeout(work: impl FnOnce() -> Op<Map<String, Value>> + Send + 'static) -> Op<Map<String, Value>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("habibi-file-tools".into())
        .spawn(move || {
            let _ = sender.send(work());
        })
        .map_err(|_| Invalid)?;
    receiver.recv_timeout(TIMEOUT).map_err(|_| Invalid)?
}

/// An existing regular file (not a link), absolute, at most 200 MB.
pub(crate) fn input_path(value: Option<&Value>) -> Op<PathBuf> {
    let Some(Value::String(value)) = value else { return Err(Invalid) };
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.contains('\0') {
        return Err(Invalid);
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_INPUT {
        return Err(Invalid);
    }
    Ok(path)
}

/// An absolute path that does not exist yet; outputs are written with
/// exclusive create so nothing is overwritten.
pub(crate) fn output_path(value: Option<&Value>) -> Op<PathBuf> {
    let Some(Value::String(value)) = value else { return Err(Invalid) };
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.contains('\0') || crate::util::exists_no_follow(&path) {
        return Err(Invalid);
    }
    Ok(path)
}

pub(crate) fn check_pixels(width: u64, height: u64) -> Op<()> {
    if width == 0 || height == 0 || width.saturating_mul(height) > MAX_PIXELS {
        return Err(Invalid);
    }
    Ok(())
}

pub(crate) fn extension(path: &Path) -> String {
    path.extension().map(|ext| ext.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// What OCR produced on this platform.
pub(crate) enum Recognized {
    Text(String),
    /// Vision always exists on macOS; other systems may lack an OCR engine.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unavailable,
}

fn inspect(request: &Value) -> Op<Map<String, Value>> {
    let file = input_path(request.get("path"))?;
    if extension(&file) == "pdf" {
        return pdf::inspect(&file);
    }
    let (recognized, width, height) = recognize(&file)?;
    let mut result = Map::new();
    match recognized {
        Recognized::Text(text) => {
            result.insert("text".into(), json!(crate::util::prefix_chars(&text, MAX_TEXT)));
        }
        Recognized::Unavailable => {
            result.insert("text".into(), json!(OCR_UNAVAILABLE));
            result.insert("ocrAvailable".into(), json!(false));
        }
    }
    result.insert("width".into(), json!(width));
    result.insert("height".into(), json!(height));
    Ok(result)
}

/// Vision on macOS.
#[cfg(target_os = "macos")]
fn recognize(file: &Path) -> Op<(Recognized, u64, u64)> {
    let image = macos::load_image(file)?;
    let (width, height) = macos::dimensions(&image);
    Ok((Recognized::Text(macos::recognize_text(&image)?), width, height))
}

/// `Windows.Media.Ocr` with the user's profile languages.
#[cfg(windows)]
fn recognize(file: &Path) -> Op<(Recognized, u64, u64)> {
    let image = image_ops::decode_rgba(file)?;
    let (width, height) = (u64::from(image.width()), u64::from(image.height()));
    Ok((win::recognize_text(&image)?, width, height))
}

/// The `tesseract` CLI when it is installed.
#[cfg(all(unix, not(target_os = "macos")))]
fn recognize(file: &Path) -> Op<(Recognized, u64, u64)> {
    let (width, height) = image_ops::dimensions(file)?;
    Ok((unix::recognize_text(file)?, width, height))
}

fn trash(request: &Value) -> Op<Map<String, Value>> {
    let file = input_path(request.get("path"))?;
    #[cfg(target_os = "macos")]
    let resulting = macos::trash(&file)?;
    #[cfg(windows)]
    let resulting = win::trash(&file)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let resulting = unix::trash(&file)?;
    let mut result = Map::new();
    result.insert("path".into(), json!(resulting.to_str().ok_or(Invalid)?));
    Ok(result)
}

/// Called after an undo moved a trashed file back. The freedesktop Trash
/// keeps a `.trashinfo` record per item that would otherwise be orphaned;
/// macOS and Windows clean up their own bookkeeping.
pub(crate) fn restored_from_trash(trashed: &Path) {
    #[cfg(all(unix, not(target_os = "macos")))]
    unix::forget(trashed);
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    let _ = trashed;
}

#[cfg(test)]
mod tests;
