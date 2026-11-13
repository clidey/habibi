//! Local MCP servers: `/api/mcp/servers`, `/api/mcp/tools`, and the
//! [`McpHub`] other services use for scoped read sessions. Ported from
//! `src/agent/mcp-bridge.js`.
//!
//! Server definitions live in local state (`.habibi/mcp-servers.json`).
//! Discovery never copies credentials to the UI or executes a tool; env vars
//! and headers are only ever handed to the transport.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use habibi_core::services::{McpHub, McpServerInfo, McpSession, McpTool, ServiceError, ServiceResult};
use rmcp::model::{CallToolRequestParams, Tool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Map, Value, json};

use crate::policy::as_habibi_tool_name;

/// Connect, list and call budgets, matching the Node bridge's 20 s.
pub const MCP_TIMEOUT: Duration = Duration::from_secs(20);

/// How to reach one MCP server. Never serialized to the UI.
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum McpEndpoint {
    Stdio { command: String, args: Vec<String>, env: Vec<(String, String)> },
    Http { url: String, headers: Vec<(String, String)> },
}

pub(crate) type McpClient = RunningService<RoleClient, ()>;

fn string_pairs(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter().filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string()))).collect()
        })
        .unwrap_or_default()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().map(crate::util::js_string).collect()).unwrap_or_default()
}

impl McpEndpoint {
    pub(crate) fn stdio_from(definition: &Map<String, Value>) -> Self {
        Self::Stdio {
            command: definition.get("command").map(crate::util::js_string).unwrap_or_default(),
            args: string_list(definition.get("args")),
            env: string_pairs(definition.get("env")),
        }
    }

    pub(crate) fn http_from(definition: &Map<String, Value>) -> Self {
        Self::Http {
            url: definition.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
            headers: string_pairs(definition.get("headers")),
        }
    }
}

/// The variables a stdio server inherits, as the MCP SDK's
/// `getDefaultEnvironment()` chose them: enough to run, nothing else from
/// Habibi's own environment.
fn default_environment() -> Vec<(String, String)> {
    let names: &[&str] = if cfg!(windows) {
        &[
            "APPDATA",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "PATH",
            "PROCESSOR_ARCHITECTURE",
            "SYSTEMDRIVE",
            "SYSTEMROOT",
            "TEMP",
            "USERNAME",
            "USERPROFILE",
            "PROGRAMFILES",
        ]
    } else {
        &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]
    };
    names
        .iter()
        .filter_map(|name| {
            std::env::var(name).ok().filter(|value| !value.starts_with("()")).map(|value| (name.to_string(), value))
        })
        .collect()
}

/// Open a client connection. Errors are deliberately opaque: a transport or
/// server message may echo a command line, URL or credential.
pub(crate) async fn connect(endpoint: &McpEndpoint) -> Result<McpClient, ()> {
    let connecting = async {
        match endpoint {
            McpEndpoint::Stdio { command, args, env } => {
                if command.trim().is_empty() {
                    return Err(());
                }
                let mut process = tokio::process::Command::new(command);
                process.args(args).env_clear().envs(default_environment()).envs(env.iter().cloned());
                #[cfg(windows)]
                {
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    process.creation_flags(CREATE_NO_WINDOW);
                }
                let (transport, _) =
                    TokioChildProcess::builder(process).stderr(std::process::Stdio::null()).spawn().map_err(|_| ())?;
                ().serve(transport).await.map_err(|_| ())
            }
            McpEndpoint::Http { url, headers } => {
                let parsed = url::Url::parse(url).map_err(|_| ())?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err(());
                }
                let mut custom = HashMap::new();
                for (name, value) in headers {
                    let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| ())?;
                    let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| ())?;
                    custom.insert(name, value);
                }
                let config = StreamableHttpClientTransportConfig::with_uri(url.as_str()).custom_headers(custom);
                ().serve(StreamableHttpClientTransport::from_config(config)).await.map_err(|_| ())
            }
        }
    };
    tokio::time::timeout(MCP_TIMEOUT, connecting).await.map_err(|_| ())?
}

