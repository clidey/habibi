//! Filename-only index of the user's working folders. No subprocesses,
//! content reads, periodic scans, or per-query disk I/O. Changes arrive from
//! filesystem notifications (FSEvents, inotify, ReadDirectoryChangesW) and an
//! explicit refresh. Ported from `src/server/services/local-search-index.ts`.
//!
//! On macOS this deliberately never stats or reads candidate files: `stat` on
//! Documents/Downloads is enough for TCC to show a protected-folder prompt.
//! Entries are classified from directory listings only.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

const IGNORED: &[&str] = &[
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    "coverage",
    "Library",
    "Caches",
    "DerivedData",
    "Pods",
    "__pycache__",
];

/// NFKD, combining marks removed, lowercased (`Café` matches `cafe`).
pub fn normalize(value: &str) -> String {
    value
        .nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}

#[derive(Debug, Clone)]
pub struct IndexOptions {
    pub roots: Vec<PathBuf>,
    pub max_entries: usize,
    pub max_directories: usize,
    pub max_depth: usize,
    pub watch: bool,
}

impl IndexOptions {
    /// Desktop, Documents, Downloads, Projects, Developer and Code under `home`.
    pub fn for_home(home: &Path) -> Self {
        let mut roots = Vec::new();
        for name in [
            "Desktop",
            "Documents",
            "Downloads",
            "Projects",
            "Developer",
            "Code",
        ] {
            if let Some(root) = habibi_platform::folders::named_folder(home, name) {
                let root = habibi_platform::fsutil::resolve(&root);
                if !roots.contains(&root) {
                    roots.push(root);
                }
            }
        }
        Self {
            roots,
            max_entries: 30_000,
            max_directories: 4_000,
            max_depth: 8,
            watch: true,
        }
    }
}

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    lower: String,
    directory: String,
    folder: String,
    is_directory: bool,
    /// Insertion order (JS `Map` iteration order) for stable ranking.
    seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub directory: String,
    pub folder: String,
    pub score: f64,
}

#[derive(Default)]
struct State {
    entries: HashMap<PathBuf, Entry>,
    seq: u64,
    truncated: bool,
    indexing: bool,
    unavailable_roots: Vec<String>,
    closed: bool,
}

#[derive(Default)]
struct Pending {
    directories: Vec<PathBuf>,
    reconcile: HashSet<PathBuf>,
    generation: u64,
}

struct Inner {
    home: PathBuf,
    options: IndexOptions,
    state: Mutex<State>,
    pending: Mutex<Pending>,
    initialized: tokio::sync::OnceCell<()>,
    work: tokio::sync::Mutex<()>,
    watchers: Mutex<Vec<notify::RecommendedWatcher>>,
    runtime: Mutex<Option<tokio::runtime::Handle>>,
}

#[derive(Clone)]
pub struct LocalSearchIndex {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_inside(file: &Path, directory: &Path) -> bool {
    file != directory && file.starts_with(directory)
}

impl Inner {
    fn root_of(&self, file: &Path) -> Option<&PathBuf> {
        self.options
            .roots
            .iter()
            .find(|root| file.starts_with(root))
    }

    fn allowed(&self, file: &Path) -> bool {
        let Some(root) = self.root_of(file) else {
            return false;
        };
        let Ok(relative) = file.strip_prefix(root) else {
            return false;
        };
        relative.components().all(|part| {
            let part = part.as_os_str().to_string_lossy();
            let lower = part.to_lowercase();
            !part.starts_with('.')
                && !IGNORED.contains(&part.as_ref())
                && !lower.ends_with(".app")
                && !lower.ends_with(".framework")
                && !lower.ends_with(".bundle")
        })
    }

    fn display_directory(&self, directory: &Path) -> String {
        if is_inside(directory, &self.home)
            && let Ok(relative) = directory.strip_prefix(&self.home)
        {
            return format!("~{}{}", std::path::MAIN_SEPARATOR, relative.display());
        }
        directory.to_string_lossy().into_owned()
    }

