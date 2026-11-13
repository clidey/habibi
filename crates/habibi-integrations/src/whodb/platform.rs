//! In-process, CLI-compatible WhoDB platform reads for the SSO session
//! (`src/connectors/whodb-platform.js`), with no resident CLI or polling
//! worker.
//!
//! These fixed queries follow cli/internal/platform/{operations,read_operations,ontology_query}.go.
//! The model supplies variables only: it can never supply a GraphQL document or mutation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::auth::{TokenSource, whodb_json};
use super::{ToolInfo, WhoDbError};
use crate::http::{HttpFetch, HttpRequest};
use crate::util::{js_string, truthy};

struct Operation {
    id: &'static str,
    field: &'static str,
    query: &'static str,
    key: Option<&'static str>,
}

const OPERATIONS: &[Operation] = &[
    Operation { id: "orgs", field: "MyOrganizations", query: "query HabibiOrganizations { MyOrganizations { id name slug } }", key: Some("orgs") },
    Operation { id: "projects", field: "Projects", query: "query HabibiProjects($orgId: ID!) { Projects(orgId: $orgId) { id name slug description } }", key: Some("projects") },
    Operation { id: "apps", field: "ProjectApps", query: "query HabibiApps($projectId: ID!) { ProjectApps(projectId: $projectId) { id name description } }", key: Some("apps") },
    Operation { id: "ontology_describe", field: "OntologyDescribe", query: "query HabibiOntologyDescribe($projectId: ID!, $input: OntologyDescribeInput!) { OntologyDescribe(projectId: $projectId, input: $input) { text entities { name displayName description primaryKey fields { name displayName description type required searchable sortable } } relationships { name source sourceField target targetField cardinality kind } } }", key: None },
    Operation { id: "ontology_query", field: "OntologyQuery", query: "query HabibiOntologyQuery($projectId: ID!, $input: OntologyQueryInput!) { OntologyQuery(projectId: $projectId, input: $input) { columns rows total partial scannedRows } }", key: None },
];

/// The read-only tools the SSO session offers.
pub fn tool_definitions() -> Vec<ToolInfo> {
    OPERATIONS
        .iter()
        .map(|operation| {
            let query = operation.id == "ontology_query";
            ToolInfo {
                name: format!("whodb_platform_{}", operation.id),
                description: if query {
                    "Read bounded ontology rows/aggregates. input.entity is a catalog entity name; whereJson is a JSON-encoded filter object. Max 100 rows and 5000 scanned rows.".into()
                } else {
                    format!("Read WhoDB {} in the selected workspace.", operation.id.replace('_', " "))
                },
                input_schema: if query {
                    json!({
                        "type": "object", "required": ["input"], "properties": { "input": { "type": "object", "required": ["entity"], "properties": {
                            "entity": { "type": "string" }, "whereJson": { "type": "string" }, "search": { "type": "string" },
                            "searchFields": { "type": "array", "items": { "type": "string" } }, "groupBy": { "type": "array", "items": { "type": "string" } },
                            "metrics": { "type": "array", "items": { "type": "object", "properties": { "op": { "enum": ["count", "count_distinct", "sum", "avg", "min", "max"] }, "field": { "type": "string" }, "as": { "type": "string" } } } },
                            "sort": { "type": "array", "items": { "type": "object", "properties": { "field": { "type": "string" }, "desc": { "type": "boolean" } } } },
                        } } },
                    })
                } else {
                    json!({ "type": "object", "properties": {} })
                },
                read_only: true,
            }
        })
        .collect()
}

pub struct PlatformSession {
    host: String,
    tokens: Arc<dyn TokenSource>,
    http: Arc<dyn HttpFetch>,
    tools: Vec<ToolInfo>,
}

impl PlatformSession {
    pub fn new(host: String, tokens: Arc<dyn TokenSource>, http: Arc<dyn HttpFetch>) -> Self {
        Self { host, tokens, http, tools: tool_definitions() }
    }

    pub fn tools(&self) -> &[ToolInfo] {
        &self.tools
    }

