//! The file-tools service (`service.ts`): scans, plans, previews and applies.
//! Everything here is blocking filesystem work; `lib.rs` runs it on Tokio's
//! blocking pool and makes the model calls in between.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use habibi_core::Paths;
use serde_json::{Value, json};

use crate::access::{FileAccess, permitted};
use crate::analysis::{Duplicates, duplicate_groups, file_evidence, storage_summary};
use crate::contract::{ChangeKind, FILE_TASKS, FileEntry, FilePlan, PlanStatus, Preview};
use crate::error::{FileError, FileResult, fail};
use crate::execution::Executor;
use crate::native::NativeFileTools;
use crate::planner::{Proposal, validate_file_proposal};
use crate::util::{self, iso_time, js_integer, js_len, now_ms, truthy};

const PLAN_TTL_MS: u64 = 20 * 60_000;
const MAX_PLANS: usize = 20;
const MODEL_FILES: usize = 100;

struct Slot {
    plan: FilePlan,
    previews: Vec<Preview>,
    busy: bool,
}

pub(crate) struct Service {
    home: PathBuf,
    access: Arc<FileAccess>,
    executor: Executor,
    native: Arc<dyn NativeFileTools>,
    /// Insertion-ordered like the JS `Map`, so eviction drops the oldest.
    plans: Mutex<Vec<(String, Slot)>>,
}

/// The read-only part of `prepare`, before the model is asked.
pub(crate) struct Scan {
    pub task: String,
    pub cleanup: bool,
    pub entries: Vec<FileEntry>,
    pub limited: bool,
    pub storage: Value,
    pub duplicates: Option<Duplicates>,
    /// The user message for the model, when the user allowed one.
    pub model_input: Option<String>,
}

/// `JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())`.
pub(crate) fn parse_model_json(text: &str) -> Option<Value> {
    let mut text = text;
    if let Some(rest) = text.strip_prefix("```") {
        text = rest.strip_prefix("json").unwrap_or(rest).trim_start();
    }
    if let Some(rest) = text.trim_end().strip_suffix("```") {
        text = rest;
    }
    serde_json::from_str(text.trim()).ok()
}

fn selection(value: Option<&Value>, changes: usize) -> Option<Vec<usize>> {
    let Some(Value::Array(items)) = value else { return None };
    if items.is_empty() {
        return None;
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let index = js_integer(item)?;
        let index = usize::try_from(index).ok().filter(|index| *index < changes)?;
        if !seen.insert(index) {
            return None;
        }
        out.push(index);
    }
    Some(out)
}

impl Service {
    pub fn new(paths: &Paths, native: Arc<dyn NativeFileTools>) -> Self {
        let access = Arc::new(FileAccess::new(paths.home.clone()));
        let executor = Executor::new(paths.state(""), access.clone(), native.clone());
        Self { home: paths.home.clone(), access, executor, native, plans: Mutex::new(Vec::new()) }
    }

    fn sweep(plans: &mut Vec<(String, Slot)>) {
        let now = now_ms();
        plans.retain(|(_, slot)| !(slot.plan.expires_at < now && slot.plan.status == PlanStatus::Preview && !slot.busy));
        while plans.len() > MAX_PLANS {
            let Some(at) = plans.iter().position(|(_, slot)| !slot.busy) else { break };
            plans.remove(at);
        }
    }

    pub fn grant(&self, value: Option<&Value>) -> FileResult<Value> {
        serde_json::to_value(self.access.grant(value)?).map_err(|_| FileError::Access)
    }