pub(crate) async fn list_tools(client: &McpClient) -> Result<Vec<Tool>, ()> {
    tokio::time::timeout(MCP_TIMEOUT, client.peer().list_all_tools()).await.map_err(|_| ())?.map_err(|_| ())
}

pub(crate) async fn call_tool(client: &McpClient, name: &str, arguments: Map<String, Value>) -> Result<Value, ()> {
    let mut params = CallToolRequestParams::new(name.to_string());
    params.arguments = Some(arguments);
    let result = tokio::time::timeout(MCP_TIMEOUT, client.call_tool(params)).await.map_err(|_| ())?.map_err(|_| ())?;
    serde_json::to_value(result).map_err(|_| ())
}

pub(crate) async fn close(mut client: McpClient) {
    let _ = client.close_with_timeout(Duration::from_secs(2)).await;
}

/// One configured server from `.habibi/mcp-servers.json`.
#[derive(Clone)]
struct ServerDefinition {
    id: String,
    name: Option<String>,
    transport: Option<String>,
    definition: Map<String, Value>,
}

impl ServerDefinition {
    fn endpoint(&self) -> McpEndpoint {
        if self.transport.as_deref() == Some("stdio") {
            McpEndpoint::stdio_from(&self.definition)
        } else {
            McpEndpoint::http_from(&self.definition)
        }
    }
}

pub struct McpBridge {
    config_file: PathBuf,
}

impl McpBridge {
    pub fn new(config_file: PathBuf) -> Self {
        Self { config_file }
    }

    fn read(&self) -> Vec<ServerDefinition> {
        let Some(config) =
            std::fs::read(&self.config_file).ok().and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        else {
            return Vec::new();
        };
        let entries: Vec<Map<String, Value>> = match config.get("servers") {
            Some(Value::Array(items)) => items.iter().filter_map(|item| item.as_object().cloned()).collect(),
            Some(Value::Object(map)) => map
                .iter()
                .map(|(id, definition)| {
                    let mut entry = Map::new();
                    entry.insert("id".into(), json!(id));
                    if let Some(definition) = definition.as_object() {
                        entry.extend(definition.clone());
                    }
                    entry
                })
                .collect(),
            _ => Vec::new(),
        };
        entries
            .into_iter()
            .filter_map(|definition| {
                let id = definition.get("id")?.as_str()?.to_string();
                let transport = definition.get("transport").and_then(Value::as_str).map(str::to_string);
                let usable = matches!(transport.as_deref(), Some("stdio" | "http"))
                    || crate::util::truthy(definition.get("url"));
                usable.then(|| ServerDefinition {
                    id,
                    name: definition
                        .get("name")
                        .filter(|name| crate::util::truthy(Some(name)))
                        .map(crate::util::js_string),
                    transport,
                    definition,
                })
            })
            .collect()
    }

    /// `GET /api/mcp/servers`: ids, names and transports only.
    pub fn list_json(&self) -> Value {
        let servers: Vec<Value> = self
            .read()
            .into_iter()
            .map(|server| {
                let mut entry = json!({ "id": server.id, "name": server.name.unwrap_or_else(|| server.id.clone()) });
                if let Some(transport) = server.transport {
                    entry["transport"] = json!(transport);
                }
                entry
            })
            .collect();
        json!({ "ok": true, "servers": servers })
    }

