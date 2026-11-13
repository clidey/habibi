//! Local notes: atomic, private storage. Serial writes plus per-note
//! revisions prevent lost edits. Ported from
//! `src/server/services/notes-store.ts` and `notes-router.ts`.
//! State: `.habibi/notes/library.json` (same shape; unknown fields are kept).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use habibi_core::{ApiRequest, ApiResponse, Method};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::recent::WithStatus;
use crate::util::{js_date_parse, now_iso, utf16_len};

#[derive(Debug, Clone, PartialEq)]
pub struct NotesError {
    pub message: String,
    pub status: u16,
}

impl NotesError {
    fn new(message: &str) -> Self {
        Self {
            message: message.into(),
            status: 400,
        }
    }

    fn status(message: &str, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

type Result<T> = std::result::Result<T, NotesError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    /// Legacy page emoji, retained for existing libraries.
    pub emoji: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub revision: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesLibrary {
    pub version: u8,
    pub notes: Vec<Note>,
    pub folders: Vec<NoteFolder>,
    /// Manual page order, created when the user first organizes pages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_order: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl NotesLibrary {
    fn empty() -> Self {
        Self {
            version: 1,
            notes: Vec::new(),
            folders: Vec::new(),
            note_order: None,
            extra: Map::new(),
        }
    }

    fn to_object(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        }
    }
}

const MAXIMUM_BYTES: u64 = 24 * 1024 * 1024;
const RECOVERY: &str = "The notes library needs recovery. Your file has not been changed.";
const UNREADABLE: &str = "The notes library could not be read. Your file has not been changed.";
const STRUCTURE: &str = "The folder structure is invalid. Your file has not been changed.";

fn id_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)^[a-f0-9-]{36}$").expect("valid pattern"))
}

fn icon_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]{0,79}$").expect("valid pattern"))
}

fn icon_name(value: &Value) -> Result<String> {
    match value {
        Value::String(text) if icon_pattern().is_match(text) => Ok(text.clone()),
        _ => Err(NotesError::new("Choose a valid page icon.")),
    }
}

fn object(value: &Value) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| NotesError::new("Invalid note data."))
}

/// `text(value, limit, fallback)`: absent → fallback; otherwise a string of
/// at most `limit` UTF-16 units without NUL.
fn text(value: Option<&Value>, limit: usize, fallback: &str) -> Result<String> {
    match value {
        None => Ok(fallback.into()),
        Some(Value::String(text)) if utf16_len(text) <= limit && !text.contains('\0') => {
            Ok(text.clone())
        }
        _ => Err(NotesError::new("A note field is invalid or too long.")),
    }
}

/// JS `trim()`.
fn trim(value: &str) -> String {
    value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_string()
}

fn folder_target(value: Option<&Value>, folders: &[NoteFolder]) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if id.is_empty() => Ok(None),
        Some(Value::String(id)) if folders.iter().any(|folder| &folder.id == id) => {
            Ok(Some(id.clone()))
        }
        _ => Err(NotesError::new("Choose an existing folder.")),
    }
}

fn depth_of(parent: Option<&str>, folders: &[NoteFolder]) -> usize {
    let mut depth = 1;
    let mut parent = parent.map(str::to_string);
    while let Some(id) = parent {
        depth += 1;
        if depth > 64 {
            break;
        }
        parent = folders
            .iter()
            .find(|item| item.id == id)
            .and_then(|item| item.parent_id.clone())
            .filter(|p| !p.is_empty());
    }
    depth
}

fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

fn is_date(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(js_date_parse)
        .is_some()
}

