//! Launcher app search: a warm index of discovered apps and the typo-tolerant
//! name matcher (`applications` / `applicationMatchScore` in server.js).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use habibi_platform::apps::App;
use unicode_normalization::UnicodeNormalization;

use crate::desktop::Desktop;

fn normalized_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .nfkd()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// Returns `None` as soon as a match cannot land inside `limit`. App names
/// are short, but this keeps typo matching bounded for every keystroke.
fn bounded_edit_distance(left: &[char], right: &[char], limit: usize) -> Option<usize> {
    if left.len().abs_diff(right.len()) > limit {
        return None;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for row in 1..=left.len() {
        let mut current = vec![row];
        let mut smallest = row;
        for column in 1..=right.len() {
            let cost = usize::from(left[row - 1] != right[column - 1]);
            let value = (previous[column] + 1)
                .min(current[column - 1] + 1)
                .min(previous[column - 1] + cost);
            current.push(value);
            smallest = smallest.min(value);
        }
        if smallest > limit {
            return None;
        }
        previous = current;
    }
    (previous[right.len()] <= limit).then_some(previous[right.len()])
}

fn split_words(value: &str) -> Vec<String> {
    value
        .split(|c: char| c.is_whitespace() || matches!(c, '.' | '_' | '-'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// `name.replace(/([a-z])([A-Z])/g, '$1 $2')`.
fn split_camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if previous.is_some_and(|p| p.is_ascii_lowercase()) && c.is_ascii_uppercase() {
            out.push(' ');
        }
        out.push(c);
        previous = Some(c);
    }
    out
}

pub fn application_match_score(name: &str, query: &str) -> i64 {
    let raw = query.trim().to_lowercase();
    if raw.is_empty() {
        return 1;
    }
    let words = split_words(&raw);
    let compact_query = normalized_search_text(&raw);
    let compact_name = normalized_search_text(name);
    let name_words = split_words(&split_camel(name).to_lowercase());
    if compact_query.is_empty() {
        return 0;
    }
    if compact_name == compact_query {
        return 1_000;
    }
    if compact_name.starts_with(&compact_query) {
        return 900;
    }
    if compact_name.contains(&compact_query) {
        return 760;
    }
    if !words.is_empty()
        && words.iter().all(|word| {
            name_words
                .iter()
                .any(|candidate| candidate.starts_with(word.as_str()))
        })
    {
        return 820;
    }
    // Typo tolerance is intentionally conservative: a short query gets one
    // correction and longer names get at most three. It repairs "Shap3d" to
    // "Shapr3D" while preventing broad one-letter guesses from polluting search.
    let query_chars: Vec<char> = compact_query.chars().collect();
    if query_chars.len() < 3 {
        return 0;
    }
    let limit = match query_chars.len() {
        0..=4 => 1,
        5..=8 => 2,
        _ => 3,
    };
    let candidates = std::iter::once(compact_name.clone())
        .chain(name_words.iter().map(|word| normalized_search_text(word)))
        .filter(|c| !c.is_empty());
    let distance = candidates
        .filter_map(|candidate| {
            bounded_edit_distance(&query_chars, &candidate.chars().collect::<Vec<_>>(), limit)
        })
        .min();
    match distance {
        Some(distance) => {
            520 - distance as i64 * 85
                - (compact_name.chars().count() as i64 - query_chars.len() as i64).max(0) * 3
        }
        None => 0,
    }
}

/// The best eight matches for `query`.
pub fn search(apps: &[App], query: &str) -> Vec<App> {
    let mut matches: Vec<(i64, &App)> = apps
        .iter()
        .map(|app| (application_match_score(&app.name, query), app))
        .filter(|(score, _)| *score > 0)
        .collect();
    matches.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| crate::util::locale_cmp(&left.1.name, &right.1.name))
    });
    matches
        .into_iter()
        .take(8)
        .map(|(_, app)| app.clone())
        .collect()
}

const STALE_AFTER: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct Snapshot {
    loaded_at: Option<Instant>,
    apps: Arc<Vec<App>>,
    refreshing: bool,
}

/// Discovered apps, kept warm: a stale index is served while it refreshes in
/// the background; a cold one is awaited.
#[derive(Default)]
pub struct AppIndex {
    snapshot: Mutex<Snapshot>,
    cold: tokio::sync::Mutex<()>,
}

impl AppIndex {
    async fn discover(self: &Arc<Self>, desktop: &Arc<dyn Desktop>) -> Arc<Vec<App>> {
        let desktop = desktop.clone();
        let apps = Arc::new(
            tokio::task::spawn_blocking(move || desktop.discover_apps())
                .await
                .unwrap_or_default(),
        );
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        snapshot.loaded_at = Some(Instant::now());
        snapshot.apps = apps.clone();
        snapshot.refreshing = false;
        apps
    }

    pub async fn apps(self: &Arc<Self>, desktop: &Arc<dyn Desktop>) -> Arc<Vec<App>> {
        let (loaded, apps, refresh) = {
            let mut snapshot = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            let stale = snapshot
                .loaded_at
                .is_none_or(|at| at.elapsed() >= STALE_AFTER);
            let refresh = snapshot.loaded_at.is_some() && stale && !snapshot.refreshing;
            if refresh {
                snapshot.refreshing = true;
            }
            (snapshot.loaded_at.is_some(), snapshot.apps.clone(), refresh)
        };
        if loaded {
            if refresh {
                let index = self.clone();
                let desktop = desktop.clone();
                tokio::spawn(async move {
                    index.discover(&desktop).await;
                });
            }
            return apps;
        }
        let _cold = self.cold.lock().await;
        let current = {
            let snapshot = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            snapshot.loaded_at.map(|_| snapshot.apps.clone())
        };
        match current {
            Some(apps) => apps,
            None => self.discover(desktop).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> App {
        App {
            name: name.into(),
            path: format!("/Applications/{name}.app"),
            executable: None,
        }
    }

    #[test]
    fn scoring_prefers_exact_prefix_and_word_matches_and_repairs_small_typos() {
        assert_eq!(application_match_score("Safari", ""), 1);
        assert_eq!(application_match_score("Safari", "safari"), 1_000);
        assert_eq!(application_match_score("Safari", "saf"), 900);
        assert_eq!(application_match_score("Visual Studio Code", "studio"), 760);
        assert_eq!(
            application_match_score("Visual Studio Code", "vis cod"),
            820
        );
        assert_eq!(application_match_score("FaceTime", "fa ti"), 820);
        assert!(application_match_score("Shapr3D", "Shap3d") > 0);
        assert_eq!(application_match_score("Safari", "zz"), 0);
        assert_eq!(application_match_score("Mail", "xyzzy"), 0);
        assert_eq!(application_match_score("Café", "cafe"), 1_000);
    }

    #[test]
    fn search_returns_the_best_eight() {
        let apps: Vec<App> = ["Notes", "Notion", "Numbers", "Safari"]
            .map(app)
            .into_iter()
            .collect();
        let names: Vec<String> = search(&apps, "no")
            .into_iter()
            .map(|app| app.name)
            .collect();
        assert_eq!(names, ["Notes", "Notion"]);
        let many: Vec<App> = (0..12).map(|i| app(&format!("App {i}"))).collect();
        assert_eq!(search(&many, "").len(), 8);
    }
}