    /// `GET /api/mcp/tools?server=`.
    pub async fn discover(&self, server_id: &str) -> Value {
        let Some(server) = self.read().into_iter().find(|server| server.id == server_id) else {
            return json!({ "ok": false, "error": "MCP server is not configured.", "tools": [] });
        };
        let failed = json!({ "ok": false, "error": "Could not connect to the MCP server.", "tools": [] });
        let Ok(client) = connect(&server.endpoint()).await else { return failed };
        let listed = list_tools(&client).await;
        close(client).await;
        let Ok(tools) = listed else { return failed };
        let tools: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "id": as_habibi_tool_name(&server.id, &tool.name),
                    "serverId": server.id,
                    "name": tool.name,
                    "description": tool.description.as_deref().unwrap_or(""),
                    "inputSchema": tool.input_schema.as_ref(),
                    "annotations": tool.annotations.as_ref().map(|value| serde_json::to_value(value).unwrap_or_else(|_| json!({}))).unwrap_or_else(|| json!({})),
                })
            })
            .collect();
        json!({ "ok": true, "tools": tools })
    }
}

/// A scoped read session. It closes when dropped; no idle MCP process,
/// polling loop, or UI-held credential is needed.
struct ReadSession {
    client: McpClient,
    tools: Vec<Tool>,
}

#[async_trait]
impl McpSession for ReadSession {
    async fn list_tools(&mut self) -> ServiceResult<Vec<McpTool>> {
        Ok(self
            .tools
            .iter()
            .map(|tool| McpTool {
                name: tool.name.to_string(),
                description: tool.description.as_deref().unwrap_or("").to_string(),
                input_schema: Value::Object(tool.input_schema.as_ref().clone()),
                read_only_hint: tool.annotations.as_ref().and_then(|annotations| annotations.read_only_hint)
                    == Some(true),
            })
            .collect())
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> ServiceResult<Value> {
        // Sessions handed to other services are for reads. A tool must
        // declare itself read-only to be callable here; anything else goes
        // through an approved route instead.
        let read_only = self
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .and_then(|tool| tool.annotations.as_ref())
            .and_then(|annotations| annotations.read_only_hint)
            == Some(true);
        if !read_only {
            return Err(ServiceError::new("Tool is not explicitly read-only."));
        }
        let arguments = match arguments {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return Err(ServiceError::new("MCP tool input must be a JSON object.")),
        };
        call_tool(&self.client, name, arguments).await.map_err(|_| ServiceError::new("The MCP tool call failed."))
    }
}

#[async_trait]
impl McpHub for McpBridge {
    fn servers(&self) -> Vec<McpServerInfo> {
        self.read()
            .into_iter()
            .map(|server| McpServerInfo { name: server.name.unwrap_or_else(|| server.id.clone()), id: server.id })
            .collect()
    }