/// Validate untrusted library JSON exactly as the Node store did, with the
/// same user-facing messages, before deserializing it.
fn validate_library(value: Value) -> Result<NotesLibrary> {
    let unreadable = || NotesError::status(UNREADABLE, 500);
    let recovery = || NotesError::status(RECOVERY, 500);
    let structure = || NotesError::status(STRUCTURE, 500);
    let data = value
        .as_object()
        .ok_or_else(|| NotesError::new("Invalid note data."))?;
    let (Some(notes), Some(folders)) = (
        data.get("notes").and_then(Value::as_array),
        data.get("folders").and_then(Value::as_array),
    ) else {
        return Err(unreadable());
    };
    if data.get("version").and_then(Value::as_f64) != Some(1.0)
        || notes.len() > 5000
        || folders.len() > 500
    {
        return Err(unreadable());
    }
    let mut ids = HashSet::new();
    let mut folder_ids = HashSet::new();
    for folder in folders {
        let id = folder.get("id").and_then(Value::as_str);
        let name = folder.get("name").and_then(Value::as_str);
        let (Some(id), Some(name)) = (id, name) else {
            return Err(recovery());
        };
        if !id_pattern().is_match(id)
            || ids.contains(id)
            || trim(name).is_empty()
            || utf16_len(name) > 100
        {
            return Err(recovery());
        }
        ids.insert(id.to_string());
        folder_ids.insert(id.to_string());
    }
    for folder in folders {
        let mut visited = HashSet::from([folder["id"].as_str().unwrap_or_default().to_string()]);
        let mut parent = folder
            .get("parentId")
            .cloned()
            .unwrap_or(Value::Bool(false));
        while !parent.is_null() {
            let Some(id) = parent.as_str() else {
                return Err(structure());
            };
            if visited.contains(id) || visited.len() > 32 {
                return Err(structure());
            }
            visited.insert(id.to_string());
            let next = folders
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                .ok_or_else(structure)?;
            parent = next.get("parentId").cloned().unwrap_or(Value::Bool(false));
        }
    }
    for note in notes {
        let field = |key: &str| note.get(key);
        let string = |key: &str| field(key).and_then(Value::as_str);
        let valid = string("id").is_some_and(|id| id_pattern().is_match(id) && !ids.contains(id))
            && string("title").is_some_and(|title| utf16_len(title) <= 200)
            && string("body").is_some_and(|body| utf16_len(body) <= 262_144)
            && string("emoji").is_some_and(|emoji| utf16_len(emoji) <= 16)
            && field("icon").is_none_or(|icon| {
                icon.as_str()
                    .is_some_and(|icon| icon_pattern().is_match(icon))
            })
            && field("revision")
                .and_then(safe_integer)
                .is_some_and(|revision| revision >= 1)
            && is_date(field("createdAt"))
            && is_date(field("updatedAt"))
            && field("deletedAt")
                .is_some_and(|deleted| deleted.is_null() || is_date(Some(deleted)));
        if !valid {
            return Err(recovery());
        }
        match field("folderId") {
            None | Some(Value::Null) => {}
            Some(Value::String(id)) if id.is_empty() || folder_ids.contains(id) => {}
            _ => return Err(NotesError::new("Choose an existing folder.")),
        }
        ids.insert(string("id").unwrap_or_default().to_string());
    }
    if let Some(order) = data.get("noteOrder") {
        let note_ids: HashSet<&str> = notes
            .iter()
            .filter_map(|note| note.get("id").and_then(Value::as_str))
            .collect();
        let valid = order.as_array().is_some_and(|order| {
            let unique: HashSet<&str> = order.iter().filter_map(Value::as_str).collect();
            order.len() <= notes.len()
                && unique.len() == order.len()
                && order
                    .iter()
                    .all(|id| id.as_str().is_some_and(|id| note_ids.contains(id)))
        });
        if !valid {
            return Err(NotesError::status(
                "The notes library order is invalid. Your file has not been changed.",
                500,
            ));
        }
    }
    serde_json::from_value(value).map_err(|_| recovery())
}

pub struct NotesStore {
    directory: PathBuf,
    file: PathBuf,
    lock: Mutex<()>,
}

