//! Local file results for `/api/files` and the file investigation agent:
//! filename-only ranking (`makeFileResult`, `findLocalFiles` in server.js).

use std::path::{Component, Path};
use std::sync::OnceLock;

use chrono::NaiveDateTime;
use regex::Regex;
use serde::Serialize;

use crate::search_index::LocalSearchIndex;
use crate::util::{extname, local_ms, now_ms, utf16_slice};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub directory: String,
    pub score: i64,
    pub file_timestamp: i64,
}

/// A time window inferred from words like “yesterday” or “latest”.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileWindow {
    pub after: i64,
    pub before: i64,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

pub fn relative_file_window(request: &str, now: i64) -> Option<FileWindow> {
    static YESTERDAY: OnceLock<Regex> = OnceLock::new();
    static RECENT: OnceLock<Regex> = OnceLock::new();
    let text = request.to_lowercase();
    if regex(
        &YESTERDAY,
        r"\b(?:last night|yesterday(?: evening| night)?)\b",
    )
    .is_match(&text)
    {
        return Some(FileWindow {
            after: now - 36 * 60 * 60 * 1000,
            before: now,
        });
    }
    if regex(&RECENT, r"\b(?:latest|recent|newest)\b").is_match(&text) {
        return Some(FileWindow {
            after: now - 14 * 24 * 60 * 60 * 1000,
            before: now,
        });
    }
    None
}

/// Strip timing words and punctuation so only a filename predicate remains.
pub fn normalized_file_query(query: &str) -> String {
    static FILLER: OnceLock<Regex> = OnceLock::new();
    static PLURAL: OnceLock<Regex> = OnceLock::new();
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    let value = regex(
        &FILLER,
        r"(?i)\b(?:last|night|yesterday|today|latest|recent|newest|from|the|ones?|files?)\b",
    )
    .replace_all(query, " ");
    let value = regex(&PLURAL, r"\b([A-Za-z0-9_]{4,})s\b").replace_all(&value, "$1");
    let value = regex(&UNSAFE, r"[^\p{L}\p{N} ._\-]").replace_all(&value, "");
    let collapsed = value
        .split(' ')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    utf16_slice(collapsed.trim(), 80)
}

/// macOS screenshots encode their capture time in the filename. Using that
/// metadata avoids reading file contents or walking a protected directory.
pub fn file_name_timestamp(file: &str) -> i64 {
    static STAMP: OnceLock<Regex> = OnceLock::new();
    let name = crate::util::base_name(Path::new(file));
    let Some(captures) = regex(
        &STAMP,
        r"(?i)(20\d{2}-\d{2}-\d{2})\s+(?:at\s+)?(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)",
    )
    .captures(&name) else {
        return 0;
    };
    let time = captures[2].replace('.', ":");
    let time = if time.matches(':').count() == 1 {
        format!("{time}:00")
    } else {
        time
    };
    NaiveDateTime::parse_from_str(&format!("{}T{time}", &captures[1]), "%Y-%m-%dT%H:%M:%S")
        .ok()
        .and_then(local_ms)
        .unwrap_or(0)
}

pub fn file_name_matches_window(file: &str, window: Option<FileWindow>) -> bool {
    let Some(window) = window else { return true };
    static STAMP: OnceLock<Regex> = OnceLock::new();
    let name = crate::util::base_name(Path::new(file));
    if !regex(
        &STAMP,
        r"(?i)(20\d{2}-\d{2}-\d{2})\s+(?:at\s+)?(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)",
    )
    .is_match(&name)
    {
        return true;
    }
    let candidate = file_name_timestamp(file);
    candidate != 0 && candidate >= window.after && candidate <= window.before
}

pub fn primary_folder(home: &Path, file: &Path) -> &'static str {
    let first = match file.strip_prefix(home) {
        Ok(relative) => relative
            .components()
            .next()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .unwrap_or_default(),
        Err(_) => String::new(),
    };
    match first.as_str() {
        "Documents" => "Documents",
        "Desktop" => "Desktop",
        "Downloads" => "Downloads",
        "Developer" | "Projects" | "Code" => "Projects",
        _ => "Home",
    }
}

/// `path.relative(home, file).split(sep).length`.
fn relative_depth(home: &Path, file: &Path) -> usize {
    let home: Vec<Component> = home.components().collect();
    let file: Vec<Component> = file.components().collect();
    let common = home.iter().zip(&file).take_while(|(a, b)| a == b).count();
    let count = (home.len() - common) + (file.len() - common);
    count.max(1)
}

