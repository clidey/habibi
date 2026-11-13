//! Recently opened files: a bounded metadata index; original documents are
//! never copied or scanned. Ported from `src/server/services/recent-files.ts`
//! and `recent-files-router.ts`. State: `.habibi/recent/files.json`.

use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use habibi_core::services::RecentFiles;
use habibi_core::{ApiRequest, ApiResponse, Method};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::util::{js_date_parse, now_iso};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub id: String,
    pub path: String,
    pub name: String,
    /// `file` or `folder`.
    pub kind: String,
    pub size: u64,
    pub opened_at: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentListItem {
    #[serde(flatten)]
    pub file: RecentFile,
    pub available: bool,
}

#[derive(Debug)]
pub struct RecentError(pub &'static str);

pub struct RecentStore {
    directory: PathBuf,
    file: PathBuf,
    home: PathBuf,
    lock: Mutex<()>,
}

const PRIVATE_PARTS: &[&str] = &[".habibi", ".openwa", ".ssh", ".aws", ".gnupg"];

fn valid_item(item: &Value) -> bool {
    static ID: OnceLock<Regex> = OnceLock::new();
    let id = ID.get_or_init(|| Regex::new(r"^[a-f0-9]{32}$").expect("valid pattern"));
    let text = |key: &str| item.get(key).and_then(Value::as_str);
    text("id").is_some_and(|value| id.is_match(value))
        && item
            .get("size")
            .and_then(Value::as_u64)
            .is_some_and(|size| size <= 9_007_199_254_740_991)
        && text("path").is_some_and(|path| Path::new(path).is_absolute())
        && text("name").is_some()
        && matches!(text("kind"), Some("file" | "folder"))
        && item.get("pinned").is_some_and(Value::is_boolean)
        && text("openedAt").and_then(js_date_parse).is_some()
}

fn sort(items: &mut [RecentFile]) {
    items.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.opened_at.cmp(&a.opened_at))
    });
}

impl RecentStore {
    pub fn new(state_root: &Path, home: &Path) -> Self {
        let directory = state_root.join(".habibi").join("recent");
        Self {
            file: directory.join("files.json"),
            directory,
            home: home.to_path_buf(),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Vec<RecentFile>, RecentError> {
        const UNREADABLE: RecentError = RecentError("Could not read recent files.");
        let metadata = match std::fs::metadata(&self.file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(UNREADABLE),
        };
        if metadata.len() > 512 * 1024 {
            return Err(UNREADABLE);
        }
        let text = std::fs::read_to_string(&self.file).map_err(|_| UNREADABLE)?;
        let value: Value = serde_json::from_str(&text).map_err(|_| UNREADABLE)?;
        let items = value.as_array().ok_or(UNREADABLE)?;
        if items.len() > 100 || !items.iter().all(valid_item) {
            return Err(UNREADABLE);
        }
        serde_json::from_value(value).map_err(|_| UNREADABLE)
    }

    fn write(&self, items: &[RecentFile]) -> Result<(), RecentError> {
        let bytes =
            serde_json::to_vec(items).map_err(|_| RecentError("Could not save recent files."))?;
        habibi_platform::fsutil::write_private_atomic(&self.directory, "files.json", &bytes, false)
            .map_err(|_| RecentError("Could not save recent files."))
    }

    fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Vec<RecentFile>) -> Result<T, RecentError>,
    ) -> Result<T, RecentError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut items = self.read()?;
        let result = change(&mut items)?;
        self.write(&items)?;
        Ok(result)
    }

    /// The real path when `value` is an existing file or folder inside home
    /// and outside Habibi's own data and the usual credential folders.
    fn approved_path(&self, value: &str) -> Option<(PathBuf, Metadata)> {
        let candidate = Path::new(value);
        if !candidate.is_absolute()
            || value.len() > 4096
            || value.contains('\0')
            || self.home.as_os_str().is_empty()
        {
            return None;
        }
        let target = std::fs::canonicalize(candidate).ok()?;
        let base = std::fs::canonicalize(&self.home).ok()?;
        let relative = target.strip_prefix(&base).ok()?;
        if relative.as_os_str().is_empty() {
            return None;
        }
        let private = relative.components().any(|part| {
            let part = part.as_os_str().to_string_lossy();
            PRIVATE_PARTS.contains(&part.as_ref()) || part == ".env" || part.starts_with(".env.")
        });
        if private {
            return None;
        }
        let metadata = std::fs::metadata(&target).ok()?;
        (metadata.is_file() || metadata.is_dir()).then_some((target, metadata))
    }

    pub fn record_path(&self, value: &str) -> Result<(), RecentError> {
        let Some((target, metadata)) = self.approved_path(value) else {
            return Ok(());
        };
        let path = target.to_string_lossy().into_owned();
        let id: String = Sha256::digest(path.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..32]
            .to_string();
        self.mutate(|items| {
            let pinned = items
                .iter()
                .find(|item| item.id == id)
                .is_some_and(|item| item.pinned);
            let item = RecentFile {
                id: id.clone(),
                name: crate::util::base_name(&target),
                path,
                kind: if metadata.is_dir() { "folder" } else { "file" }.into(),
                size: metadata.len(),
                opened_at: now_iso(),
                pinned,
            };
            items.retain(|entry| entry.id != id);
            items.insert(0, item);
            sort(items);
            items.truncate(100);
            Ok(())
        })
    }

    pub fn list(&self) -> Result<Vec<RecentListItem>, RecentError> {
        let mut items = {
            let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            self.read()?
        };
        sort(&mut items);
        Ok(items
            .into_iter()
            .map(|file| RecentListItem {
                available: self.approved_path(&file.path).is_some(),
                file,
            })
            .collect())
    }

    pub fn update(&self, id: Option<&Value>, pinned: Option<&Value>) -> Result<(), RecentError> {
        self.mutate(|items| {
            let pin_count = items.iter().filter(|entry| entry.pinned).count();
            let item = items
                .iter_mut()
                .find(|entry| id.and_then(Value::as_str) == Some(entry.id.as_str()))
                .ok_or(RecentError("Choose an existing item."))?;
            let Some(pinned) = pinned.and_then(Value::as_bool) else {
                return Err(RecentError("Choose an existing item."));
            };
            if pinned && pin_count >= 20 && !item.pinned {
                return Err(RecentError("You can pin up to 20 files."));
            }
            item.pinned = pinned;
            Ok(())
        })
    }

    /// Remove one item, or everything when `id` is absent.
    pub fn remove(&self, id: Option<&Value>) -> Result<(), RecentError> {
        self.mutate(|items| {
            match id {
                None => items.clear(),
                Some(id) => {
                    if let Some(index) = items
                        .iter()
                        .position(|item| id.as_str() == Some(item.id.as_str()))
                    {
                        items.remove(index);
                    }
                }
            }
            Ok(())
        })
    }
}