impl NotesStore {
    pub fn new(state_root: &Path) -> Self {
        let directory = state_root.join(".habibi").join("notes");
        Self {
            file: directory.join("library.json"),
            directory,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<NotesLibrary> {
        let unreadable = || NotesError::status(UNREADABLE, 500);
        let metadata = match std::fs::symlink_metadata(&self.file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(NotesLibrary::empty());
            }
            Err(_) => return Err(unreadable()),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAXIMUM_BYTES
        {
            return Err(unreadable());
        }
        let text = std::fs::read_to_string(&self.file).map_err(|_| unreadable())?;
        let value: Value = serde_json::from_str(&text).map_err(|_| unreadable())?;
        validate_library(value)
    }

    fn mutate<T>(&self, change: impl FnOnce(&mut NotesLibrary) -> Result<T>) -> Result<T> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut library = self.read()?;
        let result = change(&mut library)?;
        let serialized = serde_json::to_vec(&library).map_err(|_| {
            NotesError::status(
                "Could not save this note. Your previous library is unchanged.",
                500,
            )
        })?;
        if serialized.len() as u64 > MAXIMUM_BYTES {
            return Err(NotesError::new(
                "The notes library is full. Export notes before adding more.",
            ));
        }
        habibi_platform::fsutil::write_private_atomic(
            &self.directory,
            "library.json",
            &serialized,
            true,
        )
        .map_err(|_| {
            NotesError::status(
                "Could not save this note. Your previous library is unchanged.",
                500,
            )
        })?;
        Ok(result)
    }

    fn existing<'a>(
        library: &'a mut NotesLibrary,
        id: &str,
        revision: Option<&Value>,
    ) -> Result<&'a mut Note> {
        let note = library
            .notes
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| NotesError::status("This note no longer exists.", 404))?;
        if revision.and_then(Value::as_f64) != Some(note.revision as f64) {
            return Err(NotesError::status(
                "This note changed elsewhere. Copy your draft before reloading it.",
                409,
            ));
        }
        Ok(note)
    }

    pub fn list(&self) -> Result<NotesLibrary> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read()
    }

    pub fn create(&self, value: &Value) -> Result<Note> {
        let data = object(value)?;
        self.mutate(|library| {
            if library.notes.len() >= 5000 {
                return Err(NotesError::new("The notes library is full."));
            }
            let now = now_iso();
            let title = trim(&text(data.get("title"), 200, "Untitled")?);
            let note = Note {
                id: uuid::Uuid::new_v4().to_string(),
                title: if title.is_empty() {
                    "Untitled".into()
                } else {
                    title
                },
                body: text(data.get("body"), 262_144, "")?,
                emoji: text(data.get("emoji"), 16, "📝")?,
                icon: data.get("icon").map(icon_name).transpose()?,
                folder_id: folder_target(data.get("folderId"), &library.folders)?,
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
                revision: 1,
                extra: Map::new(),
            };
            library.notes.push(note.clone());
            if let Some(order) = library.note_order.as_mut() {
                order.insert(0, note.id.clone());
            }
            Ok(note)
        })
    }

    pub fn update(&self, id: &str, value: &Value) -> Result<Note> {
        let data = object(value)?;
        self.mutate(|library| {
            let folders = library.folders.clone();
            let note = Self::existing(library, id, data.get("revision"))?;
            if note.deleted_at.is_some() {
                return Err(NotesError::new("Restore this note before editing it."));
            }
            if data.contains_key("title") {
                let title = trim(&text(data.get("title"), 200, "")?);
                note.title = if title.is_empty() {
                    "Untitled".into()
                } else {
                    title
                };
            }
            if data.contains_key("body") {
                note.body = text(data.get("body"), 262_144, "")?;
            }
            if let Some(icon) = data.get("icon") {
                note.icon = Some(icon_name(icon)?);
            }
            if data.contains_key("emoji") {
                note.emoji = text(data.get("emoji"), 16, "")?;
            }
            if data.contains_key("folderId") {
                note.folder_id = folder_target(data.get("folderId"), &folders)?;
            }
            note.updated_at = now_iso();
            note.revision += 1;
            Ok(note.clone())
        })
    }

    pub fn organize(&self, value: &Value) -> Result<NotesLibrary> {
        let data = object(value)?;
        self.mutate(|library| {
            let refs = data
                .get("notes")
                .and_then(Value::as_array)
                .filter(|notes| !notes.is_empty() && notes.len() <= 100)
                .ok_or_else(|| NotesError::new("Choose up to 100 notes to organize."))?;
            let mut chosen: Vec<String> = Vec::new();
            for reference in refs {
                let reference = object(reference)?;
                let Some(id) = reference.get("id").and_then(Value::as_str) else {
                    return Err(NotesError::new("Choose existing notes."));
                };
                let note = Self::existing(library, id, reference.get("revision"))?;
                if note.deleted_at.is_some() {
                    return Err(NotesError::new("Restore notes before organizing them."));
                }
                chosen.push(note.id.clone());
            }
            let ids: HashSet<String> = chosen.iter().cloned().collect();
            if ids.len() != chosen.len() {
                return Err(NotesError::new("Choose each note once."));
            }
            let action = data.get("action").and_then(Value::as_str).unwrap_or("");
            let mut folder_id: Option<String> = None;
            match action {
                "group" => {
                    if chosen.len() < 2 {
                        return Err(NotesError::new("Choose at least two notes for a folder."));
                    }
                    if library.folders.len() >= 500 {
                        return Err(NotesError::new("The folder limit has been reached."));
                    }
                    let name = trim(&text(data.get("name"), 100, "")?);
                    if name.is_empty() {
                        return Err(NotesError::new("Give this folder a name."));
                    }
                    let parent_id = folder_target(data.get("folderId"), &library.folders)?;
                    if depth_of(parent_id.as_deref(), &library.folders) > 32 {
                        return Err(NotesError::new("Folders can be nested up to 32 levels."));
                    }
                    let folder = NoteFolder {
                        id: uuid::Uuid::new_v4().to_string(),
                        name,
                        parent_id,
                        extra: Map::new(),
                    };
                    folder_id = Some(folder.id.clone());
                    library.folders.push(folder);
                }
                "move" => folder_id = folder_target(data.get("folderId"), &library.folders)?,
                "reorder" => {}
                _ => return Err(NotesError::new("Choose a valid organization action.")),
            }
            let mut anchor: Option<(String, Option<String>)> = None;
            let after = data.get("position").and_then(Value::as_str) == Some("after");
            if action == "reorder" {
                let target = data.get("targetId").and_then(Value::as_str);
                let position = data.get("position").and_then(Value::as_str);
                let (Some(target), Some("before" | "after")) = (target, position) else {
                    return Err(NotesError::new(
                        "Choose a different page to reorder around.",
                    ));
                };
                if ids.contains(target) {
                    return Err(NotesError::new(
                        "Choose a different page to reorder around.",
                    ));
                }
                let found = library
                    .notes
                    .iter()
                    .find(|note| note.id == target && note.deleted_at.is_none())
                    .ok_or_else(|| NotesError::status("This page no longer exists.", 404))?;
                let anchor_folder = found.folder_id.clone();
                let same_collection = library
                    .notes
                    .iter()
                    .filter(|note| ids.contains(&note.id))
                    .all(|note| note.folder_id == anchor_folder);
                if !same_collection && data.get("folderId").and_then(Value::as_str) != Some("all") {
                    return Err(NotesError::new("Reorder pages in the same collection."));
                }
                anchor = Some((found.id.clone(), anchor_folder));
            }
            let base: Vec<String> = library.note_order.clone().unwrap_or_else(|| {
                let mut sorted: Vec<&Note> = library.notes.iter().collect();
                sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                sorted.into_iter().map(|note| note.id.clone()).collect()
            });
            let ordered: HashSet<&String> = base.iter().collect();
            let mut remaining: Vec<String> = base
                .iter()
                .filter(|id| !ids.contains(*id))
                .cloned()
                .collect();
            remaining.extend(
                library
                    .notes
                    .iter()
                    .filter(|note| !ordered.contains(&note.id) && !ids.contains(&note.id))
                    .map(|note| note.id.clone()),
            );
            let index = match &anchor {
                Some((anchor_id, _)) => {
                    // indexOf returns -1 when absent, so the insertion point is 0 or 1.
                    let position = remaining
                        .iter()
                        .position(|id| id == anchor_id)
                        .map(|i| i as isize)
                        .unwrap_or(-1);
                    (position + isize::from(after)).max(0) as usize
                }
                None => 0,
            };
            let index = index.min(remaining.len());
            for (offset, id) in chosen.iter().enumerate() {
                remaining.insert(index + offset, id.clone());
            }
            library.note_order = Some(remaining);
            for note in library
                .notes
                .iter_mut()
                .filter(|note| ids.contains(&note.id))
            {
                if action != "reorder" {
                    note.folder_id = folder_id.clone();
                }
                note.revision += 1;
            }
            Ok(library.clone())
        })
    }

    pub fn trash(&self, id: &str, revision: Option<&Value>, restore: bool) -> Result<Note> {
        self.mutate(|library| {
            let note = Self::existing(library, id, revision)?;
            note.deleted_at = if restore { None } else { Some(now_iso()) };
            note.updated_at = now_iso();
            note.revision += 1;
            Ok(note.clone())
        })
    }

    pub fn create_folder(&self, value: &Value) -> Result<NoteFolder> {
        let data = object(value)?;
        self.mutate(|library| {
            if library.folders.len() >= 500 {
                return Err(NotesError::new("The folder limit has been reached."));
            }
            let name = trim(&text(data.get("name"), 100, "")?);
            let parent_id = folder_target(data.get("parentId"), &library.folders)?;
            if name.is_empty() {
                return Err(NotesError::new("Give this folder a name."));
            }
            if depth_of(parent_id.as_deref(), &library.folders) > 32 {
                return Err(NotesError::new("Folders can be nested up to 32 levels."));
            }
            let folder = NoteFolder {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                parent_id,
                extra: Map::new(),
            };
            library.folders.push(folder.clone());
            Ok(folder)
        })
    }

    pub fn update_folder(&self, id: &str, value: &Value) -> Result<NoteFolder> {
        let data = object(value)?;
        self.mutate(|library| {
            let folder = library
                .folders
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| NotesError::status("This folder no longer exists.", 404))?;
            if data.contains_key("name") {
                let name = trim(&text(data.get("name"), 100, "")?);
                if name.is_empty() {
                    return Err(NotesError::new("Give this folder a name."));
                }
                folder.name = name;
            }
            Ok(folder.clone())
        })
    }

    pub fn remove_folder(&self, id: &str) -> Result<NotesLibrary> {
        self.mutate(|library| {
            let folder = library
                .folders
                .iter()
                .find(|item| item.id == id)
                .cloned()
                .ok_or_else(|| NotesError::status("This folder no longer exists.", 404))?;
            for note in library
                .notes
                .iter_mut()
                .filter(|note| note.folder_id.as_deref() == Some(id))
            {
                note.folder_id = folder.parent_id.clone();
                note.revision += 1;
            }
            for child in library
                .folders
                .iter_mut()
                .filter(|item| item.parent_id.as_deref() == Some(id))
            {
                child.parent_id = folder.parent_id.clone();
            }
            library.folders.retain(|item| item.id != id);
            Ok(library.clone())
        })
    }

    /// Launcher search: up to six matching notes with a short preview, never
    /// the complete body.
    pub fn search(&self, query: &str) -> Result<Vec<Value>> {
        let query: String = crate::util::utf16_slice(&trim(query).to_lowercase(), 200);
        if utf16_len(&query) < 2 {
            return Ok(Vec::new());
        }
        let library = self.list()?;
        let mut notes: Vec<&Note> = library
            .notes
            .iter()
            .filter(|note| {
                note.deleted_at.is_none()
                    && format!("{} {}", note.title, note.body)
                        .to_lowercase()
                        .contains(&query)
            })
            .collect();
        notes.sort_by(|a, b| {
            let title = |note: &Note| note.title.to_lowercase().contains(&query);
            title(b)
                .cmp(&title(a))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(notes
            .into_iter()
            .take(6)
            .map(|note| {
                let mut item = json!({
                    "id": note.id, "title": note.title, "emoji": note.emoji,
                    "preview": crate::note_preview::note_preview(&note.body), "updatedAt": note.updated_at,
                });
                if let Some(icon) = &note.icon {
                    item["icon"] = json!(icon);
                }
                item
            })
            .collect())
    }
}

fn body(request: &ApiRequest) -> Result<Value> {
    // The Node router also required `Content-Type: application/json` (415);
    // IPC requests carry no headers, and only the app's webview can send them.
    if request.body.len() > 1_048_576 {
        return Err(NotesError::status("This note is too large.", 413));
    }
    match serde_json::from_slice::<Value>(&request.body) {
        Ok(value @ Value::Object(_)) => Ok(value),
        _ => Err(NotesError::new("Invalid note data.")),
    }
}

fn reply(value: Value) -> ApiResponse {
    ApiResponse::json(&value)
}

fn spread(mut base: Map<String, Value>, library: &NotesLibrary) -> Value {
    base.extend(library.to_object());
    Value::Object(base)
}

fn ok() -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("ok".into(), json!(true));
    map
}

