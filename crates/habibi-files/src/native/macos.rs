//! macOS: ImageIO decoding (HEIC and everything else the old helper read),
//! Vision text recognition, and the Finder Trash.

use std::path::{Path, PathBuf};

use image::RgbaImage;
use objc2::AllocAnyThread;
use objc2::rc::{Retained, autoreleasepool};
use objc2_core_foundation::{CFRetained, CFURL, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
};
use objc2_foundation::{NSArray, NSDictionary, NSFileManager, NSURL};
use objc2_image_io::CGImageSource;
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

use super::{Invalid, Op, check_pixels};

/// The first image in a file, refused before decoding if it is over the
/// pixel bound. (`CGImageSourceCreateImageAtIndex` decodes lazily.)
pub(super) fn load_image(path: &Path) -> Op<CFRetained<CGImage>> {
    let url = CFURL::from_file_path(path).ok_or(Invalid)?;
    let source = unsafe { CGImageSource::with_url(&url, None) }.ok_or(Invalid)?;
    let image = unsafe { source.image_at_index(0, None) }.ok_or(Invalid)?;
    let (width, height) = dimensions(&image);
    check_pixels(width, height)?;
    Ok(image)
}

pub(super) fn dimensions(image: &CGImage) -> (u64, u64) {
    (CGImage::width(Some(image)) as u64, CGImage::height(Some(image)) as u64)
}

/// Decode through ImageIO into straight RGBA.
pub(super) fn decode_rgba(path: &Path) -> Op<RgbaImage> {
    let image = load_image(path)?;
    let (width, height) = dimensions(&image);
    let (width, height) = (width as usize, height as usize);
    let mut buffer = vec![0u8; width * height * 4];
    let space = CGColorSpace::new_device_rgb().ok_or(Invalid)?;
    {
        // SAFETY: `buffer` is exactly `height * width * 4` bytes and outlives
        // the context, which is dropped at the end of this block.
        let context = unsafe {
            CGBitmapContextCreate(
                buffer.as_mut_ptr().cast(),
                width,
                height,
                8,
                width * 4,
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0,
            )
        }
        .ok_or(Invalid)?;
        let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width as f64, height as f64));
        CGContext::draw_image(Some(&context), rect, Some(&image));
    }
    for pixel in buffer.as_chunks_mut::<4>().0 {
        let alpha = u32::from(pixel[3]);
        if alpha > 0 && alpha < 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
    RgbaImage::from_raw(width as u32, height as u32, buffer).ok_or(Invalid)
}

/// Redraw onto opaque white 8-bit RGBX. Vision's reader rejects some
/// layouts ImageIO produces (24-bit RGB PNGs, for one), and transparent
/// areas would otherwise read as black.
fn normalized(image: &CGImage) -> Op<CFRetained<CGImage>> {
    let (width, height) = dimensions(image);
    let (width, height) = (width as usize, height as usize);
    let space = CGColorSpace::new_device_rgb().ok_or(Invalid)?;
    // SAFETY: a null data pointer lets CoreGraphics own the bitmap memory.
    let context = unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::NoneSkipLast.0,
        )
    }
    .ok_or(Invalid)?;
    let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width as f64, height as f64));
    CGContext::set_rgb_fill_color(Some(&context), 1.0, 1.0, 1.0, 1.0);
    CGContext::fill_rect(Some(&context), rect);
    CGContext::draw_image(Some(&context), rect, Some(image));
    CGBitmapContextCreateImage(Some(&context)).ok_or(Invalid)
}

/// `VNRecognizeTextRequest` at the accurate level, one line per observation.
pub(super) fn recognize_text(image: &CGImage) -> Op<String> {
    let image = normalized(image)?;
    let image: &CGImage = &image;
    autoreleasepool(|_| {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        let options = NSDictionary::new();
        // SAFETY: an empty options dictionary is valid for any key/value type.
        let handler =
            unsafe { VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), image, &options) };
        let base: &VNRequest = &request;
        let requests = NSArray::from_slice(&[base]);
        handler.performRequests_error(&requests).map_err(|_| Invalid)?;
        let mut lines = Vec::new();
        if let Some(results) = request.results() {
            for observation in results.iter() {
                if let Some(candidate) = observation.topCandidates(1).firstObject() {
                    lines.push(candidate.string().to_string());
                }
            }
        }
        Ok(lines.join("\n"))
    })
}

/// `FileManager.trashItem(at:resultingItemURL:)`.
pub(super) fn trash(path: &Path) -> Op<PathBuf> {
    autoreleasepool(|_| {
        let url = NSURL::from_file_path(path).ok_or(Invalid)?;
        let manager = NSFileManager::defaultManager();
        let mut resulting: Option<Retained<NSURL>> = None;
        manager.trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting)).map_err(|_| Invalid)?;
        resulting.and_then(|url| url.to_file_path()).ok_or(Invalid)
    })
}
