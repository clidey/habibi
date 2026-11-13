//! Previews, apply with rollback, and undo (`execution.ts`).
//!
//! Nothing is ever overwritten: moves hard-link then unlink (or copy with
//! exclusive create across devices), outputs are copied exclusively from the
//! approved preview, and every undo first checks that nothing changed since.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Value, json};

use crate::access::FileAccess;
use crate::contract::{ChangeKind, FileEntry, FilePlan, PlanStatus, Preview};
use crate::error::{FileError, FileResult, fail};
use crate::native::NativeFileTools;
use crate::util::{self, canonical, identity, mtime_ms, now_ms, path_extname, private_directory};

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub(crate) struct Stamp {
    size: u64,
    modified: f64,
    inode: u64,
    device: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RecordEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<PathBuf>,
    to: PathBuf,
    stamp: Stamp,
    /// In memory only: the item went to the OS Trash.
    #[serde(skip)]
    trashed: bool,
}

fn stamp(file: &Path) -> FileResult<Stamp> {
    let metadata = fs::symlink_metadata(file)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || canonical(file)? != file {
        return fail("A file changed or became a symbolic link.");
    }
    let (device, inode) = identity(file, &metadata)?;
    Ok(Stamp { size: metadata.len(), modified: mtime_ms(&metadata), inode, device })
}

fn unchanged(file: &Path, expected: &Stamp) -> FileResult<()> {
    if stamp(file)? != *expected {
        return fail("A file changed since the operation. Undo was stopped to protect your edits.");
    }
    Ok(())
}

fn available(file: &Path) -> FileResult<()> {
    if util::exists_no_follow(file) {
        return fail("A destination already exists. Nothing will be overwritten.");
    }
    Ok(())
}

/// Copy `from` to a new file at `to`, refusing to replace anything.
fn copy_exclusive(from: &Path, to: &Path) -> FileResult<()> {
    let mut source = fs::File::open(from)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut target = options.open(to)?;
    let copied = std::io::copy(&mut source, &mut target).and_then(|_| target.sync_all());
    if let Err(error) = copied {
        drop(target);
        let _ = fs::remove_file(to);
        return Err(error.into());
    }
    if let Ok(metadata) = source.metadata() {
        let _ = fs::set_permissions(to, metadata.permissions());
    }
    Ok(())
}

fn relocate(from: &Path, to: &Path) -> FileResult<()> {
    available(to)?;
    let original = stamp(from)?;
    if let Err(error) = fs::hard_link(from, to) {
        // Across volumes (or on file systems without hard links) fall back
        // to an exclusive copy.
        if !matches!(error.kind(), std::io::ErrorKind::CrossesDevices | std::io::ErrorKind::Unsupported) {
            return Err(error.into());
        }
        copy_exclusive(from, to)?;
    }
    let finished = unchanged(from, &original).and_then(|()| fs::remove_file(from).map_err(FileError::from));
    if let Err(error) = finished {
        let _ = fs::remove_file(to);
        return Err(error);
    }
    Ok(())
}

pub(crate) struct Executor {
    state: PathBuf,
    access: Arc<FileAccess>,
    native: Arc<dyn NativeFileTools>,
    /// Plan id → completed steps, oldest plan first (a JS `Map`).
    records: Mutex<Vec<(String, Vec<RecordEntry>)>>,
}

fn preview_name(name: &str) -> bool {
    // /^[a-f0-9-]{36}-\d+\.[a-z0-9]+$/i
    let bytes = name.as_bytes();
    if bytes.len() < 40 || !bytes[..36].iter().all(|b| b.is_ascii_hexdigit() || *b == b'-') || bytes[36] != b'-' {
        return false;
    }
    let rest = &name[37..];
    let Some((index, extension)) = rest.split_once('.') else { return false };
    !index.is_empty()
        && index.bytes().all(|b| b.is_ascii_digit())
        && !extension.is_empty()
        && extension.bytes().all(|b| b.is_ascii_alphanumeric())
}

const PREVIEW_TTL_MS: f64 = 25.0 * 60_000.0;
const PLAN_PREVIEW_BYTES: u64 = 200 * 1024 * 1024;
const CACHED_PREVIEW_BYTES: u64 = 512 * 1024 * 1024;

impl Executor {
    pub fn new(state: PathBuf, access: Arc<FileAccess>, native: Arc<dyn NativeFileTools>) -> Self {
        Self { state, access, native, records: Mutex::new(Vec::new()) }
    }

    fn preview_root(&self) -> PathBuf {
        self.state.join("file-tools").join("previews")
    }

    fn artifact_root(&self) -> PathBuf {
        self.state.join("file-tools").join("undo")
    }