    async fn open(&self, server_id: &str) -> ServiceResult<Box<dyn McpSession>> {
        let server = self
            .read()
            .into_iter()
            .find(|server| server.id == server_id)
            .ok_or_else(|| ServiceError::new("MCP server is not configured."))?;
        let client =
            connect(&server.endpoint()).await.map_err(|_| ServiceError::new("Could not connect to the MCP server."))?;
        let tools = match list_tools(&client).await {
            Ok(tools) => tools,
            Err(()) => {
                close(client).await;
                return Err(ServiceError::new("Could not connect to the MCP server."));
            }
        };
        Ok(Box::new(ReadSession { client, tools }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn bridge_with(config: Value) -> (tempfile::TempDir, McpBridge) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".habibi/mcp-servers.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, config.to_string()).unwrap();
        (dir, McpBridge::new(file))
    }

    #[test]
    fn servers_list_ids_names_and_transports_but_never_credentials() {
        let (_dir, bridge) = bridge_with(json!({ "servers": {
            "files": { "transport": "stdio", "command": "npx", "args": ["srv"], "env": { "TOKEN": "never-return-this" } },
            "remote": { "name": "Remote", "url": "https://mcp.example/mcp", "headers": { "Authorization": "Bearer secret-header" } },
            "broken": { "command": "x" },
        } }));
        let listed = bridge.list_json();
        assert_eq!(
            listed,
            json!({ "ok": true, "servers": [
                { "id": "files", "name": "files", "transport": "stdio" },
                { "id": "remote", "name": "Remote" },
            ] })
        );
        let text = listed.to_string();
        assert!(!text.contains("never-return-this") && !text.contains("secret-header") && !text.contains("npx"));
        assert_eq!(
            bridge.servers(),
            vec![
                McpServerInfo { id: "files".into(), name: "files".into() },
                McpServerInfo { id: "remote".into(), name: "Remote".into() }
            ]
        );
    }

    #[test]
    fn array_configs_and_missing_files_are_supported() {
        let (_dir, bridge) = bridge_with(
            json!({ "servers": [{ "id": "a", "transport": "http", "url": "http://127.0.0.1:1/mcp" }, { "name": "no id" }] }),
        );
        assert_eq!(bridge.servers().len(), 1);
        let missing = McpBridge::new(PathBuf::from("/nonexistent/habibi/mcp-servers.json"));
        assert_eq!(missing.list_json(), json!({ "ok": true, "servers": [] }));
    }

    #[tokio::test]
    async fn unknown_servers_and_failed_connections_return_fixed_errors() {
        let (_dir, bridge) = bridge_with(json!({ "servers": {
            "gone": { "transport": "stdio", "command": "/nonexistent/habibi-mcp-server" },
            "bad-url": { "transport": "http", "url": "file:///etc/passwd" },
        } }));
        assert_eq!(
            bridge.discover("nope").await,
            json!({ "ok": false, "error": "MCP server is not configured.", "tools": [] })
        );
        assert_eq!(
            bridge.discover("gone").await,
            json!({ "ok": false, "error": "Could not connect to the MCP server.", "tools": [] })
        );
        assert_eq!(bridge.discover("bad-url").await["error"], "Could not connect to the MCP server.");
        assert!(bridge.open("gone").await.is_err());
    }
}

#[cfg(test)]
mod session_tests {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;

    /// A minimal MCP server speaking newline-delimited JSON-RPC, enough for
    /// initialize, tools/list and tools/call.
    async fn fake_server(stream: tokio::io::DuplexStream, calls: std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
        let (read, mut write) = tokio::io::split(stream);
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = message.get("id").cloned() else { continue };
            let result = match message["method"].as_str().unwrap_or("") {
                "initialize" => json!({
                    "protocolVersion": message["params"]["protocolVersion"],
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "fake", "version": "1" },
                }),
                "tools/list" => json!({ "tools": [
                    { "name": "read_rows", "inputSchema": { "type": "object" }, "annotations": { "readOnlyHint": true } },
                    { "name": "drop_table", "description": "Deletes", "inputSchema": { "type": "object" } },
                ] }),
                "tools/call" => {
                    calls.lock().unwrap().push(message["params"].clone());
                    json!({ "content": [{ "type": "text", "text": "2 rows" }], "isError": false })
                }
                _ => json!({}),
            };
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    }

    #[tokio::test]
    async fn read_sessions_list_tools_and_only_call_explicitly_read_only_ones() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        tokio::spawn(fake_server(server_side, calls.clone()));
        let (read, write) = tokio::io::split(client_side);
        let client = tokio::time::timeout(MCP_TIMEOUT, ().serve((read, write))).await.unwrap().unwrap();
        let tools = list_tools(&client).await.unwrap();
        let mut session = ReadSession { client, tools };
        let listed = session.list_tools().await.unwrap();
        assert_eq!(listed.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>(), ["read_rows", "drop_table"]);
        assert_eq!(listed[1].description, "Deletes");
        let result = session.call_tool("read_rows", json!({ "limit": 2 })).await.unwrap();
        assert_eq!(result["content"][0]["text"], "2 rows");
        let refused = session.call_tool("drop_table", json!({})).await.unwrap_err();
        assert_eq!(refused.0, "Tool is not explicitly read-only.");
        assert!(session.call_tool("unknown", json!({})).await.is_err());
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["name"], "read_rows");
        assert_eq!(calls[0]["arguments"], json!({ "limit": 2 }));
    }
}
