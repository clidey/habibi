//! `NSPasteboard` board for macOS.

use std::path::{Path, PathBuf};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSWorkspace};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString, NSURL};

use super::{Board, Clip, image_from_files};
use crate::images;

const PREFERRED_IMAGE_TYPES: &[&str] = &[
    "public.png",
    "public.tiff",
    "public.jpeg",
    "public.heic",
    "public.heif",
    "org.webmproject.webp",
    "com.compuserve.gif",
    "com.microsoft.bmp",
];
const TEXT_TYPE: &str = "public.utf8-plain-text";
const FILE_URL_TYPE: &str = "public.file-url";

#[derive(Default)]
pub struct SystemBoard;

impl SystemBoard {
    pub fn new() -> Self {
        Self
    }
}

fn general() -> Retained<NSPasteboard> {
    NSPasteboard::generalPasteboard()
}

fn types(board: &NSPasteboard) -> Vec<String> {
    board.types().map(|types| types.iter().map(|kind| kind.to_string()).collect()).unwrap_or_default()
}

/// PNG from any image ImageIO can read: the portable decoder first, then
/// `NSBitmapImageRep` for formats it lacks (HEIC, some TIFF variants).
fn to_png(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() > images::MAXIMUM_INPUT_BYTES {
        return None;
    }
    if let Some(png) = images::png(data) {
        return Some(png);
    }
    let rep = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(data))?;
    let properties = NSDictionary::new();
    // SAFETY: an empty properties dictionary is always a valid argument.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }?.to_vec();
    // Re-run the bounds check on the converted bytes.
    images::png(&png)
}

fn pasteboard_image(board: &NSPasteboard) -> Option<Vec<u8>> {
    let advertised = types(board);
    let extra: Vec<String> = advertised
        .iter()
        .filter(|kind| !PREFERRED_IMAGE_TYPES.contains(&kind.as_str()) && kind.to_lowercase().contains("image"))
        .cloned()
        .collect();
    for kind in PREFERRED_IMAGE_TYPES.iter().map(|kind| kind.to_string()).chain(extra) {
        if !advertised.contains(&kind) {
            continue;
        }
        if let Some(data) = board.dataForType(&NSString::from_str(&kind))
            && let Some(png) = to_png(&data.to_vec())
        {
            return Some(png);
        }
    }
    None
}

fn file_urls(board: &NSPasteboard) -> Vec<PathBuf> {
    let Some(items) = board.pasteboardItems() else { return Vec::new() };
    let kind = NSString::from_str(FILE_URL_TYPE);
    items
        .iter()
        .filter_map(|item| item.stringForType(&kind))
        .filter_map(|value| NSURL::URLWithString(&value))
        .filter(|url| url.isFileURL())
        .filter_map(|url| url.path())
        .map(|path| PathBuf::from(path.to_string()))
        .filter(|path| !path.is_dir())
        .collect()
}

/// Some apps place a screenshot on the pasteboard in a representation
/// WebKit and NSImage do not advertise. Ask the pasteboard service for a real
/// PNG with the same `«class PNGf»` coercion the Swift app used, writing to a
/// private temporary file that is removed straight away.
fn png_using_applescript() -> Option<Vec<u8>> {
    let output = std::env::temp_dir().join(format!("habibi-paste-{}.png", uuid::Uuid::new_v4().to_string().to_uppercase()));
    let path = output.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let status = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "set d to the clipboard as «class PNGf»",
            "-e",
            &format!("set f to open for access POSIX file \"{path}\" with write permission"),
            "-e",
            "write d to f",
            "-e",
            "close access f",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok();
    let data = std::fs::read(&output).ok();
    let _ = std::fs::remove_file(&output);
    if !status.map(|status| status.success()).unwrap_or(false) {
        return None;
    }
    data.filter(|data| !data.is_empty()).and_then(|data| images::png(&data))
}

impl Board for SystemBoard {
    fn change_marker(&mut self) -> Option<i64> {
        Some(general().changeCount() as i64)
    }

    fn read(&mut self) -> Clip {
        autoreleasepool(|_| {
            let board = general();
            let mut clip = Clip { types: types(&board), ..Clip::default() };
            clip.files = file_urls(&board);
            if clip.files.is_empty() {
                clip.image = pasteboard_image(&board);
                if clip.image.is_none() {
                    clip.text = board.stringForType(&NSString::from_str(TEXT_TYPE)).map(|text| text.to_string());
                }
            }
            clip
        })
    }

    fn frontmost_app(&mut self) -> (String, Option<String>) {
        autoreleasepool(|_| {
            let app = NSWorkspace::sharedWorkspace().frontmostApplication();
            let bundle = app.as_ref().and_then(|app| app.bundleIdentifier()).map(|id| id.to_string()).unwrap_or_default();
            let name = app.as_ref().and_then(|app| app.localizedName()).map(|name| name.to_string());
            (bundle, name)
        })
    }

    fn write_text(&mut self, text: &str) -> bool {
        autoreleasepool(|_| {
            let board = general();
            board.clearContents();
            board.setString_forType(&NSString::from_str(text), &NSString::from_str(TEXT_TYPE))
        })
    }

    fn write_png(&mut self, png: &[u8]) -> bool {
        autoreleasepool(|_| {
            let board = general();
            board.clearContents();
            board.setData_forType(Some(&NSData::with_bytes(png)), &NSString::from_str("public.png"))
        })
    }

    fn write_file(&mut self, path: &Path) -> bool {
        autoreleasepool(|_| {
            let board = general();
            board.clearContents();
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let objects = NSArray::from_retained_slice(&[ProtocolObject::from_retained(url)]);
            board.writeObjects(&objects)
        })
    }

    fn image_png(&mut self) -> Option<Vec<u8>> {
        let direct = autoreleasepool(|_| pasteboard_image(&general()));
        if direct.is_some() {
            return direct;
        }
        if let Some(png) = png_using_applescript() {
            return Some(png);
        }
        let files = autoreleasepool(|_| file_urls(&general()));
        image_from_files(&files)
    }

    fn has_image(&mut self) -> bool {
        autoreleasepool(|_| {
            types(&general()).iter().any(|kind| {
                let lower = kind.to_lowercase();
                PREFERRED_IMAGE_TYPES.contains(&kind.as_str()) || lower.contains("image")
            })
        })
    }
}
