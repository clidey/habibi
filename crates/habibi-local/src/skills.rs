//! Built-in capability manifests (`skills/<id>/manifest.json`) and their
//! validation. Ported from `src/contracts/skill.ts`, `src/core/skill-registry.ts`
//! and `scripts/validate-manifests.mjs`.
//!
//! Skill manifests are deliberately data-only. A manifest grants no authority;
//! the host maps its declared permissions to an implementation and still asks
//! for approval before every write.

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTool {
    pub name: String,
    pub description: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// `native`, `extension`, `local-service` or `oauth`.
    pub kind: String,
    pub permissions: Vec<String>,
    pub commands: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<SkillTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_confirmation: Option<Vec<String>>,
}

const KINDS: &[&str] = &["native", "extension", "local-service", "oauth"];

fn identifier() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]{1,63}$").expect("valid pattern"))
}

fn semver() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$").expect("valid pattern"))
}

fn trimmed(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

fn non_empty_strings(value: Option<&Value>, field: &str, id: &str) -> Result<Vec<String>, String> {
    let error = || format!("Invalid skill manifest {id}: {field} must be a non-empty string array");
    let items = value.and_then(Value::as_array).ok_or_else(error)?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let text = item
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(error)?;
        if seen.insert(text.to_string()) {
            out.push(text.to_string());
        }
    }
    Ok(out)
}

fn plugin_tools(value: Option<&Value>, id: &str) -> Result<Option<Vec<SkillTool>>, String> {
    let Some(value) = value else { return Ok(None) };
    let items = value
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| format!("Invalid skill manifest {id}: tools must be a non-empty array"))?;
    let mut seen = HashSet::new();
    let mut tools = Vec::new();
    for item in items {
        let candidate = item
            .as_object()
            .ok_or_else(|| format!("Invalid skill manifest {id}: tool must be an object"))?;
        let name = trimmed(candidate.get("name"));
        let description = trimmed(candidate.get("description"));
        let read_only = candidate.get("readOnly").and_then(Value::as_bool);
        let (true, false, Some(read_only), false) = (
            identifier().is_match(&name),
            description.is_empty(),
            read_only,
            seen.contains(&name),
        ) else {
            return Err(format!(
                "Invalid skill manifest {id}: invalid tool declaration"
            ));
        };
        seen.insert(name.clone());
        tools.push(SkillTool {
            name,
            description,
            read_only,
        });
    }
    Ok(Some(tools))
}

/// Parse untrusted JSON into the stable skill manifest contract.
pub fn parse_skill_manifest(value: &Value) -> Result<SkillManifest, String> {
    let candidate = value
        .as_object()
        .ok_or("Invalid skill manifest: expected an object")?;
    let id = trimmed(candidate.get("id"));
    let name = trimmed(candidate.get("name"));
    let version = trimmed(candidate.get("version"));
    if !identifier().is_match(&id) {
        let shown = if id.is_empty() { "unknown" } else { &id };
        return Err(format!(
            "Invalid skill manifest {shown}: id must be kebab-case"
        ));
    }
    if name.is_empty() {
        return Err(format!("Invalid skill manifest {id}: name is required"));
    }
    if !semver().is_match(&version) {
        return Err(format!(
            "Invalid skill manifest {id}: version must be semantic versioning"
        ));
    }
    let kind = candidate
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| KINDS.contains(kind));
    let Some(kind) = kind else {
        return Err(format!("Invalid skill manifest {id}: unsupported kind"));
    };
    let permissions = non_empty_strings(candidate.get("permissions"), "permissions", &id)?;
    let commands = non_empty_strings(candidate.get("commands"), "commands", &id)?;
    let tools = plugin_tools(candidate.get("tools"), &id)?;
    let requires_confirmation = match candidate.get("requiresConfirmation") {
        None => None,
        Some(value) => Some(non_empty_strings(Some(value), "requiresConfirmation", &id)?),
    };
    Ok(SkillManifest {
        id,
        name,
        version,
        kind: kind.to_string(),
        permissions,
        commands,
        tools,
        requires_confirmation,
    })
}

/// Load `skills/*/manifest.json` deterministically. A malformed manifest is
/// an error naming the file; callers fail closed on it.
pub fn load_skills(directory: &Path) -> Result<Vec<SkillManifest>, String> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let file = entry.path().join("manifest.json");
        if !file.exists() {
            continue;
        }
        let parsed = std::fs::read_to_string(&file)
            .map_err(|_| "could not be read".to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
            })
            .and_then(|value| parse_skill_manifest(&value));
        match parsed {
            Ok(skill) => skills.push(skill),
            Err(message) => return Err(format!("Could not load {}: {message}", file.display())),
        }
    }
    skills.sort_by(|left, right| crate::util::locale_cmp(&left.name, &right.name));
    Ok(skills)
}