    /// Breadth-first listing of `start` (one level unless `recursive`).
    fn walk(&self, start: &Path, recursive: bool) {
        let Some(root) = self.root_of(start).cloned() else {
            return;
        };
        if !self.allowed(start) {
            return;
        }
        // A watch filename is untrusted and can have become a symlink since notification.
        if !std::fs::symlink_metadata(start).is_ok_and(|metadata| metadata.is_dir()) {
            return;
        }
        let folder = crate::util::base_name(&root);
        let mut queue = vec![start.to_path_buf()];
        let mut directories = 0;
        let mut cursor = 0;
        while cursor < queue.len() {
            if lock(&self.state).closed {
                return;
            }
            let directory = queue[cursor].clone();
            cursor += 1;
            directories += 1;
            if directories > self.options.max_directories {
                lock(&self.state).truncated = true;
                break;
            }
            let Ok(listing) = std::fs::read_dir(&directory) else {
                continue;
            };
            let shown = self.display_directory(&directory);
            for item in listing.flatten() {
                let file = item.path();
                let Ok(kind) = item.file_type() else { continue };
                if !self.allowed(&file) || kind.is_symlink() {
                    continue;
                }
                let mut state = lock(&self.state);
                if state.closed {
                    return;
                }
                if state.entries.len() >= self.options.max_entries
                    && !state.entries.contains_key(&file)
                {
                    state.truncated = true;
                    break;
                }
                let name = item.file_name().to_string_lossy().into_owned();
                let seq = match state.entries.get(&file) {
                    Some(existing) => existing.seq,
                    None => {
                        state.seq += 1;
                        state.seq
                    }
                };
                state.entries.insert(
                    file.clone(),
                    Entry {
                        lower: normalize(&name),
                        name,
                        directory: shown.clone(),
                        folder: folder.clone(),
                        is_directory: kind.is_dir(),
                        seq,
                    },
                );
                drop(state);
                let depth = file
                    .strip_prefix(&root)
                    .map(|rel| rel.components().count())
                    .unwrap_or(usize::MAX);
                if recursive
                    && kind.is_dir()
                    && depth < self.options.max_depth
                    && queue.len() < self.options.max_directories
                {
                    queue.push(file);
                }
            }
        }
    }

    fn update(&self) {
        let (changed, reconcile) = {
            let mut pending = lock(&self.pending);
            (
                std::mem::take(&mut pending.directories),
                std::mem::take(&mut pending.reconcile),
            )
        };
        for directory in changed {
            if reconcile.contains(&directory) {
                lock(&self.state)
                    .entries
                    .retain(|file, _| !is_inside(file, &directory));
                self.walk(&directory, true);
                continue;
            }
            let previous: HashSet<PathBuf> = {
                let mut state = lock(&self.state);
                let previous = state
                    .entries
                    .iter()
                    .filter(|(file, entry)| {
                        entry.is_directory && file.parent() == Some(directory.as_path())
                    })
                    .map(|(file, _)| file.clone())
                    .collect();
                state
                    .entries
                    .retain(|file, _| file.parent() != Some(directory.as_path()));
                previous
            };
            self.walk(&directory, false);
            {
                let mut state = lock(&self.state);
                for removed in &previous {
                    if !state.entries.contains_key(removed) {
                        state.entries.retain(|file, _| !is_inside(file, removed));
                    }
                }
            }
            // Existing children remain indexed. Only discover newly created directories.
            let created: Vec<PathBuf> = lock(&self.state)
                .entries
                .iter()
                .filter(|(file, entry)| {
                    entry.is_directory
                        && file.parent() == Some(directory.as_path())
                        && !previous.contains(*file)
                })
                .map(|(file, _)| file.clone())
                .collect();
            for directory in created {
                self.walk(&directory, true);
            }
        }
    }
}

impl LocalSearchIndex {
    pub fn new(home: &Path, options: IndexOptions) -> Self {
        let mut options = options;
        let mut seen = HashSet::new();
        options.roots = options
            .roots
            .iter()
            .map(|root| habibi_platform::fsutil::resolve(root))
            .filter(|root| seen.insert(root.clone()))
            .collect();
        Self {
            inner: Arc::new(Inner {
                home: home.to_path_buf(),
                options,
                state: Mutex::new(State::default()),
                pending: Mutex::new(Pending::default()),
                initialized: tokio::sync::OnceCell::new(),
                work: tokio::sync::Mutex::new(()),
                watchers: Mutex::new(Vec::new()),
                runtime: Mutex::new(None),
            }),
        }
    }

