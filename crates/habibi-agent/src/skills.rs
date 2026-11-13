//! Imported Codex, Claude Code and MCP capabilities: `/api/agent-skills*`.
//! Ported from `src/agent/skill-import-service.ts`.
//!
//! Discovery is bounded to the workspace and known per-user agent folders; it
//! never crawls the home directory, sends configuration to a model, or
//! returns MCP environment variables to the UI. Running anything needs a
//! single-use `agent-skill.execute` approval (checked by the route), and an
//! append-only audit log records the capability, action and outcome — never
//! prompt content, tool arguments, credentials or tool output.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use habibi_platform::PlatformResult;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::mcp::{self, McpEndpoint};
use crate::util::{append_private_file, now_iso, take_chars, write_private_file};

const IGNORED_FOLDERS: &[&str] = &["node_modules", ".git", "dist", "build", ".openwa"];
const MAX_FILE_BYTES: u64 = 128 * 1024;
const MAX_DEPTH: usize = 4;

/// Opens the user's terminal in `cwd` running `program args...`.
pub type TerminalLauncher = Arc<dyn Fn(&Path, &str, &[String]) -> PlatformResult<()> + Send + Sync>;

pub fn platform_terminal() -> TerminalLauncher {
    Arc::new(habibi_platform::terminal::run_in_terminal)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Codex,
    Claude,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Instruction,
    Command,
    McpServer,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Mcp => "mcp",
        }
    }
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Instruction => "instruction",
            Self::Command => "command",
            Self::McpServer => "mcp-server",
        }
    }
}

/// What the UI sees.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImportedSkill {
    pub id: String,
    pub source: Source,
    pub kind: Kind,
    pub name: String,
    pub description: String,
    pub location: String,
    pub executable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<&'static str>,
}

/// Discovery result including the parts that stay on this side.
struct InternalSkill {
    public: ImportedSkill,
    prompt: Option<String>,
    command_name: Option<String>,
    mcp: Option<Map<String, Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEvent<'a> {
    at: String,
    skill_id: &'a str,
    source: Source,
    kind: Kind,
    action: &'a str,
    outcome: &'a str,
}

fn safe_read(file: &Path) -> Option<String> {
    // `metadata` follows symlinks, like `statSync`.
    let metadata = fs::metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    fs::read(file).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn id_for(source: Source, kind: Kind, location: &str) -> String {
    let digest = Sha256::digest(location.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("imported-{}-{}-{}", source.as_str(), kind.as_str(), &hex[..16])
}

fn walk(root: &Path, matcher: &dyn Fn(&Path) -> bool, depth: usize, found: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if IGNORED_FOLDERS.iter().any(|ignored| name == *ignored) {
            continue;
        }
        let target = entry.path();
        // `file_type` does not follow symlinks, like a `Dirent`.
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            walk(&target, matcher, depth + 1, found);
        } else if matcher(&target) {
            found.push(target);
        }
    }
}

fn walk_all(folders: &[PathBuf], matcher: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for folder in folders {
        walk(folder, matcher, 0, &mut found);
    }
    found
}