    fn inputs<'a>(plan: &'a FilePlan, sources: &[String]) -> FileResult<Vec<&'a FileEntry>> {
        sources.iter().map(|id| plan.entry(id).ok_or(FileError::Access)).collect()
    }

    /// Generate the selected conversion outputs into the private preview
    /// folder, after sweeping previews older than 25 minutes.
    pub fn prepare(&self, plan: &FilePlan, selected: &[usize]) -> FileResult<Vec<Preview>> {
        let root = self.preview_root();
        private_directory(&root)?;
        let mut cached = 0u64;
        let now = now_ms() as f64;
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            if !preview_name(&name) {
                continue;
            }
            let file = root.join(&name);
            let info = fs::symlink_metadata(&file)?;
            if !info.is_file() || info.file_type().is_symlink() {
                continue;
            }
            if now - mtime_ms(&info) > PREVIEW_TTL_MS {
                fs::remove_file(&file)?;
            } else {
                cached += info.len();
            }
        }
        let mut plan_bytes = 0u64;
        let mut previews: Vec<Preview> = Vec::new();
        for (index, change) in plan.changes.iter().enumerate() {
            if !selected.contains(&index) || !change.kind.is_conversion() {
                continue;
            }
            let inputs = Self::inputs(plan, &change.sources)?;
            for input in &inputs {
                self.access.verify(input)?;
            }
            let destination_name = change.destination.as_deref().unwrap_or_default();
            let destination = root.join(format!("{}-{index}{}", plan.id, util::extname(destination_name)));
            if change.kind == ChangeKind::Csv {
                util::write_new(&destination, change.csv.as_deref().unwrap_or_default().as_bytes(), true)?;
            } else {
                let mut request = json!({
                    "action": if change.kind == ChangeKind::Image { "image" } else { "pdf" },
                    "sources": inputs.iter().map(|input| &input.path).collect::<Vec<_>>(),
                    "destination": destination,
                });
                if let Some(pages) = &change.pages {
                    let mut picks = Vec::with_capacity(pages.len());
                    for page in pages {
                        let input = inputs.iter().find(|input| input.id == page.source).ok_or(FileError::Access)?;
                        picks.push(json!({ "path": input.path, "page": page.page, "rotate": page.rotate }));
                    }
                    request["pages"] = Value::Array(picks);
                }
                for (key, value) in [("width", change.width), ("quality", change.quality), ("targetBytes", change.target_bytes)] {
                    if let Some(value) = value {
                        request[key] = json!(value);
                    }
                }
                self.native.run(&request)?;
            }
            for input in &inputs {
                self.access.verify(input)?;
            }
            util::set_mode(&destination, 0o600)?;
            let after = fs::metadata(&destination)?.len();
            plan_bytes += after;
            cached += after;
            if plan_bytes > PLAN_PREVIEW_BYTES || cached > CACHED_PREVIEW_BYTES {
                fs::remove_file(&destination)?;
                for preview in &previews {
                    let _ = fs::remove_file(&preview.path);
                }
                return fail("Preview storage is full. Prepare a smaller batch or wait for older previews to expire.");
            }
            previews.push(Preview {
                index,
                path: destination,
                before_bytes: inputs.iter().map(|input| input.size).sum(),
                after_bytes: after,
                target_met: change.target_bytes.is_none_or(|target| after as i64 <= target),
            });
        }
        Ok(previews)
    }

    /// Where change `index` writes, confined to its first source's grant.
    pub fn target(&self, plan: &FilePlan, index: usize) -> FileResult<PathBuf> {
        let change = plan.changes.get(index).ok_or(FileError::Access)?;
        let source = change.sources.first().ok_or(FileError::Access)?;
        let input = plan.entry(source).ok_or(FileError::Access)?;
        let grant = self.access.get(&input.grant_id)?;
        self.access.destination(&grant, change.destination.as_deref().unwrap_or_default())
    }

    /// Persist the (in-memory) undo journal, keeping the latest 100 plans.
    fn journal(&self, records: &mut Vec<(String, Vec<RecordEntry>)>) -> FileResult<()> {
        while records.len() > 100 {
            records.remove(0);
        }
        let directory = self.state.join("file-tools");
        private_directory(&directory)?;
        let file = directory.join("journal.json");
        let temporary = directory.join(format!("journal.json.{}", uuid::Uuid::new_v4()));
        let body = serde_json::to_vec(&records.iter().map(|(id, items)| json!([id, items])).collect::<Vec<_>>())
            .map_err(|_| FileError::Access)?;
        util::write_new(&temporary, &body, true)?;
        if let Err(error) = fs::rename(&temporary, &file) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }

    fn set_record(&self, id: &str, items: Option<Vec<RecordEntry>>) -> FileResult<()> {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        match (records.iter().position(|(existing, _)| existing == id), items) {
            (Some(at), Some(items)) => records[at].1 = items,
            (None, Some(items)) => records.push((id.to_string(), items)),
            (Some(at), None) => {
                records.remove(at);
            }
            (None, None) => {}
        }
        self.journal(&mut records)
    }

    fn record(&self, id: &str) -> Option<Vec<RecordEntry>> {
        let records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        records.iter().find(|(existing, _)| existing == id).map(|(_, items)| items.clone())
    }

    fn put_back(&self, item: &RecordEntry) -> FileResult<()> {
        let destination = match &item.from {
            Some(from) => from.clone(),
            None => self.artifact_root().join(format!("{}{}", uuid::Uuid::new_v4(), path_extname(&item.to))),
        };
        relocate(&item.to, &destination)?;
        if item.trashed {
            crate::native::restored_from_trash(&item.to);
        }
        Ok(())
    }

    pub fn apply(&self, plan: &mut FilePlan, selected: &[usize], previews: &[Preview]) -> FileResult<Vec<PathBuf>> {
        if plan.status != PlanStatus::Preview || plan.expires_at < now_ms() {
            return fail("Prepare a fresh preview before applying.");
        }
        let mut steps = Vec::with_capacity(selected.len());
        for &index in selected {
            match plan.changes.get(index) {
                Some(change) => steps.push((index, change.clone())),
                None => return fail("This selection is invalid."),
            }
        }
        for (_, change) in &steps {
            for input in Self::inputs(plan, &change.sources)? {
                self.access.verify(input)?;
            }
        }
        for (index, change) in &steps {
            if change.kind != ChangeKind::Trash {
                available(&self.target(plan, *index)?)?;
            }
        }
        let mut completed: Vec<RecordEntry> = Vec::new();
        let outcome: FileResult<()> = (|| {
            for (index, change) in &steps {
                let source = Self::inputs(plan, &change.sources[..1])?[0].clone();
                for input in Self::inputs(plan, &change.sources)? {
                    self.access.verify(input)?;
                }
                if change.kind == ChangeKind::Trash {
                    let result = self.native.run(&json!({ "action": "trash", "path": source.path }))?;
                    let Some(path) = result.get("path").and_then(Value::as_str).map(PathBuf::from) else {
                        return fail("The file could not be moved to Trash.");
                    };
                    let stamp = stamp(&path)?;
                    completed.push(RecordEntry { from: Some(source.path.clone()), to: path, stamp, trashed: true });
                } else {
                    let to = self.target(plan, *index)?;
                    if let Some(parent) = to.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    // Recheck all parents after mkdir; never follow a substituted symlink.
                    self.target(plan, *index)?;
                    if change.kind == ChangeKind::Move {
                        relocate(&source.path, &to)?;
                        let stamp = stamp(&to)?;
                        completed.push(RecordEntry { from: Some(source.path.clone()), to, stamp, trashed: false });
                    } else {
                        let Some(preview) = previews.iter().find(|preview| preview.index == *index) else {
                            return fail("The output preview is unavailable.");
                        };
                        copy_exclusive(&preview.path, &to)?;
                        util::set_mode(&to, 0o600)?;
                        let stamp = stamp(&to)?;
                        completed.push(RecordEntry { from: None, to, stamp, trashed: false });
                    }
                }
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                let outputs: Vec<PathBuf> = completed.iter().map(|item| item.to.clone()).collect();
                self.set_record(&plan.id, Some(completed))?;
                plan.status = PlanStatus::Applied;
                plan.outputs = Some(outputs.clone());
                Ok(outputs)
            }
            Err(error) => {
                let mut failed = Vec::new();
                private_directory(&self.artifact_root())?;
                for item in completed.iter().rev() {
                    if unchanged(&item.to, &item.stamp).and_then(|()| self.put_back(item)).is_err() {
                        failed.push(item.clone());
                    }
                }
                if !failed.is_empty() {
                    failed.reverse();
                    self.set_record(&plan.id, Some(failed))?;
                    plan.status = PlanStatus::Applied;
                    return fail(
                        "The operation stopped. Some changes could not be rolled back; use Undo after checking the files.",
                    );
                }
                plan.status = PlanStatus::Failed;
                Err(error)
            }
        }
    }

    pub fn undo(&self, plan: &mut FilePlan) -> FileResult<()> {
        let items = self.record(&plan.id).unwrap_or_default();
        if plan.status != PlanStatus::Applied || items.is_empty() {
            return fail("There is no applied operation to undo in this conversation.");
        }
        // Validate the complete undo before moving anything.
        for item in &items {
            unchanged(&item.to, &item.stamp)?;
            if let Some(from) = &item.from {
                available(from)?;
            }
        }
        private_directory(&self.artifact_root())?;
        let mut remaining = items.clone();
        for item in items.iter().rev() {
            unchanged(&item.to, &item.stamp)?;
            if let Some(from) = &item.from {
                let parent = from.parent().ok_or(FileError::Access)?;
                if canonical(parent)? != parent {
                    return fail("The original folder changed. Undo was stopped.");
                }
            }
            self.put_back(item)?;
            remaining.pop();
            self.set_record(&plan.id, Some(remaining.clone()))?;
        }
        self.set_record(&plan.id, None)?;
        plan.status = PlanStatus::Undone;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_names_match_the_node_pattern() {
        assert!(preview_name("0f8fad5b-d9cb-469f-a165-70867728950e-0.pdf"));
        assert!(!preview_name("journal.json"));
        assert!(!preview_name("0f8fad5b-d9cb-469f-a165-70867728950e-x.pdf"));
    }
}
