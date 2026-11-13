//! The helper's actions against generated fixtures (the Swift smoke test
//! built the same kind of fictional PDFs and a gradient photo).

use std::path::{Path, PathBuf};

use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, Stream, dictionary};
use serde_json::{Value, json};

use super::*;

/// A PDF with one page of Helvetica text per entry.
fn make_pdf(path: &Path, pages: &[&str]) {
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let font = document.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
    let resources = document.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let mut kids = Vec::new();
    for text in pages {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 36.into()]),
                Operation::new("Td", vec![60.into(), 600.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content = document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        kids.push(Object::Reference(document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content,
        })));
    }
    let count = kids.len() as i64;
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
        }),
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    document.save(path).unwrap();
}

fn photo(width: u32, height: u32) -> image::RgbaImage {
    image::RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba([((x * 37 + y * 19) % 256) as u8, ((x * 11 + y * 43) % 256) as u8, ((x * 5 + y * 7) % 256) as u8, 255])
    })
}

struct Fixtures {
    _temp: tempfile::TempDir,
    root: PathBuf,
}

impl Fixtures {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = crate::util::canonical(temp.path()).unwrap();
        make_pdf(&root.join("report-a.pdf"), &["Demo Cafe Invoice 1", "Demo Cafe Page 2", "Demo Cafe Page 3"]);
        make_pdf(&root.join("report-b.pdf"), &["Demo Studio Invoice", "Demo Studio Page 2", "Demo Studio Page 3"]);
        photo(1800, 1200).save(root.join("photo.png")).unwrap();
        Self { _temp: temp, root }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_str().unwrap().to_string()
    }
}

fn page_text(path: &str, page: u32) -> String {
    Document::load(path).unwrap().extract_text(&[page]).unwrap()
}

fn rotation(path: &str, page: u32) -> i64 {
    let document = Document::load(path).unwrap();
    let id = document.get_pages()[&page];
    document.get_dictionary(id).unwrap().get(b"Rotate").and_then(Object::as_i64).unwrap_or(0)
}

#[test]
fn inspect_reports_pdf_pages_and_bounded_text() {
    let f = Fixtures::new();
    let result = run_local(&json!({ "action": "inspect", "path": f.path("report-a.pdf") })).unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["pages"], 3);
    let text = result["text"].as_str().unwrap();
    assert!(text.starts_with("Page 1: Demo Cafe Invoice 1"), "{text}");
    assert!(text.contains("\nPage 3: Demo Cafe Page 3"), "{text}");
}

#[test]
fn pdf_pages_are_selected_reordered_rotated_and_merged_into_a_new_file() {
    let f = Fixtures::new();
    let output = f.path("selected.pdf");
    let result = run_local(&json!({
        "action": "pdf",
        "sources": [f.path("report-a.pdf"), f.path("report-b.pdf")],
        "destination": output,
        "pages": [
            { "path": f.path("report-b.pdf"), "page": 2, "rotate": 90 },
            { "path": f.path("report-a.pdf"), "page": 1 },
            { "path": f.path("report-a.pdf"), "page": 1, "rotate": -90 },
        ],
    }))
    .unwrap();
    assert_eq!(result["pages"], 3);
    assert_eq!(result["bytes"].as_u64().unwrap(), std::fs::metadata(&output).unwrap().len());
    assert!(page_text(&output, 1).contains("Demo Studio Page 2"));
    assert!(page_text(&output, 2).contains("Demo Cafe Invoice 1"));
    assert_eq!((rotation(&output, 1), rotation(&output, 2), rotation(&output, 3)), (90, 0, 270));

    let merged = f.path("merged.pdf");
    let result = run_local(&json!({
        "action": "pdf",
        "sources": [f.path("report-b.pdf"), f.path("report-a.pdf")],
        "destination": merged,
    }))
    .unwrap();
    assert_eq!(result["pages"], 6);
    assert!(page_text(&merged, 1).contains("Demo Studio Invoice"));
    assert!(page_text(&merged, 4).contains("Demo Cafe Invoice 1"));
    // The originals are untouched.
    assert_eq!(Document::load(f.path("report-a.pdf")).unwrap().get_pages().len(), 3);
}

