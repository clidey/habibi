//! PDF page count, text, and page assembly (the helper's `inspect` for PDFs
//! and its `pdf` action). Parsing and writing use lopdf; the optional
//! compressed copy rasterizes pages with hayro, both pure Rust.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use serde_json::{Map, Value, json};

use super::{Invalid, MAX_TEXT, Op, extension, input_path, output_path};
use crate::util::{js_integer, prefix_chars, write_new};

const MAX_PAGES: usize = 500;
const MAX_OUTPUT: usize = 200 * 1024 * 1024;
const INSPECTED_PAGES: usize = 12;
const PAGE_TEXT: usize = 1500;
/// 120 dpi, as `thumbnail(of: rect * 1.67)` was.
const RASTER_SCALE: f32 = 1.67;
const MAX_PAGE_SIDE: f32 = 4000.0;

/// Open a PDF; refuse one that needs a password (`isLocked`) or has more
/// than 500 pages.
fn load(path: &Path) -> Op<Document> {
    let document = Document::load(path)?;
    let locked = document.trailer.has(b"Encrypt") && !document.was_encrypted();
    if locked || document.get_pages().len() > MAX_PAGES {
        return Err(Invalid);
    }
    Ok(document)
}

pub(crate) fn inspect(path: &Path) -> Op<Map<String, Value>> {
    let document = load(path)?;
    let pages = document.get_pages();
    let text = pages
        .keys()
        .take(INSPECTED_PAGES)
        .enumerate()
        .map(|(index, number)| {
            let extracted = document.extract_text(&[*number]).ok();
            let page = extracted
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .unwrap_or("[No extractable text]");
            format!("Page {}: {}", index + 1, prefix_chars(page, PAGE_TEXT))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut result = Map::new();
    result.insert("pages".into(), json!(pages.len()));
    result.insert("text".into(), json!(prefix_chars(&text, MAX_TEXT)));
    Ok(result)
}

fn normalize_rotation(rotation: i64) -> i64 {
    rotation.rem_euclid(360)
}

/// A page attribute, following the `Parent` chain for inheritable keys.
fn inherited(document: &Document, page: &Dictionary, key: &[u8]) -> Option<Object> {
    if let Ok(value) = page.get(key) {
        return Some(value.clone());
    }
    let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
    for _ in 0..64 {
        let node = document.get_dictionary(parent?).ok()?;
        if let Ok(value) = node.get(key) {
            return Some(value.clone());
        }
        parent = node.get(b"Parent").and_then(Object::as_reference).ok();
    }
    None
}

fn integer(object: &Object) -> Option<i64> {
    match object {
        Object::Integer(value) => Some(*value),
        Object::Real(value) => Some(*value as i64),
        _ => None,
    }
}

struct Source {
    pages: BTreeMap<u32, ObjectId>,
    raster: Option<hayro::hayro_syntax::Pdf>,
}

/// Render one source page to a JPEG-backed page of the same visible size.
fn raster_page(
    out: &mut Document,
    pdf: &hayro::hayro_syntax::Pdf,
    index: usize,
    rotation: i64,
    quality: i64,
    pages_id: ObjectId,
) -> Op<ObjectId> {
    use hayro::vello_cpu::color::palette::css::WHITE;
    let page = pdf.pages().get(index).ok_or(Invalid)?;
    let (width, height) = page.render_dimensions();
    if !(width > 0.0 && height > 0.0 && width < MAX_PAGE_SIDE && height < MAX_PAGE_SIDE) {
        return Err(Invalid);
    }
    let cache = hayro::RenderCache::new();
    let pixmap = hayro::render(
        page,
        &cache,
        &hayro::hayro_interpret::InterpreterSettings::default(),
        &hayro::RenderSettings::default(),
        &hayro::PixmapSettings { x_scale: RASTER_SCALE, y_scale: RASTER_SCALE, bg_color: WHITE },
    );
    let (pixels_wide, pixels_high) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
    // The background is opaque white, so premultiplied RGBA is plain RGBA.
    let rgb: Vec<u8> = pixmap.data_as_u8_slice().as_chunks::<4>().0.iter().flat_map(|[r, g, b, _]| [*r, *g, *b]).collect();
    let rgb = image::RgbImage::from_raw(pixels_wide, pixels_high, rgb).ok_or(Invalid)?;
    let jpeg = super::image_ops::encode_jpeg(&rgb, quality.clamp(10, 95) as u8)?;
    let image = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => i64::from(pixels_wide),
            "Height" => i64::from(pixels_high),
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        },
        jpeg,
    )
    .with_compression(false);
    let image_id = out.add_object(image);
    let content = format!("q {width:.3} 0 0 {height:.3} 0 0 cm /Im0 Do Q");
    let content_id = out.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
    // The render already shows the page's own rotation; only the requested
    // rotation is left for the viewer to apply.
    Ok(out.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), Object::Real(width), Object::Real(height)],
        "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
        "Contents" => content_id,
        "Rotate" => normalize_rotation(rotation),
    }))
}