    pub async fn call(&self, name: &str, args: &Value) -> Result<Value, WhoDbError> {
        let id = name.strip_prefix("whodb_platform_").unwrap_or(name);
        let operation = OPERATIONS.iter().find(|operation| operation.id == id).ok_or(WhoDbError::Failed)?;
        let workspace = crate::util::record(args.get("workspace"));
        if workspace.get("host").and_then(Value::as_str) != Some(self.host.as_str()) {
            return Err(WhoDbError::Failed);
        }
        let org = workspace.get("org").filter(|org| truthy(Some(org))).map(js_string);
        let project = workspace.get("project").filter(|project| truthy(Some(project))).map(js_string);
        if id != "orgs" && org.is_none() {
            return Err(WhoDbError::Failed);
        }
        if !["orgs", "projects"].contains(&id) && project.is_none() {
            return Err(WhoDbError::Failed);
        }
        let mut variables = Map::new();
        match id {
            "projects" => {
                variables.insert("orgId".into(), Value::from(org.clone().unwrap_or_default()));
            }
            "orgs" => {}
            _ => {
                variables.insert("projectId".into(), Value::from(project.clone().unwrap_or_default()));
            }
        }
        if id == "ontology_describe" {
            variables.insert("input".into(), json!({ "entities": [], "includeInferred": false }));
        }
        if id == "ontology_query" {
            let input = crate::util::record(args.get("input"));
            let entity = input.get("entity").and_then(Value::as_str).filter(|entity| !entity.is_empty() && entity.chars().count() <= 160);
            let Some(entity) = entity else { return Err(WhoDbError::Failed) };
            let mut bounded = json!({ "entity": entity, "pageSize": 100, "offset": 0, "scanLimit": 5000 });
            for key in ["whereJson", "search", "searchFields", "groupBy", "metrics", "sort"] {
                if let Some(value) = input.get(key) {
                    bounded[key] = value.clone();
                }
            }
            if bounded.to_string().chars().count() > 24_000 {
                return Err(WhoDbError::Failed);
            }
            variables.insert("input".into(), bounded);
        }
        let token = self.tokens.token(&self.host).await?;
        let mut request = HttpRequest::new("POST", format!("{}/api/query", self.host))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .header("X-Whodb-Client", "habibi");
        if let Some(org) = &org {
            request = request.header("X-Whodb-Org-Id", org.clone());
        }
        if let Some(project) = &project {
            request = request.header("X-Whodb-Project-Id", project.clone());
        }
        let body = json!({ "query": operation.query, "variables": variables });
        let data = whodb_json(&*self.http, request.body(body.to_string())).await.map_err(|_| WhoDbError::Failed)?;
        let has_errors = data.get("errors").and_then(Value::as_array).is_some_and(|errors| !errors.is_empty());
        let value = data.get("data").filter(|data| truthy(Some(data))).and_then(|data| data.get(operation.field));
        match value {
            Some(value) if !has_errors && !value.is_null() => Ok(match operation.key {
                Some(key) => json!({ "structuredContent": { key: value } }),
                None => json!({ "structuredContent": { "data": value } }),
            }),
            _ => Err(WhoDbError::Failed),
        }
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::testing::{FakeHttp, json_response};

    struct FixedToken;

    #[async_trait]
    impl TokenSource for FixedToken {
        async fn token(&self, host: &str) -> Result<String, WhoDbError> {
            assert_eq!(host, "https://app.whodb.com");
            Ok("private-access".into())
        }
    }

    #[tokio::test]
    async fn the_sso_adapter_fixes_queries_workspace_headers_and_scan_row_bounds() {
        let host = "https://app.whodb.com";
        let http = FakeHttp::new(|_| json_response(json!({ "data": { "OntologyQuery": { "columns": ["count"], "rows": [[3]] } } })));
        let session = PlatformSession::new(host.into(), Arc::new(FixedToken), http.clone());
        assert!(session.tools().iter().all(|tool| tool.read_only));
        let workspace = json!({ "host": host, "org": "acme", "project": "retail" });
        let result = session
            .call(
                "whodb_platform_ontology_query",
                &json!({ "workspace": workspace, "query": "mutation { DeleteEverything }", "input": { "entity": "orders", "pageSize": 999999, "scanLimit": 999999, "workspace": { "project": "other" } } }),
            )
            .await
            .unwrap();
        assert_eq!(result["structuredContent"]["data"]["rows"], json!([[3]]));
        let request = http.requests.lock().unwrap()[0].clone();
        let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
        assert!(body["query"].as_str().unwrap().starts_with("query HabibiOntologyQuery"));
        assert!(!body["query"].as_str().unwrap().contains("mutation"));
        assert_eq!(body["variables"]["input"], json!({ "entity": "orders", "pageSize": 100, "offset": 0, "scanLimit": 5000 }));
        assert_eq!(request.header_value("X-Whodb-Org-Id"), Some("acme"));
        assert_eq!(request.header_value("X-Whodb-Project-Id"), Some("retail"));
        assert_eq!(request.header_value("Authorization"), Some("Bearer private-access"));
        assert!(session.call("whodb_platform_update", &json!({ "workspace": workspace })).await.is_err());
        assert!(session.call("constructor", &json!({ "workspace": workspace })).await.is_err());
        assert!(session.call("whodb_platform_orgs", &json!({ "workspace": { "host": "https://attacker.test" } })).await.is_err());
        assert!(session.call("whodb_platform_ontology_query", &json!({ "workspace": { "host": host } })).await.is_err());
        assert_eq!(http.requests.lock().unwrap().len(), 1);
    }
}