static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\s*\n([\s\S]*?)\n---\s*\n?").unwrap());
static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^name:\s*["']?(.+?)["']?\s*$"#).unwrap());
static DESCRIPTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^description:\s*["']?(.+?)["']?\s*$"#).unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#\s+(.+)$").unwrap());

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn parse_instruction(file: &Path, source: Source, kind: Kind) -> Option<InternalSkill> {
    let raw = safe_read(file).filter(|raw| !raw.is_empty())?;
    let metadata = FRONTMATTER.captures(&raw).map(|captures| captures[1].to_string()).unwrap_or_default();
    let stem = file.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let title = NAME
        .captures(&metadata)
        .or_else(|| HEADING.captures(&raw))
        .map(|captures| captures[1].to_string())
        .unwrap_or(stem);
    let description = DESCRIPTION
        .captures(&metadata)
        .map(|captures| captures[1].to_string())
        .or_else(|| {
            raw.split('\n')
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Local agent instruction".into());
    let location = path_text(file);
    // `path.basename(file, '.md')` strips only an exact `.md` suffix.
    let command_name = (kind == Kind::Command).then(|| {
        let base = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        base.strip_suffix(".md").map(str::to_string).unwrap_or(base)
    });
    Some(InternalSkill {
        public: ImportedSkill {
            id: id_for(source, kind, &location),
            source,
            kind,
            name: title.trim().to_string(),
            description: description.trim().to_string(),
            location,
            executable: true,
            transport: None,
        },
        prompt: Some(raw),
        command_name,
        mcp: None,
    })
}

fn read_json_object(file: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(&safe_read(file)?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn mcp_entries(file: &Path, source_label: &str) -> Vec<InternalSkill> {
    let Some(config) = read_json_object(file) else { return Vec::new() };
    let servers =
        if crate::util::truthy(config.get("mcpServers")) { config.get("mcpServers") } else { config.get("servers") };
    let Some(servers) = servers.and_then(Value::as_object) else { return Vec::new() };
    let location = path_text(file);
    servers
        .iter()
        .filter_map(|(name, definition)| {
            let definition = definition.as_object()?;
            let transport = if definition.get("url").is_some_and(Value::is_string) { "http" } else { "stdio" };
            Some(InternalSkill {
                public: ImportedSkill {
                    id: id_for(Source::Mcp, Kind::McpServer, &format!("{location}:{name}")),
                    source: Source::Mcp,
                    kind: Kind::McpServer,
                    name: name.clone(),
                    description: format!(
                        "{source_label} MCP server · {}",
                        if transport == "http" { "HTTP" } else { "local stdio" }
                    ),
                    location: location.clone(),
                    executable: true,
                    transport: Some(transport),
                },
                prompt: None,
                command_name: None,
                mcp: Some(definition.clone()),
            })
        })
        .collect()
}

/// `localeCompare` closely enough for skill names: case-insensitive first.
fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase().cmp(&right.to_lowercase()).then_with(|| left.cmp(right))
}

#[cfg(unix)]
const PROMPT_SHELL_SCRIPT: &str = r#"exec "$0" "$(cat "$1")""#;

#[cfg(windows)]
const PROMPT_POWERSHELL_SCRIPT: &str =
    "param([string]$Agent, [string]$PromptFile)\r\n& $Agent (Get-Content -Raw -LiteralPath $PromptFile)\r\n";

/// The terminal command for `agent`, reading its prompt from `prompt_file` so
/// the prompt never appears in a launcher's process arguments.
fn agent_command(agent: &str, prompt_file: &Path) -> std::io::Result<(String, Vec<String>)> {
    #[cfg(unix)]
    {
        Ok(("/bin/sh".into(), vec!["-c".into(), PROMPT_SHELL_SCRIPT.into(), agent.into(), path_text(prompt_file)]))
    }
    #[cfg(windows)]
    {
        let script = prompt_file.with_file_name("launch.ps1");
        write_private_file(&script, PROMPT_POWERSHELL_SCRIPT.as_bytes())?;
        Ok((
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                path_text(&script),
                agent.into(),
                path_text(prompt_file),
            ],
        ))
    }
}

pub struct SkillImportService {
    /// The workspace whose `.codex/`, `.claude/` and `.mcp.json` are read,
    /// and where launched agents start.
    root: PathBuf,
    /// Holds `.habibi/mcp-servers.json` and the audit log.
    state_root: PathBuf,
    home: PathBuf,
    terminal: TerminalLauncher,
}

impl SkillImportService {
    pub fn new(root: PathBuf, state_root: PathBuf, home: PathBuf, terminal: TerminalLauncher) -> Self {
        Self { root, state_root, home, terminal }
    }

    fn audit_file(&self) -> PathBuf {
        self.state_root.join(".habibi").join("imported-skill-audit.jsonl")
    }

    // Discovery is intentionally bounded to the current workspace and known
    // per-user agent folders. Never recursively crawl Documents/Home for skills.
    fn discover(&self) -> Vec<InternalSkill> {
        let roots = [&self.root];
        let folders = |relative: &[&str]| -> Vec<PathBuf> {
            std::iter::once(&self.home)
                .chain(roots)
                .map(|base| relative.iter().fold(base.to_path_buf(), |path, part| path.join(part)))
                .collect()
        };
        let is_skill =
            |file: &Path| file.file_name().is_some_and(|name| name.to_string_lossy().to_lowercase() == "skill.md");
        let is_markdown = |file: &Path| path_text(file).to_lowercase().ends_with(".md");
        let mut skills: Vec<InternalSkill> = Vec::new();
        skills.extend(
            walk_all(&folders(&[".codex", "skills"]), &is_skill)
                .iter()
                .filter_map(|file| parse_instruction(file, Source::Codex, Kind::Instruction)),
        );
        skills.extend(
            walk_all(&folders(&[".claude", "skills"]), &is_skill)
                .iter()
                .filter_map(|file| parse_instruction(file, Source::Claude, Kind::Instruction)),
        );
        skills.extend(
            walk_all(&folders(&[".claude", "commands"]), &is_markdown)
                .iter()
                .filter_map(|file| parse_instruction(file, Source::Claude, Kind::Command)),
        );
        for root in roots {
            skills.extend(mcp_entries(&root.join(".mcp.json"), "Project"));
        }
        skills.extend(mcp_entries(&self.state_root.join(".habibi").join("mcp-servers.json"), "Habibi"));
        skills.extend(mcp_entries(&self.home.join(".claude.json"), "Claude"));
        let mut seen = std::collections::HashSet::new();
        skills.retain(|skill| seen.insert(skill.public.id.clone()));
        skills.sort_by(|left, right| {
            locale_compare(left.public.source.as_str(), right.public.source.as_str())
                .then_with(|| locale_compare(&left.public.name, &right.public.name))
        });
        skills
    }

    fn find(&self, id: &str) -> Option<InternalSkill> {
        self.discover().into_iter().find(|skill| skill.public.id == id)
    }

    fn audit(&self, skill: &ImportedSkill, action: &str, outcome: &str) {
        let event =
            AuditEvent { at: now_iso(), skill_id: &skill.id, source: skill.source, kind: skill.kind, action, outcome };
        let Ok(mut line) = serde_json::to_vec(&event) else { return };
        line.push(b'\n');
        // Audit is best effort; an unavailable disk must not widen permissions.
        let _ = append_private_file(&self.audit_file(), &line);
    }

    pub fn list(&self) -> Vec<ImportedSkill> {
        self.discover().into_iter().map(|skill| skill.public).collect()
    }

    fn mcp_endpoint(skill: &InternalSkill) -> Result<McpEndpoint, &'static str> {
        let definition = skill.mcp.clone().unwrap_or_default();
        if skill.public.transport == Some("http") {
            return Ok(McpEndpoint::http_from(&definition));
        }
        let endpoint = McpEndpoint::stdio_from(&definition);
        match &endpoint {
            McpEndpoint::Stdio { command, .. } if command.trim().is_empty() => {
                Err("This MCP server has no local command.")
            }
            _ => Ok(endpoint),
        }
    }

    pub async fn preview(&self, id: &str) -> Value {
        let Some(skill) = self.find(id) else {
            return json!({ "ok": false, "error": "That imported skill is no longer available." });
        };
        if skill.public.kind != Kind::McpServer {
            let agent = if skill.public.source == Source::Codex { "Codex" } else { "Claude Code" };
            return json!({
                "ok": true,
                "skill": skill.public,
                "action": format!("Open {agent} with this local instruction"),
                "prompt": take_chars(skill.prompt.as_deref().unwrap_or(""), 1200),
            });
        }
        let endpoint = match Self::mcp_endpoint(&skill) {
            Ok(endpoint) => endpoint,
            Err(error) => return json!({ "ok": false, "error": error }),
        };
        let failed = json!({ "ok": false, "error": "Could not inspect this MCP server." });
        let Ok(client) = mcp::connect(&endpoint).await else { return failed };
        let listed = mcp::list_tools(&client).await;
        mcp::close(client).await;
        let Ok(tools) = listed else { return failed };
        let tools: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description.as_deref().filter(|text| !text.is_empty()).unwrap_or("MCP tool"),
                    "inputSchema": tool.input_schema.as_ref(),
                    "readOnly": tool.annotations.as_ref().and_then(|annotations| annotations.read_only_hint) != Some(false),
                })
            })
            .collect();
        json!({ "ok": true, "skill": skill.public, "action": "Choose an MCP tool and review its JSON input", "tools": tools })
    }

    /// Run an imported skill. The caller has already spent the approval.
    pub async fn execute(&self, id: &str, tool_name: Option<&str>, tool_input: Option<&Value>) -> Value {
        let Some(skill) = self.find(id) else {
            return json!({ "ok": false, "error": "That imported skill is no longer available." });
        };
        if skill.public.kind == Kind::McpServer {
            let (Some(tool_name), Some(Value::Object(arguments))) =
                (tool_name.filter(|name| !name.is_empty()), tool_input)
            else {
                return json!({ "ok": false, "error": "Provide an MCP tool and a JSON object input." });
            };
            let outcome = async {
                let endpoint = Self::mcp_endpoint(&skill)?;
                let client = mcp::connect(&endpoint).await.map_err(|_| "Could not connect to the MCP server.")?;
                let result = mcp::call_tool(&client, tool_name, arguments.clone()).await;
                mcp::close(client).await;
                result.map_err(|_| "The MCP tool call failed.")
            }
            .await;
            return match outcome {
                Ok(result) => {
                    self.audit(&skill.public, "call_mcp", "started");
                    json!({ "ok": true, "result": result })
                }
                Err(error) => {
                    self.audit(&skill.public, "call_mcp", "failed");
                    json!({ "ok": false, "error": error })
                }
            };
        }
        let agent = if skill.public.source == Source::Codex { "codex" } else { "claude" };
        let instruction = if skill.public.kind == Kind::Command {
            format!("/{}", skill.command_name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&skill.public.name))
        } else {
            format!("Use the local instruction at {}.", skill.public.location)
        };
        let request = match tool_input {
            Some(Value::String(input)) if !input.trim().is_empty() => format!("\n\nUser request: {}", input.trim()),
            _ => String::new(),
        };
        match self.launch(agent, &format!("{instruction}{request}")) {
            Ok(()) => {
                self.audit(&skill.public, "launch_agent", "started");
                json!({ "ok": true })
            }
            Err(error) => {
                self.audit(&skill.public, "launch_agent", "failed");
                json!({ "ok": false, "error": error })
            }
        }
    }

    fn launch(&self, agent: &str, prompt: &str) -> Result<(), &'static str> {
        const FAILED: &str = "Could not run this imported skill.";
        // Passing the prompt through a file keeps it out of the process
        // argument list, which any local process can read with `ps`. The
        // folder outlives this call because the terminal reads it later.
        let folder = tempfile::Builder::new().prefix("habibi-skill-").tempdir().map_err(|_| FAILED)?;
        let prompt_file = folder.path().join("prompt.txt");
        write_private_file(&prompt_file, prompt.as_bytes()).map_err(|_| FAILED)?;
        let (program, args) = agent_command(agent, &prompt_file).map_err(|_| FAILED)?;
        match (self.terminal)(&self.root, &program, &args) {
            Ok(()) => {
                let _ = folder.keep();
                Ok(())
            }
            // `folder` is dropped here, removing the prompt it held.
            Err(habibi_platform::PlatformError::Unsupported) => {
                Err("Opening a terminal is not available on this platform.")
            }
            Err(_) => Err(FAILED),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    type Launches = Arc<Mutex<Vec<(PathBuf, String, Vec<String>)>>>;

    fn recording_terminal() -> (TerminalLauncher, Launches) {
        let launches: Launches = Arc::default();
        let recorded = launches.clone();
        let terminal: TerminalLauncher = Arc::new(move |cwd: &Path, program: &str, args: &[String]| {
            recorded.lock().unwrap().push((cwd.to_path_buf(), program.to_string(), args.to_vec()));
            Ok(())
        });
        (terminal, launches)
    }

    fn write(path: PathBuf, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn service(root: &Path, terminal: TerminalLauncher) -> SkillImportService {
        SkillImportService::new(root.to_path_buf(), root.to_path_buf(), root.join("home"), terminal)
    }

    #[tokio::test]
    async fn imports_codex_skills_claude_commands_and_mcp_handles_without_exposing_mcp_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root.join(".codex/skills/review/SKILL.md"),
            "---\nname: Review PR\ndescription: Review changed files\n---\n# Review\n",
        );
        write(root.join(".claude/commands/ship.md"), "# Ship\nPrepare a release.");
        write(
            root.join(".mcp.json"),
            &json!({ "mcpServers": { "private": { "command": "npx", "args": ["server"], "env": { "TOKEN": "never-return-this" } } } }).to_string(),
        );
        let (terminal, _) = recording_terminal();
        let skills = service(root, terminal).list();
        let names: Vec<String> =
            skills.iter().map(|skill| format!("{}:{}", skill.source.as_str(), skill.name)).collect();
        assert_eq!(names, ["claude:Ship", "codex:Review PR", "mcp:private"]);
        let serialized = serde_json::to_string(&skills).unwrap();
        assert!(!serialized.contains("never-return-this"));
        assert!(!serialized.contains("npx"));
        assert_eq!(skills[1].description, "Review changed files");
        assert_eq!(skills[2].description, "Project MCP server · local stdio");
        assert!(
            skills[0].id.starts_with("imported-claude-command-")
                && skills[0].id.len() == "imported-claude-command-".len() + 16
        );
        let (terminal, _) = recording_terminal();
        let preview = service(root, terminal).preview(&skills[0].id).await;
        assert_eq!(preview["ok"], true);
        assert!(preview["action"].as_str().unwrap().contains("Claude Code"));
        assert_eq!(preview["prompt"], "# Ship\nPrepare a release.");
        assert!(preview["skill"].get("prompt").is_none());
    }

    #[test]
    fn discovery_stays_inside_known_folders_and_bounded_depth() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root.join("Documents/.claude/commands/hidden.md"), "# Hidden");
        write(root.join(".claude/commands/node_modules/dep.md"), "# Dep");
        write(root.join(".claude/commands/a/b/c/d/e/deep.md"), "# Too deep");
        write(root.join(".claude/commands/a/b/c/d/ok.md"), "# Deep enough");
        write(root.join(".claude/commands/empty.md"), "");
        write(root.join("home/.claude/skills/x/skill.md"), "No heading here");
        write(root.join(".claude/commands/big.md"), &"x".repeat(MAX_FILE_BYTES as usize + 1));
        let (terminal, _) = recording_terminal();
        let names: Vec<String> = service(root, terminal).list().into_iter().map(|skill| skill.name).collect();
        assert_eq!(names, ["Deep enough", "skill"]);
    }

    #[tokio::test]
    async fn launching_an_imported_skill_passes_hostile_input_as_data_and_the_prompt_by_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root.join(".claude/commands/ship.md"), "# Ship\nPrepare a release.");
        let (terminal, launches) = recording_terminal();
        let skills = service(root, terminal.clone()).list();
        let skill = skills.iter().find(|skill| skill.kind == Kind::Command).unwrap();
        let payload = r#"hi" & (do shell script "echo INJECTED") & "$(touch /tmp/pwned)"#;
        let result = service(root, terminal).execute(&skill.id, None, Some(&json!(payload))).await;
        assert_eq!(result, json!({ "ok": true }));
        let launches = launches.lock().unwrap();
        assert_eq!(launches.len(), 1);
        let (cwd, program, args) = &launches[0];
        assert_eq!(cwd, root);
        assert!(!program.contains("INJECTED"));
        // Neither the prompt nor any part of it is in the argument list.
        assert!(
            args.iter()
                .all(|arg| !arg.contains("INJECTED") && !arg.contains("do shell script") && !arg.contains("Ship"))
        );
        let prompt_file = PathBuf::from(
            args.iter().find(|arg| arg.ends_with("prompt.txt")).expect("the prompt is passed as a file path"),
        );
        let prompt = fs::read_to_string(&prompt_file).unwrap();
        assert_eq!(prompt, format!("/ship\n\nUser request: {payload}"));
        assert!(args.iter().any(|arg| arg == "claude"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&prompt_file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(args[..2], ["-c".to_string(), PROMPT_SHELL_SCRIPT.to_string()]);
        }
        fs::remove_dir_all(prompt_file.parent().unwrap()).unwrap();
        // The audit line records the action, never the prompt.
        let audit = fs::read_to_string(root.join(".habibi/imported-skill-audit.jsonl")).unwrap();
        let event: Value = serde_json::from_str(audit.trim()).unwrap();
        assert_eq!(event["skillId"], skill.id);
        assert_eq!(event["action"], "launch_agent");
        assert_eq!(event["outcome"], "started");
        assert_eq!(event["source"], "claude");
        assert_eq!(event["kind"], "command");
        assert!(!audit.contains("INJECTED"));
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_launcher_reads_the_prompt_as_one_literal_argument() {
        let dir = tempfile::tempdir().unwrap();
        let prompt = dir.path().join("prompt.txt");
        let hostile = "a \"b\" $(touch pwned) `x` ; c";
        fs::write(&prompt, hostile).unwrap();
        // `printf` stands in for the agent; the prompt has no `%` or backslash, so
        // it prints its single argument verbatim.
        let (program, args) = agent_command("printf", &prompt).unwrap();
        let output = std::process::Command::new(program).current_dir(dir.path()).args(&args).output().unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), hostile);
        assert!(!dir.path().join("pwned").exists());
    }

    #[tokio::test]
    async fn an_unavailable_terminal_fails_cleanly_and_removes_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root.join(".codex/skills/review/SKILL.md"), "# Review\nReview code.");
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let recorded = seen.clone();
        let terminal: TerminalLauncher = Arc::new(move |_: &Path, _: &str, args: &[String]| {
            recorded.lock().unwrap().extend(args.iter().cloned());
            Err(habibi_platform::PlatformError::Unsupported)
        });
        let svc = service(root, terminal);
        let id = svc.list()[0].id.clone();
        let result = svc.execute(&id, None, None).await;
        assert_eq!(result, json!({ "ok": false, "error": "Opening a terminal is not available on this platform." }));
        let prompt_file = seen.lock().unwrap().iter().find(|arg| arg.ends_with("prompt.txt")).cloned().unwrap();
        assert!(!Path::new(&prompt_file).exists());
        let audit = fs::read_to_string(root.join(".habibi/imported-skill-audit.jsonl")).unwrap();
        assert!(audit.contains("\"outcome\":\"failed\""));
        assert!(
            svc.execute("imported-missing", None, None).await["error"]
                .as_str()
                .unwrap()
                .contains("no longer available")
        );
    }

    #[tokio::test]
    async fn mcp_execution_needs_a_tool_and_an_object_input() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root.join(".habibi/mcp-servers.json"), &json!({ "servers": { "local": { "command": "" } } }).to_string());
        let (terminal, launches) = recording_terminal();
        let svc = service(root, terminal);
        let skill = svc.list().into_iter().find(|skill| skill.kind == Kind::McpServer).unwrap();
        assert_eq!(skill.description, "Habibi MCP server · local stdio");
        let needs = json!({ "ok": false, "error": "Provide an MCP tool and a JSON object input." });
        assert_eq!(svc.execute(&skill.id, None, Some(&json!({}))).await, needs);
        assert_eq!(svc.execute(&skill.id, Some("t"), Some(&json!([1]))).await, needs);
        assert_eq!(svc.execute(&skill.id, Some("t"), None).await, needs);
        assert_eq!(
            svc.execute(&skill.id, Some("t"), Some(&json!({}))).await["error"],
            "This MCP server has no local command."
        );
        assert_eq!(svc.preview(&skill.id).await["error"], "This MCP server has no local command.");
        assert!(launches.lock().unwrap().is_empty());
    }
}