#[test]
fn pdf_quality_rasterizes_a_compressed_copy() {
    let f = Fixtures::new();
    let output = f.path("compressed.pdf");
    let result = run_local(&json!({
        "action": "pdf",
        "sources": [f.path("report-a.pdf")],
        "destination": output,
        "pages": [{ "path": f.path("report-a.pdf"), "page": 2, "rotate": 180 }],
        "quality": 40,
    }))
    .unwrap();
    assert_eq!(result["pages"], 1);
    let document = Document::load(&output).unwrap();
    let page = document.get_dictionary(document.get_pages()[&1]).unwrap();
    assert_eq!(page.get(b"Rotate").and_then(Object::as_i64).unwrap(), 180);
    let has_jpeg = document.objects.values().any(|object| {
        object.as_stream().is_ok_and(|stream| stream.dict.get(b"Filter").and_then(Object::as_name).ok() == Some(b"DCTDecode"))
    });
    assert!(has_jpeg);
    // A page image has no text layer any more.
    let inspected = run_local(&json!({ "action": "inspect", "path": output })).unwrap();
    assert_eq!(inspected["text"], "Page 1: [No extractable text]");
}

#[test]
fn pdf_requests_outside_the_bounds_are_refused() {
    let f = Fixtures::new();
    let refuse = |request: Value| run_local(&request).unwrap_err().message().to_string();
    assert_eq!(
        refuse(json!({ "action": "pdf", "sources": [f.path("report-a.pdf")], "destination": f.path("report-b.pdf") })),
        PROCESS_ERROR,
        "never overwrites"
    );
    assert_eq!(
        refuse(json!({ "action": "pdf", "sources": [f.path("photo.png")], "destination": f.path("x.pdf") })),
        PROCESS_ERROR
    );
    assert_eq!(
        refuse(json!({
            "action": "pdf",
            "sources": [f.path("report-a.pdf")],
            "destination": f.path("x.pdf"),
            "pages": [{ "path": f.path("report-a.pdf"), "page": 4 }],
        })),
        PROCESS_ERROR
    );
    assert_eq!(
        refuse(json!({
            "action": "pdf",
            "sources": [f.path("report-a.pdf")],
            "destination": f.path("x.pdf"),
            "pages": [{ "path": f.path("report-a.pdf"), "page": 1, "rotate": 45 }],
        })),
        PROCESS_ERROR
    );
    assert_eq!(refuse(json!({ "action": "pdf", "sources": ["relative.pdf"], "destination": f.path("x.pdf") })), PROCESS_ERROR);
    assert!(!Path::new(&f.path("x.pdf")).exists());
    let pages: Vec<Value> = (0..501).map(|_| json!({ "path": f.path("report-a.pdf"), "page": 1 })).collect();
    assert_eq!(
        refuse(json!({ "action": "pdf", "sources": [f.path("report-a.pdf")], "destination": f.path("x.pdf"), "pages": pages })),
        PROCESS_ERROR
    );
    assert_eq!(refuse(json!({ "action": "shell", "command": "rm" })), PROCESS_ERROR);
    assert_eq!(refuse(json!({ "action": "inspect", "path": "x".repeat(MAX_REQUEST) })), PROCESS_ERROR);
}

