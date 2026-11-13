//! Synthetic filename-index benchmark (replaces `scripts/benchmark-search.mjs`),
//! searching with the `/api/files` limit of 50.
//!
//! ```sh
//! cargo run --release -p habibi-local --example search_benchmark -- 20000
//! ```
//!
//! Builds empty files in a scratch folder only; never crawls a real account
//! or private directory. Excludes the UI, connectors, application discovery
//! and whole-app energy use.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::Path;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Instant;

use habibi_local::search_index::{IndexOptions, LocalSearchIndex};

/// Live heap bytes, so the index's memory can be reported like the old
/// `heapUsed` delta.
struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);

// SAFETY: forwards to the system allocator and only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let requested = std::env::args().nth(1).and_then(|value| value.parse::<usize>().ok()).unwrap_or(20_000);
    let count = requested.clamp(100, 30_000);
    let scratch = tempfile::tempdir()?;
    let root = scratch.path();
    for directory in 0..100 {
        let folder = root.join(format!("project-{directory}"));
        std::fs::create_dir(&folder)?;
        for offset in (directory..count).step_by(100) {
            std::fs::write(folder.join(format!("project-{offset}-design-invoice.pdf")), b"")?;
        }
    }

    let before = LIVE.load(Ordering::Relaxed);
    let index = LocalSearchIndex::new(
        Path::new("/nonexistent-home"),
        IndexOptions { roots: vec![root.to_path_buf()], max_entries: 30_000, max_directories: 4_000, max_depth: 8, watch: false },
    );
    let started = Instant::now();
    index.ready().await;
    let cold_ms = started.elapsed().as_secs_f64() * 1000.0;
    let heap_mib = (LIVE.load(Ordering::Relaxed) - before) as f64 / 1024.0 / 1024.0;

    let queries = ["design", "invoice", "project-120", "missing-name", "pdf"];
    let mut durations = Vec::with_capacity(200);
    for run in 0..200 {
        let time = Instant::now();
        let _ = index.search(queries[run % queries.len()], 50).await;
        durations.push(time.elapsed().as_secs_f64() * 1000.0);
    }
    durations.sort_by(f64::total_cmp);
    let round = |value: f64, places: i32| (value * 10f64.powi(places)).round() / 10f64.powi(places);
    let report = serde_json::json!({
        "files": count,
        "entries": index.status()["indexed"],
        "coldIndexMs": round(cold_ms, 1),
        "warmP50Ms": round(durations[100], 2),
        "warmP95Ms": round(durations[190], 2),
        "heapDeltaMiB": round(heap_mib, 2),
        "note": "Synthetic filename-index benchmark; excludes the UI, connectors, application discovery, and full-app energy use.",
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    index.close();
    Ok(())
}