fn route(
    store: &NotesStore,
    method: Method,
    parts: &[String],
    query: &str,
    request: &ApiRequest,
) -> Result<Value> {
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    let not_found = || NotesError::status("Notes endpoint not found.", 404);
    match (parts.as_slice(), method) {
        (["search"], Method::Get) => Ok(json!({ "ok": true, "notes": store.search(query)? })),
        (["organize"], Method::Post) => Ok(spread(ok(), &store.organize(&body(request)?)?)),
        ([], Method::Get) => Ok(spread(ok(), &store.list()?)),
        ([], Method::Post) => Ok(json!({ "ok": true, "note": store.create(&body(request)?)? })),
        (["folders", rest @ ..], _) => match (rest, method) {
            ([], Method::Post) => {
                Ok(json!({ "ok": true, "folder": store.create_folder(&body(request)?)? }))
            }
            ([id], Method::Patch) => {
                Ok(json!({ "ok": true, "folder": store.update_folder(id, &body(request)?)? }))
            }
            ([id], Method::Delete) => Ok(spread(ok(), &store.remove_folder(id)?)),
            _ => Err(not_found()),
        },
        ([id], Method::Patch) => {
            Ok(json!({ "ok": true, "note": store.update(id, &body(request)?)? }))
        }
        ([id], Method::Delete) => {
            let data = body(request)?;
            Ok(json!({ "ok": true, "note": store.trash(id, data.get("revision"), false)? }))
        }
        ([id, "restore"], Method::Post) => {
            let data = body(request)?;
            Ok(json!({ "ok": true, "note": store.trash(id, data.get("revision"), true)? }))
        }
        _ => Err(not_found()),
    }
}