#[test]
fn images_are_resized_and_re_encoded_toward_a_target_size() {
    let f = Fixtures::new();
    let jpeg = f.path("photo.jpg");
    let result =
        run_local(&json!({ "action": "image", "sources": [f.path("photo.png")], "destination": jpeg, "width": 900, "quality": 95 }))
            .unwrap();
    let decoded = image::open(&jpeg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (900, 600));
    let full = result["bytes"].as_u64().unwrap();
    assert_eq!(full, std::fs::metadata(&jpeg).unwrap().len());

    let small = f.path("small.jpg");
    let result = run_local(&json!({
        "action": "image",
        "sources": [f.path("photo.png")],
        "destination": small,
        "width": 900,
        "quality": 95,
        "targetBytes": 1024,
    }))
    .unwrap();
    assert!(result["bytes"].as_u64().unwrap() < full, "quality steps down toward the target");

    // Width never upscales and is clamped to at least 100 px.
    let png = f.path("tiny.png");
    run_local(&json!({ "action": "image", "sources": [f.path("photo.png")], "destination": png, "width": 10 })).unwrap();
    assert_eq!(image::open(&png).unwrap().width(), 100);
    let same = f.path("same.png");
    run_local(&json!({ "action": "image", "sources": [f.path("photo.png")], "destination": same, "width": 6000 })).unwrap();
    assert_eq!(image::open(&same).unwrap().width(), 1800);
    // Never overwrites, and exactly one source.
    assert!(run_local(&json!({ "action": "image", "sources": [f.path("photo.png")], "destination": same })).is_err());
    assert!(
        run_local(&json!({ "action": "image", "sources": [f.path("photo.png"), f.path("photo.png")], "destination": f.path("two.png") }))
            .is_err()
    );
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

#[test]
fn images_over_the_pixel_bound_are_refused_before_decoding() {
    let f = Fixtures::new();
    // A PNG header claiming 10,000 × 10,000 pixels with no image data.
    let mut ihdr = b"IHDR".to_vec();
    ihdr.extend_from_slice(&10_000u32.to_be_bytes());
    ihdr.extend_from_slice(&10_000u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend_from_slice(&13u32.to_be_bytes());
    png.extend_from_slice(&ihdr);
    png.extend_from_slice(&crc32(&ihdr).to_be_bytes());
    std::fs::write(f.root.join("huge.png"), png).unwrap();
    assert_eq!(image_ops::dimensions(&f.root.join("huge.png")).err().map(|_| ()), Some(()));
    assert!(run_local(&json!({ "action": "image", "sources": [f.path("huge.png")], "destination": f.path("out.jpg") })).is_err());
    assert!(run_local(&json!({ "action": "inspect", "path": f.path("huge.png") })).is_err());
}

#[cfg(unix)]
#[test]
fn inputs_must_be_regular_files_not_links() {
    let f = Fixtures::new();
    std::os::unix::fs::symlink(f.root.join("report-a.pdf"), f.root.join("link.pdf")).unwrap();
    assert!(run_local(&json!({ "action": "inspect", "path": f.path("link.pdf") })).is_err());
    assert!(run_local(&json!({ "action": "inspect", "path": f.path("missing.pdf") })).is_err());
    assert!(run_local(&json!({ "action": "trash", "path": f.path("link.pdf") })).is_err());
}

/// Render a line of text through the PDF rasterizer and read it back.
#[test]
fn images_are_read_with_the_platform_ocr_engine() {
    let f = Fixtures::new();
    make_pdf(&f.root.join("sign.pdf"), &["HABIBI RECEIPT 2026"]);
    let pdf = hayro::hayro_syntax::Pdf::new(std::fs::read(f.root.join("sign.pdf")).unwrap()).unwrap();
    let pixmap = hayro::render(
        &pdf.pages()[0],
        &hayro::RenderCache::new(),
        &hayro::hayro_interpret::InterpreterSettings::default(),
        &hayro::RenderSettings::default(),
        &hayro::PixmapSettings { x_scale: 2.0, y_scale: 2.0, bg_color: hayro::vello_cpu::color::palette::css::WHITE },
    );
    std::fs::write(f.root.join("sign.png"), pixmap.into_png().unwrap()).unwrap();
    let result = run_local(&json!({ "action": "inspect", "path": f.path("sign.png") })).unwrap();
    assert_eq!((result["width"].as_u64(), result["height"].as_u64()), (Some(1200), Some(1600)));
    let text = result["text"].as_str().unwrap();
    if result.get("ocrAvailable") == Some(&json!(false)) {
        assert_eq!(text, OCR_UNAVAILABLE);
    } else {
        assert!(text.to_uppercase().contains("HABIBI"), "{text}");
    }
}
