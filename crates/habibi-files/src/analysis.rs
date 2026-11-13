//! Local evidence, exact-duplicate proof and storage summaries (`analysis.ts`).

use std::collections::HashMap;
use std::io::Read;

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::contract::FileEntry;
use crate::error::FileResult;
use crate::native::NativeFileTools;
use crate::util::{extname, js_len, js_slice, open_no_follow, path_extname};

const EVIDENCE_BUDGET: usize = 48_000;
const EXCERPT_LIMIT: usize = 3000;
const MAX_EVIDENCE_FILE: u64 = 24 * 1024 * 1024;

/// Remove `<...>` tags as `replace(/<[^>]*>/g, '')` did.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        match rest[start..].find('>') {
            Some(end) => {
                out.push_str(&rest[..start]);
                rest = &rest[start + end + 1..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

/// Attach bounded excerpts (and PDF page counts) to the first 80 entries,
/// only when the user chose to share contents.
pub(crate) fn file_evidence(entries: &mut [FileEntry], contents: bool, native: &dyn NativeFileTools) {
    let mut remaining = EVIDENCE_BUDGET;
    for entry in entries.iter_mut().take(80) {
        if !contents || remaining == 0 || entry.size > MAX_EVIDENCE_FILE {
            continue;
        }
        let extension = path_extname(&entry.path).to_lowercase();
        let result: FileResult<()> = (|| {
            if [".txt", ".md", ".csv", ".json", ".log", ".html"].contains(&extension.as_str()) {
                let file = open_no_follow(&entry.path)?;
                let limit = entry.size.min(EXCERPT_LIMIT as u64).min(remaining as u64);
                let mut buffer = Vec::new();
                file.take(limit).read_to_end(&mut buffer)?;
                entry.excerpt = Some(strip_tags(&String::from_utf8_lossy(&buffer)));
            } else if [".pdf", ".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"].contains(&extension.as_str()) {
                let inspected = native.run(&json!({ "action": "inspect", "path": entry.path }))?;
                entry.excerpt = Some(match inspected.get("text") {
                    Some(Value::String(text)) => js_slice(text, EXCERPT_LIMIT.min(remaining)),
                    _ => String::new(),
                });
                if let Some(pages) = inspected.get("pages").and_then(Value::as_u64) {
                    entry.pages = Some(pages);
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => remaining = remaining.saturating_sub(entry.excerpt.as_deref().map(js_len).unwrap_or(0)),
            Err(_) => entry.excerpt = Some("[Content unavailable]".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DuplicateGroup {
    pub hash: String,
    pub ids: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Duplicates {
    pub groups: Vec<DuplicateGroup>,
    pub limited: bool,
}

const MAX_HASHED_FILE: u64 = 256 * 1024 * 1024;
const MAX_HASHED_TOTAL: u64 = 512 * 1024 * 1024;

/// Group files by SHA-256 among same-size candidates, re-verifying each file
/// before and after reading so the proof matches what will be acted on.
pub(crate) fn duplicate_groups(
    entries: &[FileEntry],
    verify: impl Fn(&FileEntry) -> FileResult<()>,
) -> FileResult<Duplicates> {
    let mut sizes: Vec<(u64, Vec<&FileEntry>)> = Vec::new();
    for entry in entries.iter().filter(|entry| entry.size > 0) {
        match sizes.iter_mut().find(|(size, _)| *size == entry.size) {
            Some((_, list)) => list.push(entry),
            None => sizes.push((entry.size, vec![entry])),
        }
    }
    let mut groups = Vec::new();
    let mut read = 0u64;
    let mut limited = false;
    for (size, candidates) in sizes {
        if candidates.len() < 2 {
            continue;
        }
        let mut hashes: Vec<(String, Vec<&FileEntry>)> = Vec::new();
        for entry in candidates {
            if size > MAX_HASHED_FILE || read + size > MAX_HASHED_TOTAL {
                limited = true;
                continue;
            }
            verify(entry)?;
            let mut file = std::fs::File::open(&entry.path)?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            verify(entry)?;
            read += size;
            let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
            match hashes.iter_mut().find(|(hash, _)| *hash == digest) {
                Some((_, list)) => list.push(entry),
                None => hashes.push((digest, vec![entry])),
            }
        }
        for (hash, files) in hashes {
            if files.len() > 1 {
                groups.push(DuplicateGroup {
                    hash,
                    bytes: size * (files.len() as u64 - 1),
                    ids: files.iter().map(|file| file.id.clone()).collect(),
                });
            }
        }
    }
    Ok(Duplicates { groups, limited })
}

pub(crate) fn storage_summary(entries: &[FileEntry]) -> Value {
    let mut categories: Vec<(String, u64)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for entry in entries {
        let name = entry.path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let mut extension = extname(&name).to_lowercase();
        if extension.is_empty() {
            extension = "no extension".into();
        }
        match index.get(&extension) {
            Some(&at) => categories[at].1 += entry.size,
            None => {
                index.insert(extension.clone(), categories.len());
                categories.push((extension, entry.size));
            }
        }
    }
    categories.sort_by_key(|category| std::cmp::Reverse(category.1));
    let mut largest: Vec<&FileEntry> = entries.iter().collect();
    largest.sort_by_key(|entry| std::cmp::Reverse(entry.size));
    json!({
        "totalBytes": entries.iter().map(|entry| entry.size).sum::<u64>(),
        "files": entries.len(),
        "categories": categories
            .into_iter()
            .map(|(extension, bytes)| json!({ "extension": extension, "bytes": bytes }))
            .collect::<Vec<_>>(),
        "largest": largest
            .into_iter()
            .take(20)
            .map(|entry| json!({ "id": entry.id, "relative": entry.relative, "size": entry.size }))
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_stripped_like_the_node_regex() {
        assert_eq!(strip_tags("<p>Demo <b>Cafe</b></p> <unterminated"), "Demo Cafe <unterminated");
    }
}