    /// Up to 12 suggestions for an `@` mention, never inside private or
    /// system locations and never through a symbolic link.
    pub fn paths(&self, query: &str) -> Vec<Value> {
        let requested = match query.strip_prefix("~/") {
            Some(rest) => util::normalize(&util::join_relative(&self.home, rest)),
            None => PathBuf::from(query),
        };
        let full = requested.is_absolute();
        let trailing = query.ends_with('/') || (cfg!(windows) && query.ends_with('\\'));
        let base = if !full {
            self.home.clone()
        } else if trailing {
            requested.clone()
        } else {
            requested.parent().map(Path::to_path_buf).unwrap_or_else(|| requested.clone())
        };
        let needle = if full && !trailing {
            requested.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
        } else if full {
            String::new()
        } else {
            query.to_string()
        }
        .to_lowercase();
        if !permitted(&base) {
            return Vec::new();
        }
        let mut names: Vec<String> = fs::read_dir(&base)
            .map(|entries| entries.filter_map(Result::ok).filter_map(|entry| entry.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        names.sort();
        let mut values = Vec::new();
        for name in names {
            if !name.to_lowercase().contains(&needle) || name.starts_with('.') {
                continue;
            }
            let target = base.join(&name);
            if !permitted(&target) {
                continue;
            }
            if let Ok(metadata) = fs::symlink_metadata(&target)
                && !metadata.file_type().is_symlink()
                && (metadata.is_file() || metadata.is_dir())
            {
                values.push(json!({ "path": target, "name": name, "directory": metadata.is_dir() }));
            }
            if values.len() >= 12 {
                break;
            }
        }
        values
    }

    /// `inspect(ids)` → `{ id, entries, limited, storage }`.
    pub fn inspect(&self, ids: Option<&Value>) -> FileResult<(String, Vec<FileEntry>, bool, Value)> {
        let ids = match ids {
            Some(Value::Array(ids)) if !ids.is_empty() && ids.len() <= 8 && ids.iter().all(Value::is_string) => ids,
            _ => return fail("Mention up to eight files or folders first."),
        };
        let mut unique: Vec<String> = Vec::new();
        for id in ids.iter().filter_map(Value::as_str) {
            if !unique.iter().any(|existing| existing == id) {
                unique.push(id.to_string());
            }
        }
        let inventory = self.access.inventory(&unique)?;
        let storage = storage_summary(&inventory.entries);
        Ok((uuid::Uuid::new_v4().to_string(), inventory.entries, inventory.limited, storage))
    }

    pub fn scan(&self, body: &serde_json::Map<String, Value>) -> FileResult<Scan> {
        Self::sweep(&mut self.plans.lock().unwrap_or_else(|e| e.into_inner()));
        let task = body.get("task").and_then(Value::as_str).filter(|task| FILE_TASKS.contains(task));
        let request = match body.get("request") {
            Some(Value::String(request)) if !request.trim().is_empty() && js_len(request) <= 4000 => Some(request),
            _ => None,
        };
        let (Some(task), Some(request)) = (task, request) else {
            return fail("Choose a supported file task and a short request.");
        };
        let (_, mut entries, limited, storage) = self.inspect(body.get("grants"))?;
        let cleanup = body.get("allowCleanup") == Some(&Value::Bool(true));
        let duplicates =
            if task == "duplicates" { Some(duplicate_groups(&entries, |entry| self.access.verify(entry))?) } else { None };
        let mut model_input = None;
        if truthy(body.get("allowModel")) {
            let share = truthy(body.get("shareContents"));
            for entry in entries.iter().take(MODEL_FILES) {
                self.access.verify(entry)?;
            }
            file_evidence(&mut entries, body.get("shareContents") == Some(&Value::Bool(true)), self.native.as_ref());
            for entry in entries.iter().take(MODEL_FILES) {
                self.access.verify(entry)?;
            }
            let files: Vec<Value> = entries
                .iter()
                .take(MODEL_FILES)
                .map(|entry| {
                    let mut file = json!({
                        "id": entry.id,
                        "name": entry.relative,
                        "bytes": entry.size,
                        "modified": iso_time(entry.modified),
                    });
                    if share {
                        if let Some(excerpt) = &entry.excerpt {
                            file["excerpt"] = json!(excerpt);
                        }
                        if let Some(pages) = entry.pages {
                            file["pages"] = json!(pages);
                        }
                    }
                    file
                })
                .collect();
            let mut message = json!({
                "request": request,
                "permissions": {
                    "cleanupEnabled": cleanup,
                    "phase": "preview_only",
                    "executionRequiresUserApproval": true,
                },
                "files": files,
                "storage": storage,
                "truncated": limited || entries.len() > MODEL_FILES,
            });
            if let Some(duplicates) = &duplicates {
                message["duplicates"] = json!(duplicates);
            }
            model_input = Some(message.to_string());
        } else if !["storage", "duplicates"].contains(&task) {
            return fail("Review what will be shared, then choose Prepare with AI.");
        }
        Ok(Scan { task: task.to_string(), cleanup, entries, limited, storage, duplicates, model_input })
    }

    /// Validate the proposal, refuse unsafe cleanup or existing destinations,
    /// and keep the plan for preview/apply.
    pub fn plan(&self, scan: Scan, proposal: &Value, provider: String, model: String) -> FileResult<Value> {
        let Proposal { changes, findings, summary } = validate_file_proposal(proposal, &scan.entries, &scan.task, scan.cleanup)?;
        let now = now_ms();
        let bounded = scan.limited || scan.entries.len() > MODEL_FILES;
        let plan = FilePlan {
            changes,
            findings,
            summary,
            id: uuid::Uuid::new_v4().to_string(),
            task: scan.task,
            entries: scan.entries,
            cleanup: scan.cleanup,
            created_at: now,
            expires_at: now + PLAN_TTL_MS,
            status: PlanStatus::Preview,
            outputs: None,
            warning: bounded.then(|| {
                "This is a bounded scan. AI received at most 100 file records; a scan can contain at most 2,500 files across eight directory levels.".to_string()
            }),
        };
        if let Some(duplicates) = &scan.duplicates {
            let trashed = |id: &String| {
                plan.changes.iter().any(|other| other.kind == ChangeKind::Trash && other.sources.contains(id))
            };
            let unsafe_cleanup = plan.changes.iter().any(|change| {
                change.kind == ChangeKind::Trash
                    && !duplicates
                        .groups
                        .iter()
                        .any(|group| group.ids.contains(&change.sources[0]) && group.ids.iter().any(|id| !trashed(id)))
            });
            if unsafe_cleanup {
                return fail("Cleanup must retain at least one verified identical copy of every duplicate group.");
            }
        }
        // Planning is read-only: conversion starts only in an approved preview/apply path.
        // Check destination paths and collisions during preview, as well as at execution.
        for index in 0..plan.changes.len() {
            if plan.changes[index].kind != ChangeKind::Trash && util::exists_no_follow(&self.executor.target(&plan, index)?) {
                return fail("A proposed destination already exists. Ask for unique output names.");
            }
        }
        let mut response = json!({
            "ok": true,
            "plan": plan,
            "previews": [],
            "storage": scan.storage,
            "provider": provider,
            "model": model,
        });
        if let Some(duplicates) = &scan.duplicates {
            response["duplicates"] = json!(duplicates);
        }
        self.plans.lock().unwrap_or_else(|e| e.into_inner()).push((
            plan.id.clone(),
            Slot { plan, previews: Vec::new(), busy: false },
        ));
        Ok(response)
    }

    /// Take a plan for exclusive work; `check` runs under the lock first.
    fn take(&self, id: &str, check: impl FnOnce(&FilePlan) -> FileResult<()>) -> FileResult<(FilePlan, Vec<Preview>)> {
        let mut plans = self.plans.lock().unwrap_or_else(|e| e.into_inner());
        let Some((_, slot)) = plans.iter_mut().find(|(existing, _)| existing == id) else {
            return fail("This preview is no longer available. Prepare a new one.");
        };
        if slot.busy {
            return fail("This plan is already running.");
        }
        check(&slot.plan)?;
        slot.busy = true;
        Ok((slot.plan.clone(), slot.previews.clone()))
    }

    /// Return a plan after work, keeping whatever state the work reached.
    fn release(&self, id: &str, plan: FilePlan, previews: Vec<Preview>) {
        let mut plans = self.plans.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, slot)) = plans.iter_mut().find(|(existing, _)| existing == id) {
            slot.plan = plan;
            slot.previews = previews;
            slot.busy = false;
        }
    }