/// Fire-and-forget recording for other services (`record(...).catch(() => {})`).
pub struct RecentRecorder(pub Arc<RecentStore>);

impl RecentFiles for RecentRecorder {
    fn record(&self, target: &str) {
        let store = self.0.clone();
        let target = target.to_string();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn_blocking(move || {
                    let _ = store.record_path(&target);
                });
            }
            Err(_) => {
                let _ = store.record_path(&target);
            }
        }
    }
}

/// `/api/recent-files`: GET lists; POST `{action:'record',path}`, PATCH
/// `{id,pinned}` and DELETE `{id?}` change it. Errors are a fixed 400.
pub async fn handle(store: &Arc<RecentStore>, request: &ApiRequest) -> Option<ApiResponse> {
    if request.path != "/api/recent-files" {
        return None;
    }
    let failure = || {
        ApiResponse::json(&json!({ "ok": false, "error": "Could not update recent files." }))
            .with_status(400)
    };
    if request.method == Method::Get {
        let store = store.clone();
        return Some(
            match tokio::task::spawn_blocking(move || store.list()).await {
                Ok(Ok(items)) => ApiResponse::json(&json!({ "ok": true, "items": items })),
                _ => failure(),
            },
        );
    }
    if request.body.len() > 8192 {
        return Some(failure());
    }
    let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(&request.body) else {
        return Some(failure());
    };
    let store = store.clone();
    let method = request.method;
    let result = tokio::task::spawn_blocking(move || match method {
        Method::Post if value.get("action").and_then(Value::as_str) == Some("record") => {
            match value.get("path") {
                Some(Value::String(path)) => store.record_path(path),
                _ => Ok(()),
            }
        }
        Method::Patch => store.update(value.get("id"), value.get("pinned")),
        Method::Delete => store.remove(value.get("id")),
        _ => Err(RecentError("")),
    })
    .await;
    Some(match result {
        Ok(Ok(())) => ApiResponse::json(&json!({ "ok": true })),
        _ => failure(),
    })
}

pub(crate) trait WithStatus {
    fn with_status(self, status: u16) -> Self;
}

impl WithStatus for ApiResponse {
    fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn recent_files_deduplicate_pin_survive_reload_and_reject_paths_outside_home_or_private_app_data()
     {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let doc = home.join("plan.txt");
        std::fs::write(&doc, "Fictional document").unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "Outside").unwrap();
        std::os::unix::fs::symlink(&outside, home.join("escape.txt")).unwrap();
        let store = Arc::new(RecentStore::new(root.path(), &home));
        let doc_text = doc.to_string_lossy().into_owned();
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let store = store.clone();
                let doc = doc_text.clone();
                std::thread::spawn(move || store.record_path(&doc).unwrap())
            })
            .collect();
        threads
            .into_iter()
            .for_each(|thread| thread.join().unwrap());
        assert_eq!(store.list().unwrap().len(), 1);
        let item = store.list().unwrap().remove(0);
        store
            .update(Some(&json!(item.file.id)), Some(&json!(true)))
            .unwrap();
        assert!(
            RecentStore::new(root.path(), &home).list().unwrap()[0]
                .file
                .pinned
        );
        store
            .record_path(&home.join("escape.txt").to_string_lossy())
            .unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        std::fs::create_dir(home.join(".habibi")).unwrap();
        std::fs::write(home.join(".habibi/token"), "not a secret").unwrap();
        store
            .record_path(&home.join(".habibi/token").to_string_lossy())
            .unwrap();
        store.record_path("relative/path").unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        std::fs::remove_file(&doc).unwrap();
        assert!(!store.list().unwrap()[0].available);
        let mode = std::fs::metadata(root.path().join(".habibi/recent/files.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        assert!(
            store
                .update(Some(&json!("missing")), Some(&json!(true)))
                .is_err()
        );
        store.remove(None).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn corrupt_history_is_an_error_not_a_reset() {
        let root = tempfile::tempdir().unwrap();
        let store = RecentStore::new(root.path(), root.path());
        std::fs::create_dir_all(root.path().join(".habibi/recent")).unwrap();
        std::fs::write(
            root.path().join(".habibi/recent/files.json"),
            r#"[{"id":"x"}]"#,
        )
        .unwrap();
        assert!(store.list().is_err());
        assert!(store.remove(None).is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join(".habibi/recent/files.json")).unwrap(),
            r#"[{"id":"x"}]"#
        );
    }
}