/// `/api/notes` and `/api/notes/*`.
pub async fn handle(store: &Arc<NotesStore>, request: &ApiRequest) -> Option<ApiResponse> {
    if request.path != "/api/notes" && !request.path.starts_with("/api/notes/") {
        return None;
    }
    let parts: Vec<String> = request
        .path
        .split('/')
        .filter(|part| !part.is_empty())
        .skip(2)
        .map(str::to_string)
        .collect();
    let query = request.query("q").unwrap_or("").to_string();
    let store = store.clone();
    let request = request.clone();
    let result = tokio::task::spawn_blocking(move || {
        route(&store, request.method, &parts, &query, &request)
    })
    .await;
    Some(match result {
        Ok(Ok(value)) => reply(value),
        Ok(Err(error)) => reply(json!({
            "ok": false,
            "error": error.message,
            "code": if error.status == 409 { "conflict" } else { "notes_error" },
        }))
        .with_status(error.status),
        Err(_) => reply(json!({ "ok": false, "error": "Could not access your local notes.", "code": "notes_error" })).with_status(500),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, NotesStore) {
        let root = tempfile::tempdir().unwrap();
        let store = NotesStore::new(root.path());
        (root, store)
    }

    fn err<T: std::fmt::Debug>(result: Result<T>) -> NotesError {
        result.unwrap_err()
    }

    #[test]
    fn notes_persist_across_restarts_in_an_atomic_private_library_with_nested_folders() {
        let (root, store) = fixture();
        let parent = store.create_folder(&json!({ "name": "Projects" })).unwrap();
        let child = store
            .create_folder(&json!({ "name": "Demo", "parentId": parent.id }))
            .unwrap();
        let note = store.create(&json!({ "title": "A plan", "body": "# First idea\n\n- [ ] Test this", "folderId": child.id })).unwrap();
        assert_eq!(note.revision, 1);
        let updated = store
            .update(
                &note.id,
                &json!({ "title": "The plan", "body": "A revised idea.", "revision": 1 }),
            )
            .unwrap();
        assert_eq!(updated.revision, 2);
        let fresh = NotesStore::new(root.path()).list().unwrap();
        assert_eq!(fresh.notes[0].body, "A revised idea.");
        assert_eq!(
            fresh.folders[1].parent_id.as_deref(),
            Some(parent.id.as_str())
        );
        let file = root.path().join(".habibi/notes/library.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(file.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        let temporaries = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(temporaries, 0);
    }

    #[test]
    fn simultaneous_stale_edits_cannot_overwrite_a_newer_saved_note() {
        let (_root, store) = fixture();
        let store = Arc::new(store);
        let note = store
            .create(&json!({ "title": "Concurrent", "body": "Original" }))
            .unwrap();
        let results: Vec<_> = ["First editor", "Stale editor"]
            .map(|body| {
                let store = store.clone();
                let id = note.id.clone();
                std::thread::spawn(move || {
                    store.update(&id, &json!({ "body": body, "revision": 1 }))
                })
            })
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let winner = results
            .iter()
            .find_map(|result| result.as_ref().ok())
            .unwrap()
            .body
            .clone();
        assert_eq!(
            results
                .iter()
                .find_map(|result| result.as_ref().err())
                .unwrap()
                .status,
            409
        );
        assert_eq!(store.list().unwrap().notes[0].body, winner);
    }

    #[test]
    fn removing_folders_keeps_notes_and_children_and_trash_restores_the_original_note() {
        let (_root, store) = fixture();
        let parent = store.create_folder(&json!({ "name": "Parent" })).unwrap();
        let folder = store
            .create_folder(&json!({ "name": "Folder", "parentId": parent.id }))
            .unwrap();
        let child = store
            .create_folder(&json!({ "name": "Child", "parentId": folder.id }))
            .unwrap();
        let note = store
            .create(&json!({ "title": "Keep me", "body": "Useful content", "folderId": folder.id }))
            .unwrap();
        let library = store.remove_folder(&folder.id).unwrap();
        assert_eq!(
            library.notes[0].folder_id.as_deref(),
            Some(parent.id.as_str())
        );
        assert_eq!(
            library
                .folders
                .iter()
                .find(|item| item.id == child.id)
                .unwrap()
                .parent_id
                .as_deref(),
            Some(parent.id.as_str())
        );
        let deleted = store.trash(&note.id, Some(&json!(2)), false).unwrap();
        assert!(deleted.deleted_at.is_some());
        assert!(
            err(store.update(&note.id, &json!({ "body": "Bad write", "revision": 3 })))
                .message
                .contains("Restore")
        );
        let restored = store.trash(&note.id, Some(&json!(3)), true).unwrap();
        assert_eq!(restored.deleted_at, None);
        assert_eq!(restored.body, "Useful content");
    }

    #[test]
    fn invalid_input_and_corrupt_stores_do_not_discard_or_overwrite_user_content() {
        let (root, store) = fixture();
        let note = store
            .create(&json!({ "title": "Safe", "body": "Keep this" }))
            .unwrap();
        assert!(
            err(store.update(
                &note.id,
                &json!({ "body": "x".repeat(262_145), "revision": 1 })
            ))
            .message
            .contains("too long")
        );
        assert!(
            err(store.create(&json!({ "folderId": "../../outside" })))
                .message
                .contains("existing folder")
        );
        assert_eq!(store.list().unwrap().notes[0].body, "Keep this");
        let file = root.path().join(".habibi/notes/library.json");
        std::fs::write(&file, "broken library").unwrap();
        assert!(
            err(store.create(&json!({ "title": "Do not reset" })))
                .message
                .contains("has not been changed")
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "broken library");
    }

    #[test]
    fn catalog_page_icons_survive_edits_and_restarts_alongside_legacy_notes() {
        let (root, store) = fixture();
        let legacy = store
            .create(&json!({ "title": "Older page", "emoji": "🚀" }))
            .unwrap();
        let note = store
            .create(&json!({ "title": "A page", "icon": "file-text" }))
            .unwrap();
        let updated = store
            .update(
                &note.id,
                &json!({ "revision": note.revision, "icon": "calendar" }),
            )
            .unwrap();
        assert_eq!(updated.icon.as_deref(), Some("calendar"));
        let reloaded = NotesStore::new(root.path()).list().unwrap();
        assert_eq!(
            reloaded
                .notes
                .iter()
                .find(|item| item.id == note.id)
                .unwrap()
                .icon
                .as_deref(),
            Some("calendar")
        );
        assert_eq!(
            reloaded
                .notes
                .iter()
                .find(|item| item.id == legacy.id)
                .unwrap()
                .emoji,
            "🚀"
        );
        for invalid in [
            json!("../file"),
            json!("<svg>"),
            json!("A".repeat(81)),
            json!(null),
            json!(5),
        ] {
            let error = err(store.update(
                &note.id,
                &json!({ "revision": updated.revision, "icon": invalid }),
            ));
            assert!(
                error.message.contains("valid page icon"),
                "{}",
                error.message
            );
        }
        assert_eq!(
            store
                .list()
                .unwrap()
                .notes
                .iter()
                .find(|item| item.id == note.id)
                .unwrap()
                .icon
                .as_deref(),
            Some("calendar")
        );
    }

    fn refs(notes: &[&Note]) -> Value {
        Value::Array(
            notes
                .iter()
                .map(|note| json!({ "id": note.id, "revision": note.revision }))
                .collect(),
        )
    }

    #[test]
    fn drag_organization_groups_and_moves_pages_atomically_retaining_content_and_persisted_order() {
        let (root, store) = fixture();
        let first = store
            .create(&json!({ "title": "First", "body": "One" }))
            .unwrap();
        let second = store
            .create(&json!({ "title": "Second", "body": "Two" }))
            .unwrap();
        let third = store
            .create(&json!({ "title": "Third", "body": "Three" }))
            .unwrap();
        let library = store
            .organize(
                &json!({ "action": "group", "name": "Project", "notes": refs(&[&first, &second]) }),
            )
            .unwrap();
        let folder = library
            .folders
            .iter()
            .find(|folder| folder.name == "Project")
            .unwrap()
            .clone();
        assert_eq!(
            library
                .notes
                .iter()
                .filter(|note| note.folder_id.as_deref() == Some(folder.id.as_str()))
                .count(),
            2
        );
        assert_eq!(
            library
                .notes
                .iter()
                .find(|note| note.id == first.id)
                .unwrap()
                .body,
            "One"
        );
        let library = store
            .organize(&json!({ "action": "move", "folderId": folder.id, "notes": refs(&[&third]) }))
            .unwrap();
        assert_eq!(
            library
                .notes
                .iter()
                .filter(|note| note.folder_id.as_deref() == Some(folder.id.as_str()))
                .count(),
            3
        );
        let moved = library
            .notes
            .iter()
            .find(|note| note.id == third.id)
            .unwrap()
            .clone();
        let library = store
            .organize(&json!({ "action": "reorder", "targetId": first.id, "position": "after", "notes": refs(&[&moved]) }))
            .unwrap();
        assert_eq!(
            library.note_order,
            Some(vec![first.id.clone(), third.id.clone(), second.id.clone()])
        );
        let fresh = NotesStore::new(root.path()).list().unwrap();
        assert_eq!(fresh.note_order, library.note_order);
        let latest = fresh
            .notes
            .iter()
            .find(|note| note.id == first.id)
            .unwrap()
            .clone();
        let library = store
            .organize(&json!({ "action": "move", "folderId": null, "notes": refs(&[&latest]) }))
            .unwrap();
        assert_eq!(
            library
                .notes
                .iter()
                .find(|note| note.id == first.id)
                .unwrap()
                .folder_id,
            None
        );
        let created = store.create(&json!({ "title": "New page" })).unwrap();
        assert_eq!(store.list().unwrap().note_order.unwrap()[0], created.id);
    }

    #[test]
    fn invalid_or_stale_drag_groups_leave_every_page_and_folder_unchanged() {
        let (_root, store) = fixture();
        let first = store.create(&json!({ "title": "First" })).unwrap();
        let second = store.create(&json!({ "title": "Second" })).unwrap();
        store
            .update(
                &second.id,
                &json!({ "body": "A newer edit", "revision": second.revision }),
            )
            .unwrap();
        let before = store.list().unwrap();
        let stale = json!([{ "id": first.id, "revision": 1 }, { "id": second.id, "revision": 1 }]);
        assert!(
            err(store.organize(&json!({ "action": "group", "name": "Rejected", "notes": stale })))
                .message
                .contains("changed elsewhere")
        );
        assert_eq!(store.list().unwrap(), before);
        let one = json!([{ "id": first.id, "revision": 1 }]);
        assert!(
            err(store.organize(&json!({ "action": "move", "folderId": "missing", "notes": one })))
                .message
                .contains("existing folder")
        );
        let twice = json!([{ "id": first.id, "revision": 1 }, { "id": first.id, "revision": 1 }]);
        assert!(
            err(store.organize(&json!({ "action": "group", "name": "Duplicate", "notes": twice })))
                .message
                .contains("each note once")
        );
        assert!(err(store.organize(&json!({ "action": "reorder", "targetId": first.id, "position": "before", "notes": one })))
            .message
            .contains("different page"));
        assert_eq!(store.list().unwrap(), before);
    }

    #[tokio::test]
    async fn notes_routes_validate_requests_and_report_revision_conflicts_without_leaking_raw_errors()
     {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(NotesStore::new(root.path()));
        let call = |method: Method, path: &str, value: Option<Value>| {
            let body = value
                .map(|value| serde_json::to_vec(&value).unwrap())
                .unwrap_or_default();
            ApiRequest::new(method, path, body)
        };
        let send = |request: ApiRequest| {
            let store = store.clone();
            async move { handle(&store, &request).await.unwrap() }
        };
        let created = send(call(
            Method::Post,
            "/api/notes",
            Some(json!({ "title": "A private note", "body": "Local content" })),
        ))
        .await;
        let created = created.json_value().unwrap();
        assert_eq!(created["ok"], true);
        let id = created["note"]["id"].as_str().unwrap().to_string();
        let read = send(call(Method::Get, "/api/notes", None)).await;
        assert_eq!(read.header("cache-control"), Some("no-store"));
        assert_eq!(
            read.json_value().unwrap()["notes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let patched = send(call(
            Method::Patch,
            &format!("/api/notes/{id}"),
            Some(json!({ "body": "First write", "revision": 1 })),
        ))
        .await;
        assert_eq!(patched.status, 200);
        let search = send(call(Method::Get, "/api/notes/search?q=private", None))
            .await
            .json_value()
            .unwrap();
        assert_eq!(search["notes"][0]["id"], json!(id));
        assert!(search["notes"][0].get("body").is_none());
        let table = "| Private name | Amount |\n| :--- | ---: |\n| Internal value | 99 |";
        let table_note = send(call(Method::Post, "/api/notes", Some(json!({ "title": "Table preview", "body": format!("A short introduction\n\n{table}") }))))
            .await
            .json_value()
            .unwrap();
        let table_search = send(call(
            Method::Get,
            "/api/notes/search?q=table%20preview",
            None,
        ))
        .await
        .json_value()
        .unwrap();
        assert_eq!(table_search["notes"][0]["id"], table_note["note"]["id"]);
        assert_eq!(
            table_search["notes"][0]["preview"],
            "A short introduction · Table"
        );
        let cell_search = send(call(
            Method::Get,
            "/api/notes/search?q=internal%20value",
            None,
        ))
        .await
        .json_value()
        .unwrap();
        assert_eq!(cell_search["notes"][0]["id"], table_note["note"]["id"]);
        let conflict = send(call(
            Method::Patch,
            &format!("/api/notes/{id}"),
            Some(json!({ "body": "Stale write", "revision": 1 })),
        ))
        .await;
        assert_eq!(conflict.status, 409);
        assert_eq!(conflict.json_value().unwrap()["code"], "conflict");
        let unknown = send(call(
            Method::Patch,
            "/api/notes/not-a-note",
            Some(json!({ "revision": 1 })),
        ))
        .await;
        assert_eq!(unknown.status, 404);
        let text = String::from_utf8(unknown.body).unwrap();
        assert!(!text.contains("ENOENT") && !text.contains(".habibi"));
        let invalid = send(call(Method::Post, "/api/notes", None)).await;
        assert_eq!(invalid.status, 400);
        let missing = send(call(Method::Get, "/api/notes/a/b/c", None)).await;
        assert_eq!(missing.status, 404);
    }
}