    /// Report a change in `root` from the filesystem watcher. `file` is
    /// `None` when coalesced notifications omitted the path: the root is then
    /// reconciled once instead of losing the change.
    pub fn notify(&self, root: &Path, file: Option<&Path>) {
        let inner = &self.inner;
        match file {
            None => {
                lock(&inner.pending).reconcile.insert(root.to_path_buf());
                self.schedule(root.to_path_buf());
            }
            Some(file) => {
                if inner.allowed(file) {
                    let directory = if file == root {
                        root.to_path_buf()
                    } else {
                        file.parent()
                            .map(Path::to_path_buf)
                            .unwrap_or_else(|| root.to_path_buf())
                    };
                    self.schedule(directory);
                }
            }
        }
    }

    fn schedule(&self, directory: PathBuf) {
        let inner = &self.inner;
        if lock(&inner.state).closed || !inner.allowed(&directory) {
            return;
        }
        let generation = {
            let mut pending = lock(&inner.pending);
            // Coalesce event bursts and parent/child changes. Bound the event queue too.
            if pending
                .directories
                .iter()
                .any(|parent| directory.starts_with(parent))
            {
                return;
            }
            pending
                .directories
                .retain(|child| !is_inside(child, &directory));
            if pending.directories.len() >= 64 {
                return;
            }
            pending.directories.push(directory);
            pending.generation += 1;
            pending.generation
        };
        let Some(runtime) = lock(&inner.runtime).clone() else {
            return;
        };
        let index = self.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(750)).await;
            if lock(&index.inner.pending).generation != generation {
                return;
            }
            let _work = index.inner.work.lock().await;
            let inner = index.inner.clone();
            let _ = tokio::task::spawn_blocking(move || inner.update()).await;
        });
    }

    fn start_watcher(&self, root: &Path) {
        use notify::{RecursiveMode, Watcher};
        let index = self.clone();
        let configured = root.to_path_buf();
        let real_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if event.need_rescan() || event.paths.is_empty() {
                index.notify(&configured, None);
                return;
            }
            for notified in &event.paths {
                // macOS can report canonical /private paths for roots reached
                // through /var aliases. Keep entries under the configured root.
                let file = match notified.strip_prefix(&real_root) {
                    Ok(relative) if relative.as_os_str().is_empty() => configured.clone(),
                    Ok(relative) => configured.join(relative),
                    Err(_) => notified.clone(),
                };
                index.notify(&configured, Some(&file));
            }
        });
        // Unsupported watch hosts can use explicit refresh. No polling fallback.
        if let Ok(mut watcher) = watcher
            && watcher.watch(root, RecursiveMode::Recursive).is_ok()
        {
            lock(&self.inner.watchers).push(watcher);
        }
    }

    /// Build the index once; concurrent callers share the same build.
    pub async fn ready(&self) {
        let index = self.clone();
        self.inner
            .initialized
            .get_or_init(|| async move {
                *lock(&index.inner.runtime) = tokio::runtime::Handle::try_current().ok();
                lock(&index.inner.state).indexing = true;
                for root in index.inner.options.roots.clone() {
                    if lock(&index.inner.state).closed {
                        break;
                    }
                    let unavailable = |index: &LocalSearchIndex| {
                        lock(&index.inner.state)
                            .unavailable_roots
                            .push(crate::util::base_name(&root))
                    };
                    match std::fs::symlink_metadata(&root) {
                        Ok(metadata) if metadata.is_dir() => {}
                        Ok(_) => continue,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(_) => {
                            unavailable(&index);
                            continue;
                        }
                    }
                    if index.inner.options.watch {
                        index.start_watcher(&root);
                    }
                    if let Err(error) = std::fs::read_dir(&root) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            unavailable(&index);
                        }
                        continue;
                    }
                    let inner = index.inner.clone();
                    let walked = root.clone();
                    let _ = tokio::task::spawn_blocking(move || inner.walk(&walked, true)).await;
                }
                lock(&index.inner.state).indexing = false;
            })
            .await;
    }

    pub async fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        self.ready().await;
        let needle = normalize(&crate::util::utf16_slice(query, 160))
            .trim()
            .to_string();
        let tokens: Vec<&str> = needle
            .split(|c: char| c.is_whitespace() || matches!(c, '.' | '_' | '-'))
            .filter(|t| !t.is_empty())
            .take(8)
            .collect();
        let state = lock(&self.inner.state);
        if needle.chars().count() < 2 || tokens.is_empty() || state.closed {
            return Vec::new();
        }
        let count = limit.clamp(1, 50);
        let mut best: Vec<(f64, u64, &PathBuf, &Entry)> = Vec::new();
        for (path, entry) in &state.entries {
            if !tokens.iter().all(|token| entry.lower.contains(token)) {
                continue;
            }
            let stem = match entry.lower.rfind('.') {
                Some(index)
                    if !entry.lower[index + 1..].is_empty()
                        && !entry.lower[index + 1..].contains('.') =>
                {
                    &entry.lower[..index]
                }
                _ => entry.lower.as_str(),
            };
            let score = if entry.lower == needle || stem == needle {
                100.0
            } else if entry.lower.starts_with(&needle) {
                80.0
            } else {
                40.0 - crate::util::utf16_len(&entry.name) as f64 / 100.0
            };
            best.push((score, entry.seq, path, entry));
        }
        best.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        best.truncate(count);
        best.into_iter()
            .map(|(score, _, path, entry)| SearchHit {
                path: path.to_string_lossy().into_owned(),
                name: entry.name.clone(),
                directory: entry.directory.clone(),
                folder: entry.folder.clone(),
                score,
            })
            .collect()
    }

    /// `{ indexed, indexing, truncated, unavailableRoots, roots, watchers }`.
    pub fn status(&self) -> Value {
        let state = lock(&self.inner.state);
        json!({
            "indexed": state.entries.len(),
            "indexing": state.indexing,
            "truncated": state.truncated,
            "unavailableRoots": state.unavailable_roots,
            "roots": self.inner.options.roots.iter().map(|root| crate::util::base_name(root)).collect::<Vec<_>>(),
            "watchers": lock(&self.inner.watchers).len(),
        })
    }

    /// Rebuild from scratch (`/api/search/refresh`).
    pub async fn refresh(&self) {
        if !self.inner.initialized.initialized() {
            return self.ready().await;
        }
        self.ready().await;
        let _work = self.inner.work.lock().await;
        let inner = self.inner.clone();
        let _ = tokio::task::spawn_blocking(move || {
            {
                let mut state = lock(&inner.state);
                state.entries.clear();
                state.truncated = false;
            }
            for root in inner.options.roots.clone() {
                inner.walk(&root, true);
            }
        })
        .await;
    }

    pub fn close(&self) {
        let mut state = lock(&self.inner.state);
        state.closed = true;
        state.entries.clear();
        drop(state);
        let mut pending = lock(&self.inner.pending);
        pending.directories.clear();
        pending.reconcile.clear();
        pending.generation += 1;
        drop(pending);
        lock(&self.inner.watchers).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(root: &Path) -> IndexOptions {
        IndexOptions {
            roots: vec![root.to_path_buf()],
            max_entries: 30_000,
            max_directories: 4_000,
            max_depth: 8,
            watch: false,
        }
    }

    fn fixture(configure: impl FnOnce(&mut IndexOptions)) -> (tempfile::TempDir, LocalSearchIndex) {
        let root = tempfile::tempdir().unwrap();
        let mut options = options(root.path());
        configure(&mut options);
        let index = LocalSearchIndex::new(Path::new("/nonexistent-home"), options);
        (root, index)
    }

    async fn eventually(index: &LocalSearchIndex, query: &str, count: usize, seconds: u64) {
        let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
        while std::time::Instant::now() < deadline {
            if index.search(query, 12).await.len() == count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(index.search(query, 12).await.len(), count, "{query}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn filename_indexing_is_recursive_unicode_aware_and_excludes_hidden_generated_symlink_trees()
     {
        let (root, index) = fixture(|_| {});
        for dir in ["notes", "node_modules", ".secrets", "Example.app"] {
            std::fs::create_dir(root.path().join(dir)).unwrap();
            std::fs::write(
                root.path().join(dir).join("Café design.md"),
                "content is not indexed",
            )
            .unwrap();
        }
        std::os::unix::fs::symlink(root.path().join("notes"), root.path().join("alias")).unwrap();
        let results = index.search("cafe design", 12).await;
        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].path,
            root.path()
                .join("notes")
                .join("Café design.md")
                .to_string_lossy()
        );
        assert!(index.search("content is not indexed", 12).await.is_empty());
        assert_eq!(index.status()["watchers"], 0);
        index.close();
    }

    #[tokio::test]
    async fn concurrent_cold_queries_share_one_index_and_ranked_results_retain_duplicate_filenames()
    {
        let (root, index) = fixture(|_| {});
        std::fs::create_dir(root.path().join("nested")).unwrap();
        std::fs::write(root.path().join("brief.md"), "").unwrap();
        std::fs::write(root.path().join("nested").join("brief.md"), "").unwrap();
        std::fs::write(root.path().join("brief-final.md"), "").unwrap();
        let (left, right) = tokio::join!(index.search("brief", 12), index.search("brief", 12));
        assert_eq!(left.len(), 3);
        assert_eq!(left[0].name, "brief.md");
        assert_eq!(left, right);
        assert_eq!(index.status()["indexed"], 4);
    }

    #[tokio::test]
    async fn entry_and_directory_budgets_are_enforced_with_explicit_truncation_and_refresh() {
        let (root, index) = fixture(|options| options.max_entries = 5);
        for i in 0..20 {
            std::fs::write(root.path().join(format!("file-{i}.txt")), "").unwrap();
        }
        index.ready().await;
        assert_eq!(index.status()["indexed"], 5);
        assert_eq!(index.status()["truncated"], true);
        let first = index.search("file", 12).await.remove(0);
        std::fs::remove_file(root.path().join(first.name)).unwrap();
        index.refresh().await;
        assert_eq!(index.status()["indexed"], 5);
        let prefix = root.path().to_string_lossy().into_owned();
        assert!(
            index
                .search("file", 12)
                .await
                .iter()
                .all(|item| item.path.starts_with(&prefix))
        );
    }

    #[tokio::test]
    async fn warm_queries_perform_no_filesystem_reads_and_preserve_deterministic_ranking() {
        let (root, index) = fixture(|_| {});
        std::fs::write(root.path().join("invoice.pdf"), "").unwrap();
        index.ready().await;
        std::fs::remove_file(root.path().join("invoice.pdf")).unwrap();
        // The disabled watcher deliberately leaves a snapshot. Searching never stats or rescans it.
        assert_eq!(index.search("invoice", 12).await[0].name, "invoice.pdf");
        index.refresh().await;
        assert!(index.search("invoice", 12).await.is_empty());
    }

    #[tokio::test]
    async fn coalesced_notifications_without_filenames_reconcile_added_and_removed_trees() {
        let (root, index) = fixture(|_| {});
        let directory = root.path().join("new-directory");
        std::fs::create_dir(&directory).unwrap();
        index.ready().await;
        std::fs::write(directory.join("coalesced.txt"), "").unwrap();
        index.notify(root.path(), None);
        eventually(&index, "coalesced", 1, 5).await;
        std::fs::remove_dir_all(&directory).unwrap();
        index.notify(root.path(), None);
        eventually(&index, "coalesced", 0, 5).await;
    }

    #[tokio::test]
    async fn targeted_notifications_add_rename_and_remove_files() {
        let (root, index) = fixture(|_| {});
        index.ready().await;
        let directory = root.path().join("new-directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("alpha.txt"), "").unwrap();
        index.notify(root.path(), Some(&directory));
        eventually(&index, "alpha", 1, 5).await;
        std::fs::rename(directory.join("alpha.txt"), directory.join("beta.txt")).unwrap();
        index.notify(root.path(), Some(&directory.join("beta.txt")));
        eventually(&index, "beta", 1, 5).await;
        assert!(index.search("alpha", 12).await.is_empty());
        std::fs::remove_dir_all(&directory).unwrap();
        index.notify(root.path(), Some(&directory));
        eventually(&index, "beta", 0, 5).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn filesystem_notifications_update_the_index_without_a_periodic_scanner() {
        let (root, index) = fixture(|options| options.watch = true);
        index.ready().await;
        if index.status()["watchers"] == 0 {
            return; // recursive filesystem notifications unavailable
        }
        let directory = root.path().join("new-directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("alpha.txt"), "").unwrap();
        // FSEvents delivery is deferred on busy hosts. This is a test-only
        // deadline; the index still updates exclusively from notifications.
        eventually(&index, "alpha", 1, 20).await;
        std::fs::rename(directory.join("alpha.txt"), directory.join("beta.txt")).unwrap();
        eventually(&index, "beta", 1, 20).await;
        std::fs::remove_dir_all(&directory).unwrap();
        eventually(&index, "beta", 0, 20).await;
        index.close();
    }
}
