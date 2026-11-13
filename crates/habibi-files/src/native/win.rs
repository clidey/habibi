//! Windows: `Windows.Media.Ocr` for text recognition and the Recycle Bin
//! through `IFileOperation`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use image::RgbaImage;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Win32::Foundation::E_ABORT;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, IBindCtx,
};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NO_UI, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
    IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
    SIGDN_FILESYSPATH, TSF_DELETE_RECYCLE_IF_POSSIBLE,
};
use windows_core::{HRESULT, HSTRING, PCWSTR, Ref, implement};

use super::{Invalid, Op, Recognized};

pub(super) fn recognize_text(image: &RgbaImage) -> Op<Recognized> {
    // Joining the multithreaded apartment is harmless if this worker thread
    // already belongs to one.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    // No engine means no OCR language is installed for the user.
    let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() else { return Ok(Recognized::Unavailable) };
    let limit = OcrEngine::MaxImageDimension().unwrap_or(10_000).max(1);
    let (width, height) = image.dimensions();
    let scaled = if width > limit || height > limit {
        let scale = f64::from(limit) / f64::from(width.max(height));
        let size = |side: u32| ((f64::from(side) * scale) as u32).max(1);
        image::imageops::resize(image, size(width), size(height), image::imageops::FilterType::Triangle)
    } else {
        image.clone()
    };
    let flat = super::image_ops::flatten(&scaled);
    let mut bgra = Vec::with_capacity(flat.as_raw().len() / 3 * 4);
    for pixel in flat.pixels() {
        bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(|_| Invalid)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        flat.width() as i32,
        flat.height() as i32,
        BitmapAlphaMode::Ignore,
    )
    .map_err(|_| Invalid)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(|_| Invalid)?.join().map_err(|_| Invalid)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(|_| Invalid)? {
        lines.push(line.Text().map_err(|_| Invalid)?.to_string_lossy());
    }
    Ok(Recognized::Text(lines.join("\n")))
}

/// Records where the Recycle Bin put the item, and refuses an operation the
/// shell would turn into a permanent delete (e.g. a drive with no Recycle Bin).
#[implement(IFileOperationProgressSink)]
struct Sink {
    created: Arc<Mutex<Option<PathBuf>>>,
}

impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn StartOperations(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _hrresult: HRESULT) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, flags: u32, _: Ref<IShellItem>) -> windows_core::Result<()> {
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            return Err(E_ABORT.into());
        }
        Ok(())
    }
    fn PostDeleteItem(&self, _: u32, _: Ref<IShellItem>, result: HRESULT, created: Ref<IShellItem>) -> windows_core::Result<()> {
        if result.is_ok()
            && let Some(item) = created.as_ref()
        {
            let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }?;
            let path = unsafe { name.to_string() }.ok();
            unsafe { CoTaskMemFree(Some(name.0 as *const _)) };
            *self.created.lock().unwrap_or_else(|e| e.into_inner()) = path.map(PathBuf::from);
        }
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows_core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows_core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
}

fn recycle(path: &Path) -> windows_core::Result<Option<PathBuf>> {
    let operation: IFileOperation = unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL) }?;
    unsafe { operation.SetOperationFlags(FOF_ALLOWUNDO | FOF_NO_UI | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE) }?;
    let item: IShellItem = unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None::<&IBindCtx>) }?;
    let created = Arc::new(Mutex::new(None));
    let sink: IFileOperationProgressSink = Sink { created: created.clone() }.into();
    unsafe { operation.DeleteItem(&item, &sink) }?;
    unsafe { operation.PerformOperations() }?;
    if unsafe { operation.GetAnyOperationsAborted() }?.as_bool() {
        return Ok(None);
    }
    Ok(created.lock().unwrap_or_else(|e| e.into_inner()).take())
}

/// Move to the Recycle Bin on a dedicated single-threaded apartment.
pub(super) fn trash(path: &Path) -> Op<PathBuf> {
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.ok().map_err(|_| Invalid)?;
        let result = recycle(&path);
        unsafe { CoUninitialize() };
        result.ok().flatten().filter(|resulting| resulting.is_absolute()).ok_or(Invalid)
    })
    .join()
    .map_err(|_| Invalid)?
}