/// Rank one indexed path for `query`. The in-memory filename index has
/// already produced this path: it is not stat'ed again (see TCC note in
/// `search_index`).
pub fn make_file_result(home: &Path, file: &str, query: &str, now: i64) -> FileResult {
    static IMAGE: OnceLock<Regex> = OnceLock::new();
    static SCREENSHOT: OnceLock<Regex> = OnceLock::new();
    let path = Path::new(file);
    let name = crate::util::base_name(path);
    let lower_name = name.to_lowercase();
    let lower_query = query.to_lowercase();
    let tokens: Vec<&str> = lower_query
        .split(|c: char| c.is_whitespace() || matches!(c, '.' | '_' | '-'))
        .filter(|token| token.chars().count() >= 2)
        .collect();
    let folder = primary_folder(home, path);
    let folder_rank = match folder {
        "Documents" => 90,
        "Desktop" => 75,
        "Downloads" => 60,
        "Projects" => 35,
        "Home" => 15,
        _ => 5,
    };
    let stem = match lower_name.rfind('.') {
        Some(index) if index + 1 < lower_name.len() => &lower_name[..index],
        _ => lower_name.as_str(),
    };
    let extension = extname(&lower_name);
    let is_image = regex(&IMAGE, r"\.(?:avif|gif|heic|jpe?g|png|webp)$").is_match(extension);
    let screenshot_intent =
        regex(&SCREENSHOT, r"(?i)(?:screenshot|screen[ ._-]?shot)").is_match(query);
    let exact = stem == lower_query || lower_name == lower_query;
    let starts =
        stem.starts_with(&lower_query) || tokens.iter().all(|token| stem.starts_with(token));
    let name_rank: i64 = if exact {
        120
    } else if starts {
        80
    } else {
        tokens
            .iter()
            .map(|token| if stem.contains(token) { 22 } else { 0 })
            .sum()
    };
    let shallow_rank = (20 - relative_depth(home, path) as i64 * 2).max(0);
    // A query for “screenshots” should surface the recent screenshot images on
    // Desktop before similarly named source folders. This stays entirely local
    // and uses filename metadata only.
    let kind_rank = if screenshot_intent {
        if is_image {
            95
        } else if !extension.is_empty() {
            0
        } else {
            -95
        }
    } else if !extension.is_empty() {
        4
    } else {
        0
    };
    let timestamp = file_name_timestamp(file);
    let recency_rank = if timestamp == 0 {
        0
    } else {
        let age = (now - timestamp).max(0);
        if age < 48 * 60 * 60 * 1000 {
            65
        } else if age < 7 * 24 * 60 * 60 * 1000 {
            42
        } else if age < 31 * 24 * 60 * 60 * 1000 {
            18
        } else {
            0
        }
    };
    let parent = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let home_text = home.to_string_lossy();
    let directory = if home_text.is_empty() {
        parent
    } else {
        parent.replacen(home_text.as_ref(), "~", 1)
    };
    FileResult {
        path: file.to_string(),
        name,
        folder: folder.to_string(),
        directory,
        score: folder_rank + name_rank + shallow_rank + kind_rank + recency_rank,
        file_timestamp: timestamp,
    }
}

pub async fn find_local_files(
    index: &LocalSearchIndex,
    home: &Path,
    query: &str,
    limit: usize,
    window: Option<FileWindow>,
) -> Vec<FileResult> {
    let safe_query = normalized_file_query(query);
    if safe_query.chars().count() < 2 {
        return Vec::new();
    }
    let now = now_ms();
    let mut files: Vec<FileResult> = index
        .search(&safe_query, 50)
        .await
        .into_iter()
        .filter(|hit| file_name_matches_window(&hit.path, window))
        .map(|hit| make_file_result(home, &hit.path, &safe_query, now))
        .collect();
    files.sort_by_key(|file| std::cmp::Reverse(file.score));
    files.truncate(limit);
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_drop_timing_words_and_unsafe_characters() {
        assert_eq!(
            normalized_file_query("the latest screenshots from yesterday"),
            "screenshot"
        );
        assert_eq!(normalized_file_query("invoice; rm -rf /"), "invoice rm -rf");
        assert_eq!(normalized_file_query("Café notes"), "Café note");
    }

    #[test]
    fn windows_come_from_natural_timing_words() {
        let now = 1_000_000_000_000;
        assert_eq!(
            relative_file_window("files from last night", now)
                .unwrap()
                .after,
            now - 36 * 3_600_000
        );
        assert!(relative_file_window("latest invoice", now).is_some());
        assert!(relative_file_window("invoice", now).is_none());
    }

    #[test]
    fn ranking_prefers_documents_exact_names_and_recent_screenshots() {
        let home = Path::new("/Users/a");
        let now = now_ms();
        let doc = make_file_result(home, "/Users/a/Documents/invoice.pdf", "invoice", now);
        assert_eq!(doc.folder, "Documents");
        assert_eq!(doc.directory, "~/Documents");
        assert_eq!(doc.score, 90 + 120 + (20 - 4) + 4);
        let other = make_file_result(home, "/Users/a/Code/x/old-invoice.pdf", "invoice", now);
        assert!(doc.score > other.score);
        assert_eq!(other.folder, "Projects");
        let folder = make_file_result(home, "/Users/a/Desktop/screenshots", "screenshot", now);
        let image = make_file_result(
            home,
            "/Users/a/Desktop/Screenshot 2020-01-01 at 10.00.00.png",
            "screenshot",
            now,
        );
        assert!(image.score > folder.score);
        assert!(image.file_timestamp > 0);
    }

    #[test]
    fn screenshot_timestamps_respect_the_window() {
        let name = "/Users/a/Desktop/Screenshot 2026-01-02 at 10.11.12.png";
        let stamp = file_name_timestamp(name);
        assert!(stamp > 0);
        assert!(file_name_matches_window(
            name,
            Some(FileWindow {
                after: stamp - 1,
                before: stamp + 1
            })
        ));
        assert!(!file_name_matches_window(
            name,
            Some(FileWindow {
                after: stamp + 1,
                before: stamp + 2
            })
        ));
        assert!(file_name_matches_window(
            "/a/plain.txt",
            Some(FileWindow {
                after: 0,
                before: 1
            })
        ));
    }
}