pub(crate) fn build(request: &Value) -> Op<Map<String, Value>> {
    let Some(Value::Array(sources)) = request.get("sources") else { return Err(Invalid) };
    if sources.is_empty() || sources.len() > 100 {
        return Err(Invalid);
    }
    let output = output_path(request.get("destination"))?;
    let quality = request.get("quality").and_then(js_integer);

    let mut out = Document::with_version("1.7");
    let pages_id = out.new_object_id();
    let mut documents: HashMap<String, Source> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut discard: HashSet<ObjectId> = HashSet::new();
    for source in sources {
        let path = input_path(Some(source))?;
        let key = source.as_str().ok_or(Invalid)?.to_string();
        if extension(&path) != "pdf" {
            return Err(Invalid);
        }
        let mut document = load(&path)?;
        let raster = match quality {
            Some(_) => Some(hayro::hayro_syntax::Pdf::new(std::fs::read(&path)?).map_err(|_| Invalid)?),
            None => None,
        };
        let start = out.objects.keys().map(|id| id.0).max().unwrap_or(0).max(out.max_id) + 1;
        document.renumber_objects_with(start);
        // The old page tree and catalog are replaced; drop them so unselected
        // pages are pruned from the output.
        for (id, object) in &document.objects {
            if let Ok(kind) = object.as_dict().and_then(|dict| dict.get(b"Type")).and_then(Object::as_name)
                && (kind == b"Pages" || kind == b"Page")
            {
                discard.insert(*id);
            }
        }
        if let Ok(root) = document.trailer.get(b"Root").and_then(Object::as_reference) {
            discard.insert(root);
        }
        let pages = document.get_pages();
        out.objects.extend(document.objects);
        out.max_id = out.objects.keys().map(|id| id.0).max().unwrap_or(0);
        if !documents.contains_key(&key) {
            order.push(key.clone());
        }
        documents.insert(key, Source { pages, raster });
    }

    let mut selections: Vec<Value> = match request.get("pages") {
        Some(Value::Array(pages)) if pages.iter().all(Value::is_object) => pages.clone(),
        _ => Vec::new(),
    };
    if selections.is_empty() {
        for key in &order {
            for number in 1..=documents[key].pages.len() {
                selections.push(json!({ "path": key, "page": number }));
            }
        }
    }
    if selections.is_empty() || selections.len() > MAX_PAGES {
        return Err(Invalid);
    }

    let mut kids = Vec::with_capacity(selections.len());
    let mut reused: HashSet<ObjectId> = HashSet::new();
    for selection in &selections {
        let key = selection.get("path").and_then(Value::as_str).ok_or(Invalid)?;
        let number = selection.get("page").and_then(js_integer).filter(|n| *n > 0).ok_or(Invalid)?;
        let source = documents.get(key).ok_or(Invalid)?;
        let page_id = *source.pages.get(&u32::try_from(number).map_err(|_| Invalid)?).ok_or(Invalid)?;
        let rotation = selection.get("rotate").map(|r| js_integer(r).ok_or(Invalid)).transpose()?.unwrap_or(0);
        if ![0, 90, 180, 270, -90].contains(&rotation) {
            return Err(Invalid);
        }
        if let (Some(quality), Some(raster)) = (quality, &source.raster) {
            kids.push(raster_page(&mut out, raster, number as usize - 1, rotation, quality, pages_id)?.into());
            continue;
        }
        let original = out.get_dictionary(page_id).map_err(|_| Invalid)?.clone();
        let mut page = original.clone();
        for key in [&b"Resources"[..], b"MediaBox", b"CropBox"] {
            if let Some(value) = inherited(&out, &original, key) {
                page.set(key, value);
            }
        }
        let current = inherited(&out, &original, b"Rotate").as_ref().and_then(integer).unwrap_or(0);
        page.set("Rotate", (normalize_rotation(current) + rotation + 360) % 360);
        page.set("Parent", pages_id);
        // The first use of a page keeps its object so links and annotations
        // pointing at it still resolve; repeats get a copy.
        let id = if reused.insert(page_id) {
            out.objects.insert(page_id, Object::Dictionary(page));
            page_id
        } else {
            out.add_object(page)
        };
        kids.push(id.into());
    }
    for id in discard.difference(&reused) {
        out.objects.remove(id);
    }
    let count = kids.len();
    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count as i64 }),
    );
    let catalog = out.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    out.trailer = dictionary! { "Root" => catalog };
    out.prune_objects();
    out.renumber_objects();
    out.compress();
    let mut data = Vec::new();
    out.save_to(&mut data)?;
    if data.len() > MAX_OUTPUT {
        return Err(Invalid);
    }
    write_new(&output, &data, false)?;
    let mut result = Map::new();
    result.insert("pages".into(), json!(count));
    result.insert("bytes".into(), json!(data.len()));
    Ok(result)
}
