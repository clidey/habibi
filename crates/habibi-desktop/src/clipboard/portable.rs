//! Clipboard board for Windows and Linux, built on `arboard`.
//!
//! Windows exposes a clipboard sequence number and the "exclude from
//! monitoring" formats password managers set; Linux has neither, so the
//! history compares content there and only the app-name filter applies.

use std::path::Path;

use super::{Board, Clip, image_from_files};
use crate::images;

pub struct SystemBoard {
    clipboard: Option<arboard::Clipboard>,
}

impl Default for SystemBoard {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemBoard {
    pub fn new() -> Self {
        Self { clipboard: arboard::Clipboard::new().ok() }
    }

    fn clipboard(&mut self) -> Option<&mut arboard::Clipboard> {
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().ok();
        }
        self.clipboard.as_mut()
    }

    fn image(&mut self) -> Option<Vec<u8>> {
        let image = self.clipboard()?.get_image().ok()?;
        images::rgba_png(image.width, image.height, &image.bytes)
    }
}

impl Board for SystemBoard {
    fn change_marker(&mut self) -> Option<i64> {
        #[cfg(target_os = "windows")]
        {
            // SAFETY: GetClipboardSequenceNumber has no preconditions.
            Some(i64::from(unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }))
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    fn read(&mut self) -> Clip {
        let mut clip = Clip { types: excluded_formats(), ..Clip::default() };
        if let Some(clipboard) = self.clipboard() {
            clip.files = clipboard.get().file_list().unwrap_or_default().into_iter().filter(|path| !path.is_dir()).collect();
        }
        if clip.files.is_empty() {
            clip.text = self.clipboard().and_then(|clipboard| clipboard.get_text().ok());
            if clip.text.as_deref().map(str::trim).unwrap_or("").is_empty() {
                clip.text = None;
                clip.image = self.image();
            }
        }
        clip
    }

    fn frontmost_app(&mut self) -> (String, Option<String>) {
        foreground_app()
    }

    fn write_text(&mut self, text: &str) -> bool {
        self.clipboard().map(|clipboard| clipboard.set_text(text.to_string()).is_ok()).unwrap_or(false)
    }

    fn write_png(&mut self, png: &[u8]) -> bool {
        let Some((width, height, rgba)) = images::png_rgba(png) else { return false };
        self.clipboard()
            .map(|clipboard| clipboard.set_image(arboard::ImageData { width, height, bytes: rgba.into() }).is_ok())
            .unwrap_or(false)
    }

    fn write_file(&mut self, path: &Path) -> bool {
        self.clipboard().map(|clipboard| clipboard.set().file_list(&[path]).is_ok()).unwrap_or(false)
    }

    fn image_png(&mut self) -> Option<Vec<u8>> {
        if let Some(png) = self.image() {
            return Some(png);
        }
        let files = self.clipboard()?.get().file_list().ok()?;
        image_from_files(&files)
    }

    fn has_image(&mut self) -> bool {
        self.image().is_some()
    }
}

#[cfg(target_os = "windows")]
fn excluded_formats() -> Vec<String> {
    use windows::Win32::System::DataExchange::{IsClipboardFormatAvailable, RegisterClipboardFormatW};
    use windows::core::HSTRING;
    let mut found = Vec::new();
    for name in ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"] {
        // SAFETY: both calls take a valid, NUL-terminated format name / id.
        let available = unsafe {
            let format = RegisterClipboardFormatW(&HSTRING::from(name));
            format != 0 && IsClipboardFormatAvailable(format).is_ok()
        };
        if available {
            found.push(name.to_string());
        }
    }
    found
}

#[cfg(not(target_os = "windows"))]
fn excluded_formats() -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn foreground_app() -> (String, Option<String>) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    use windows::core::PWSTR;
    // SAFETY: plain Win32 queries on handles we open and close here.
    unsafe {
        let window = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == 0 {
            return (String::new(), None);
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return (String::new(), None);
        };
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let ok =
            QueryFullProcessImageNameW(process, PROCESS_NAME_FORMAT(0), PWSTR(buffer.as_mut_ptr()), &mut length).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return (String::new(), None);
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        let name = Path::new(&path).file_stem().and_then(|stem| stem.to_str()).map(str::to_string);
        (path, name)
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_app() -> (String, Option<String>) {
    (String::new(), None)
}