    fn validate_selection(plan: &FilePlan, selected: Option<&Value>) -> FileResult<Vec<usize>> {
        if plan.status != PlanStatus::Preview || plan.expires_at < now_ms() {
            return fail("Prepare a fresh plan before confirming an action.");
        }
        selection(selected, plan.changes.len()).ok_or_else(|| FileError::user("Choose valid changes from the plan."))
    }

    fn generate_previews(&self, plan: &FilePlan, previews: &mut Vec<Preview>, selected: &[usize]) -> FileResult<()> {
        let missing: Vec<usize> =
            selected.iter().copied().filter(|index| !previews.iter().any(|preview| preview.index == *index)).collect();
        let generated = self.executor.prepare(plan, &missing)?;
        previews.extend(generated);
        Ok(())
    }

    pub fn preview(&self, id: &str, selected: Option<&Value>) -> FileResult<Value> {
        let mut indices = Vec::new();
        let (plan, mut previews) = self.take(id, |plan| {
            indices = Self::validate_selection(plan, selected)?;
            if !indices.iter().any(|index| plan.changes[*index].kind.is_conversion()) {
                return fail("Choose an output conversion to preview.");
            }
            Ok(())
        })?;
        let result = self.generate_previews(&plan, &mut previews, &indices);
        let response = json!({ "ok": true, "previews": previews });
        self.release(id, plan, previews);
        result.map(|()| response)
    }

