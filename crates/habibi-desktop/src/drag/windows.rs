//! The OLE file drag: the shell item's own data object, which renders
//! `CF_HDROP` and the shell ID list exactly as Explorer does, handed to
//! `SHDoDragDrop` (the shell's `DoDragDrop` wrapper that supplies the
//! default drop source and drag image).

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::IDataObject;
use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_LINK, IDropSource, OleInitialize};
use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop};
use windows::core::PCWSTR;

/// Run a modal drag of `path` from `hwnd`. Returns false when the drag could
/// not start. Call on the UI thread (an STA) while the left button is down;
/// it returns when the user drops or cancels.
pub fn drag_file(hwnd: isize, path: &Path) -> bool {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: COM calls on the calling (UI) thread; `wide` is NUL-terminated
    // and outlives the calls that read it.
    unsafe {
        // Already initialized on the webview's thread (S_FALSE) in practice.
        let _ = OleInitialize(None);
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(wide.as_ptr()), None) else {
            return false;
        };
        let Ok(data) = item.BindToHandler::<_, IDataObject>(None, &BHID_DataObject) else { return false };
        SHDoDragDrop(Some(HWND(hwnd as *mut _)), &data, None::<&IDropSource>, DROPEFFECT_COPY | DROPEFFECT_LINK).is_ok()
    }
}
