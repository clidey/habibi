//! Image resize / convert / re-encode (the helper's `image` action).

use std::io::Cursor;
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder, ImageReader, RgbImage, RgbaImage};
use serde_json::{Map, Value, json};

use super::{Invalid, Op, check_pixels, extension, input_path, output_path};
use crate::util::{js_integer, write_new};

/// Width and height from the header only, before anything is decoded.
pub(crate) fn dimensions(path: &Path) -> Op<(u64, u64)> {
    let (width, height) = ImageReader::open(path)?.with_guessed_format()?.into_dimensions()?;
    let (width, height) = (u64::from(width), u64::from(height));
    check_pixels(width, height)?;
    Ok((width, height))
}

fn decode_portable(path: &Path) -> Op<RgbaImage> {
    dimensions(path)?;
    Ok(ImageReader::open(path)?.with_guessed_format()?.decode()?.to_rgba8())
}

/// Decode JPEG, PNG, TIFF, GIF, BMP or WebP everywhere; on macOS anything
/// else ImageIO reads (HEIC in particular) as the Swift helper did.
pub(crate) fn decode_rgba(path: &Path) -> Op<RgbaImage> {
    match decode_portable(path) {
        Ok(image) => Ok(image),
        #[cfg(target_os = "macos")]
        Err(Invalid) => super::macos::decode_rgba(path),
        #[cfg(not(target_os = "macos"))]
        Err(error) => Err(error),
    }
}

/// JPEG has no alpha; transparent areas become white rather than black.
pub(crate) fn flatten(image: &RgbaImage) -> RgbImage {
    RgbImage::from_fn(image.width(), image.height(), |x, y| {
        let [r, g, b, a] = image.get_pixel(x, y).0;
        let blend = |c: u8| ((u32::from(c) * u32::from(a) + 255 * (255 - u32::from(a))) / 255) as u8;
        image::Rgb([blend(r), blend(g), blend(b)])
    })
}

pub(crate) fn encode_jpeg(image: &RgbImage, quality: u8) -> Op<Vec<u8>> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

fn encode_png(image: &RgbaImage) -> Op<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    PngEncoder::new(&mut out).write_image(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgba8)?;
    Ok(out.into_inner())
}

pub(crate) fn convert(request: &Value) -> Op<Map<String, Value>> {
    let Some(Value::Array(sources)) = request.get("sources") else { return Err(Invalid) };
    if sources.len() != 1 {
        return Err(Invalid);
    }
    let source = decode_rgba(&input_path(sources.first())?)?;
    let output = output_path(request.get("destination"))?;
    let (source_width, source_height) = (i64::from(source.width()), i64::from(source.height()));
    let requested = request.get("width").and_then(js_integer).unwrap_or(source_width);
    let width = source_width.min(requested.clamp(100, 6000));
    let height = ((source_height as f64 * width as f64 / source_width as f64) as i64).max(1);
    check_pixels(width as u64, height as u64)?;
    let (width, height) = (width as u32, height as u32);
    let scaled = if (width, height) == (source.width(), source.height()) {
        source
    } else {
        image::imageops::resize(&source, width, height, FilterType::CatmullRom)
    };
    let png = extension(&output) == "png";
    let mut quality = request.get("quality").and_then(js_integer).unwrap_or(75).clamp(10, 95);
    let target = request.get("targetBytes").and_then(js_integer);
    let flat = (!png).then(|| flatten(&scaled));
    // Step quality down by 10 until the target is met or quality reaches 15.
    let encoded = loop {
        let encoded = match &flat {
            Some(flat) => encode_jpeg(flat, quality as u8)?,
            None => encode_png(&scaled)?,
        };
        if png || target.is_none_or(|target| encoded.len() as i64 <= target) || quality <= 15 {
            break encoded;
        }
        quality -= 10;
    };
    write_new(&output, &encoded, false)?;
    let mut result = Map::new();
    result.insert("bytes".into(), json!(encoded.len()));
    Ok(result)
}