/// The Kubernetes plugin's declaration. The Node host kept it in JavaScript
/// (`src/plugins/kubernetes/index.js`) beside `manifest.json` with the same
/// fields, and listed it with the built-in skills as-is: it is a trusted
/// in-tree declaration and was never passed through `parseSkillManifest`
/// (its tool names use underscores, which that validator rejects).
pub const KUBERNETES_MANIFEST: &str = r#"{
  "id": "kubernetes",
  "name": "Kubernetes",
  "version": "0.1.0",
  "kind": "extension",
  "permissions": ["kubernetes.read", "audit.local"],
  "commands": ["Open Kubernetes", "Diagnose a Kubernetes workload", "Inspect a Kubernetes resource"],
  "tools": [
    { "name": "list_resources", "description": "List cluster resources in a context and optional namespace", "readOnly": true },
    { "name": "inspect_resource", "description": "Read structured workload, pod, service, or event details", "readOnly": true },
    { "name": "read_logs", "description": "Read a bounded tail of pod logs", "readOnly": true },
    { "name": "diagnose", "description": "Investigate a workload by sequencing safe cluster reads and summarizing evidence", "readOnly": true }
  ]
}"#;

fn kubernetes() -> SkillManifest {
    serde_json::from_str(KUBERNETES_MANIFEST).expect("valid Kubernetes manifest")
}

/// Built-in skills plus the Kubernetes plugin, sorted by name, as
/// `/api/skills` lists them. Invalid manifests are left out (and logged):
/// a malformed declaration never becomes a capability.
pub fn registry(app_root: &Path) -> Vec<SkillManifest> {
    let mut skills = match load_skills(&app_root.join("skills")) {
        Ok(skills) => skills,
        Err(message) => {
            tracing::error!("{message}");
            Vec::new()
        }
    };
    skills.push(kubernetes());
    skills.sort_by(|left, right| crate::util::locale_cmp(&left.name, &right.name));
    skills
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skill_manifests_are_typed_and_reject_invalid_authority_declarations() {
        let skill = parse_skill_manifest(&json!({
            "id": "notes", "name": "Notes", "version": "1.2.3", "kind": "native",
            "permissions": ["notes:read"], "commands": ["search"],
        }))
        .unwrap();
        assert_eq!(skill.id, "notes");
        let error = parse_skill_manifest(&json!({
            "id": "Notes", "name": "Notes", "version": "dev", "kind": "shell", "permissions": [], "commands": [],
        }))
        .unwrap_err();
        assert!(error.contains("id must be kebab-case"), "{error}");
        let base = json!({ "id": "x-y", "name": "X", "version": "1.0.0", "kind": "native", "permissions": ["a"], "commands": ["b"] });
        let with = |key: &str, value: Value| {
            let mut manifest = base.clone();
            manifest[key] = value;
            parse_skill_manifest(&manifest)
        };
        assert!(
            with("kind", json!("shell"))
                .unwrap_err()
                .contains("unsupported kind")
        );
        assert!(with("version", json!("1.0")).is_err());
        assert!(with("permissions", json!([])).is_ok());
        assert!(with("permissions", json!([" "])).is_err());
        assert!(with("tools", json!([])).is_err());
        assert!(
            with(
                "tools",
                json!([{ "name": "a_b", "description": "d", "readOnly": "yes" }])
            )
            .is_err()
        );
        assert!(with("tools", json!([{ "name": "ab", "description": "d", "readOnly": true }, { "name": "ab", "description": "d", "readOnly": true }])).is_err());
        assert_eq!(
            with("commands", json!([" a ", "a"])).unwrap().commands,
            ["a"]
        );
    }

    fn repo_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// `pnpm run validate:manifests`: every manifest in the repository parses,
    /// ids are unique, and the approval contract is documented.
    #[test]
    fn every_repository_manifest_is_valid() {
        let root = repo_root();
        let skills = load_skills(&root.join("skills")).unwrap();
        assert!(!skills.is_empty());
        let mut ids = HashSet::new();
        for skill in registry(&root) {
            assert!(
                ids.insert(skill.id.clone()),
                "Duplicate skill id: {}",
                skill.id
            );
        }
        assert_eq!(ids.len(), skills.len() + 1);
        let documented = std::fs::read_to_string(root.join("ARCHITECTURE.md")).unwrap_or_default();
        assert!(
            documented.contains("requiresConfirmation"),
            "ARCHITECTURE.md must document skill approval requirements"
        );
    }

    #[test]
    fn the_embedded_kubernetes_manifest_matches_the_plugin_declaration() {
        let file = repo_root().join("src/plugins/kubernetes/manifest.json");
        let Ok(text) = std::fs::read_to_string(file) else {
            return;
        };
        let declared: SkillManifest = serde_json::from_str(&text).unwrap();
        assert_eq!(declared, kubernetes());
    }
}
