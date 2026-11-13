//! Bounded image decoding shared by explicit paste and opt-in clipboard
//! history (ported from `ClipboardImages.swift`).

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, ImageReader, Limits};

use crate::fsutil;

/// Largest PNG handed to the UI or kept in history.
pub const MAXIMUM_BYTES: usize = 8 * 1024 * 1024;
/// Largest encoded input Habibi will try to decode.
pub const MAXIMUM_INPUT_BYTES: usize = 128 * 1024 * 1024;
const MAXIMUM_SIDE: u32 = 16_384;
const MAXIMUM_PIXELS: u64 = 64_000_000;
const THUMBNAIL_SIDE: u32 = 160;
const KEPT_PASTES: usize = 20;

fn reader(data: &[u8]) -> Option<ImageReader<Cursor<&[u8]>>> {
    if data.is_empty() || data.len() > MAXIMUM_INPUT_BYTES {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(data)).with_guessed_format().ok()?;
    reader.format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAXIMUM_SIDE);
    limits.max_image_height = Some(MAXIMUM_SIDE);
    limits.max_alloc = Some(MAXIMUM_PIXELS * 4 + 64 * 1024 * 1024);
    reader.limits(limits);
    Some(reader)
}

fn within_bounds(data: &[u8]) -> Option<ImageFormat> {
    let reader = reader(data)?;
    let format = reader.format()?;
    let (width, height) = reader.into_dimensions().ok()?;
    let valid = width > 0
        && height > 0
        && width <= MAXIMUM_SIDE
        && height <= MAXIMUM_SIDE
        && u64::from(width) * u64::from(height) <= MAXIMUM_PIXELS;
    valid.then_some(format)
}

fn decode(data: &[u8]) -> Option<DynamicImage> {
    within_bounds(data)?;
    reader(data)?.decode().ok()
}

fn encode_png(image: &DynamicImage) -> Option<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, ImageFormat::Png).ok()?;
    Some(output.into_inner())
}

/// Any supported image as PNG bytes no larger than [`MAXIMUM_BYTES`].
pub fn png(data: &[u8]) -> Option<Vec<u8>> {
    let format = within_bounds(data)?;
    if format == ImageFormat::Png {
        return (data.len() <= MAXIMUM_BYTES).then(|| data.to_vec());
    }
    let result = encode_png(&decode(data)?)?;
    (result.len() <= MAXIMUM_BYTES).then_some(result)
}

/// Raw RGBA pixels (what `arboard` returns) as PNG.
pub fn rgba_png(width: usize, height: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    let (width32, height32) = (u32::try_from(width).ok()?, u32::try_from(height).ok()?);
    if width32 == 0
        || height32 == 0
        || width32 > MAXIMUM_SIDE
        || height32 > MAXIMUM_SIDE
        || u64::from(width32) * u64::from(height32) > MAXIMUM_PIXELS
        || rgba.len() != width * height * 4
    {
        return None;
    }
    let buffer = image::RgbaImage::from_raw(width32, height32, rgba.to_vec())?;
    let result = encode_png(&DynamicImage::ImageRgba8(buffer))?;
    (result.len() <= MAXIMUM_BYTES).then_some(result)
}

/// A PNG thumbnail no larger than 160 px on its longest side.
pub fn thumbnail(data: &[u8]) -> Option<Vec<u8>> {
    let image = decode(data)?;
    encode_png(&image.thumbnail(THUMBNAIL_SIDE, THUMBNAIL_SIDE))
}

/// Decode PNG bytes to RGBA (for writing an image back to the clipboard).
pub fn png_rgba(data: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    let image = decode(data)?.into_rgba8();
    Some((image.width() as usize, image.height() as usize, image.into_raw()))
}

/// Keep a pasted image for a mail attachment under
/// `state_root/.habibi/paste-images/`, retaining the newest 20.
pub fn store_paste(state_root: &Path, png: &[u8]) -> Option<PathBuf> {
    let root = state_root.join(".habibi").join("paste-images");
    let path = root.join(format!("{}.png", uuid::Uuid::new_v4().to_string().to_uppercase()));
    fsutil::write_private(&path, png).ok()?;
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|file| file.extension().and_then(|ext| ext.to_str()) == Some("png"))
        .map(|file| {
            let created = std::fs::metadata(&file)
                .and_then(|meta| meta.created().or_else(|_| meta.modified()))
                .unwrap_or(std::time::UNIX_EPOCH);
            (created, file)
        })
        .collect();
    files.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, old) in files.into_iter().skip(KEPT_PASTES) {
        if old != path {
            let _ = std::fs::remove_file(old);
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255])));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        output.into_inner()
    }

    #[test]
    fn passes_png_through_and_converts_other_formats() {
        let png_data = sample(ImageFormat::Png, 4, 4);
        assert_eq!(png(&png_data).unwrap(), png_data);
        let tiff = sample(ImageFormat::Tiff, 4, 4);
        let converted = png(&tiff).unwrap();
        assert_eq!(image::guess_format(&converted).unwrap(), ImageFormat::Png);
    }

    #[test]
    fn rejects_garbage_and_bad_rgba() {
        assert!(png(b"not an image").is_none());
        assert!(png(&[]).is_none());
        assert!(rgba_png(2, 2, &[0; 3]).is_none());
        assert!(rgba_png(1, 1, &[1, 2, 3, 4]).is_some());
    }

    #[test]
    fn thumbnails_are_small() {
        let data = sample(ImageFormat::Png, 640, 320);
        let thumb = image::load_from_memory(&thumbnail(&data).unwrap()).unwrap();
        assert!(thumb.width() <= 160 && thumb.height() <= 160);
    }

    #[test]
    fn keeps_only_the_newest_pastes() {
        let dir = tempfile::tempdir().unwrap();
        let data = sample(ImageFormat::Png, 1, 1);
        for _ in 0..23 {
            store_paste(dir.path(), &data).unwrap();
        }
        let count = std::fs::read_dir(dir.path().join(".habibi/paste-images")).unwrap().count();
        assert_eq!(count, 20);
    }
}