    pub fn apply(&self, id: &str, selected: Option<&Value>, cleanup_acknowledged: bool) -> FileResult<Value> {
        let mut indices = Vec::new();
        let (mut plan, mut previews) = self.take(id, |plan| {
            indices = selection(selected, plan.changes.len())
                .ok_or_else(|| FileError::user("Choose valid changes from the preview."))?;
            if indices.iter().any(|index| plan.changes[*index].kind == ChangeKind::Trash)
                && (!plan.cleanup || !cleanup_acknowledged)
            {
                return fail("Confirm the selected Trash operations before applying cleanup.");
            }
            Self::validate_selection(plan, selected).map(|_| ())
        })?;
        let result = self
            .generate_previews(&plan, &mut previews, &indices)
            .and_then(|()| self.executor.apply(&mut plan, &indices, &previews));
        let response = result.map(|outputs| json!({ "ok": true, "outputs": outputs, "previews": previews }));
        self.release(id, plan, previews);
        response
    }

    pub fn undo(&self, id: &str) -> FileResult<Value> {
        let (mut plan, previews) = self.take(id, |_| Ok(()))?;
        let result = self.executor.undo(&mut plan);
        self.release(id, plan, previews);
        result.map(|()| json!({ "ok": true }))
    }

    /// The generated file behind `GET /api/file-tools/preview`.
    pub fn preview_file(&self, id: &str, index: f64) -> FileResult<PathBuf> {
        let plans = self.plans.lock().unwrap_or_else(|e| e.into_inner());
        let Some((_, slot)) = plans.iter().find(|(existing, _)| existing == id) else {
            return fail("This preview is no longer available. Prepare a new one.");
        };
        slot.previews
            .iter()
            .find(|preview| preview.index as f64 == index)
            .map(|preview| preview.path.clone())
            .ok_or_else(|| FileError::user("This output preview is unavailable."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_json_may_be_fenced() {
        assert_eq!(parse_model_json("```json\n{\"a\":1}\n```"), Some(json!({ "a": 1 })));
        assert_eq!(parse_model_json(" {\"a\":2} "), Some(json!({ "a": 2 })));
        assert_eq!(parse_model_json("not json"), None);
    }

    #[test]
    fn selections_must_be_unique_in_range_integers() {
        assert_eq!(selection(Some(&json!([0, 2])), 3), Some(vec![0, 2]));
        for bad in [json!([]), json!([0, 0]), json!([3]), json!([-1]), json!(["0"]), json!(0)] {
            assert_eq!(selection(Some(&bad), 3), None, "{bad}");
        }
    }
}
