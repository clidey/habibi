//! Compact rows and detail views built from kubectl's JSON.

use serde_json::{Map, Value, json};

use crate::util::{array, js_string, number, number_value, or, record, string_or_empty, truthy};

fn string_or(value: Option<&Value>, fallback: &str) -> String {
    if truthy(value) { value.map(js_string).unwrap_or_default() } else { fallback.to_string() }
}

/// `value || 0` rendered in a template literal.
fn count(value: Option<&Value>) -> String {
    js_string(or(value, &json!(0)))
}

/// `new Date(timestamp).toLocaleDateString()` in the default `en-US` form.
fn local_date(timestamp: &str) -> String {
    let date = timestamp.get(..10).unwrap_or("");
    let parts: Vec<u32> = date.split('-').filter_map(|part| part.parse().ok()).collect();
    match parts.as_slice() {
        [year, month, day] if date.len() == 10 => format!("{month}/{day}/{year}"),
        _ => "Invalid Date".into(),
    }
}

/// The first 80 list rows, shaped for the explorer.
pub fn overview_items(kind: &str, items: &[Value]) -> Vec<Value> {
    items.iter().take(80).map(|item| overview_item(kind, item)).collect()
}

fn overview_item(kind: &str, item: &Value) -> Value {
    let metadata = record(item.get("metadata"));
    let status = record(item.get("status"));
    let spec = record(item.get("spec"));
    let mut row = Map::new();
    row.insert("namespace".into(), Value::from(string_or(metadata.get("namespace"), "default")));
    row.insert("name".into(), Value::from(string_or(metadata.get("name"), "Unnamed resource")));
    row.insert("createdAt".into(), Value::from(string_or(metadata.get("creationTimestamp"), "")));
    let (primary, secondary, badge) = match kind {
        "pods" => {
            let containers = array(status.get("containerStatuses"));
            let ready = containers.iter().filter(|container| truthy(container.get("ready"))).count();
            let restarts: f64 = containers.iter().map(|container| number(Some(or(container.get("restartCount"), &json!(0))))).sum();
            (
                string_or(status.get("phase"), "Unknown"),
                format!("{ready}/{} ready", containers.len()),
                if restarts != 0.0 && !restarts.is_nan() {
                    format!("{} restarts", js_string(&number_value(restarts)))
                } else {
                    String::new()
                },
            )
        }
        "deployments" => (
            format!("{}/{} ready", count(status.get("readyReplicas")), count(spec.get("replicas"))),
            if truthy(status.get("availableReplicas")) {
                format!("{} available", js_string(&status["availableReplicas"]))
            } else {
                "No available replicas".into()
            },
            String::new(),
        ),
        "services" => {
            let ports = array(spec.get("ports"))
                .iter()
                .map(|port| {
                    let name = string_or_empty(port.get("name"));
                    format!(
                        "{}{}",
                        port.get("port").map(js_string).unwrap_or_else(|| "undefined".into()),
                        if name.is_empty() { String::new() } else { format!("/{name}") }
                    )
                })
                .collect::<Vec<_>>()
                .join(" · ");
            let cluster_ip = string_or_empty(spec.get("clusterIP"));
            (
                string_or(spec.get("type"), "ClusterIP"),
                if ports.is_empty() { "No ports".into() } else { ports },
                if !cluster_ip.is_empty() && cluster_ip != "None" { cluster_ip } else { String::new() },
            )
        }
        _ => {
            let conditions = array(status.get("conditions"));
            let ready = conditions
                .iter()
                .find(|condition| condition.get("type") == Some(&json!("Ready")))
                .or_else(|| conditions.iter().find(|condition| condition.get("status") == Some(&json!("True"))));
            let primary = match ready {
                Some(condition) => format!(
                    "{}: {}",
                    condition.get("type").map(js_string).unwrap_or_else(|| "undefined".into()),
                    condition.get("status").map(js_string).unwrap_or_else(|| "undefined".into())
                ),
                None => string_or(Some(or(status.get("phase"), or(item.get("kind"), &Value::Null))), "Resource"),
            };
            let created = string_or_empty(metadata.get("creationTimestamp"));
            (
                primary,
                if created.is_empty() { "Cluster resource".into() } else { format!("Created {}", local_date(&created)) },
                String::new(),
            )
        }
    };
    row.insert("primary".into(), Value::from(primary));
    row.insert("secondary".into(), Value::from(secondary));
    row.insert("badge".into(), Value::from(badge));
    Value::Object(row)
}

/// The structured detail view for one resource.
pub fn format_detail(kind: &str, value: &Value) -> Map<String, Value> {
    let metadata = record(value.get("metadata"));
    let status = record(value.get("status"));
    let spec = record(value.get("spec"));
    let statuses = array(status.get("containerStatuses"));
    let containers: Vec<Value> = array(spec.get("containers"))
        .iter()
        .take(30)
        .map(|container| {
            let runtime = statuses
                .iter()
                .find(|item| item.get("name") == container.get("name"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let state = record(runtime.get("state"));
            let ready = truthy(runtime.get("ready"));
            json!({
                "name": string_or(container.get("name"), "container"),
                "image": string_or(container.get("image"), ""),
                "state": state.keys().next().cloned().unwrap_or_else(|| if ready { "Running".into() } else { "Unknown".into() }),
                "ready": ready,
                "restarts": or(runtime.get("restartCount"), &json!(0)),
            })
        })
        .collect();
    let conditions: Vec<Value> = array(status.get("conditions"))
        .iter()
        .take(12)
        .map(|condition| {
            json!({
                "type": string_or(condition.get("type"), "Condition"),
                "status": string_or(condition.get("status"), "Unknown"),
                "reason": string_or(condition.get("reason"), ""),
                "message": string_or(condition.get("message"), ""),
            })
        })
        .collect();
    let mut facts: Vec<[String; 2]> = Vec::new();
    let fact = |key: &str, value: String| [key.to_string(), value];
    match kind {
        "pods" => facts.extend([
            fact("Phase", string_or(status.get("phase"), "Unknown")),
            fact("Node", string_or(spec.get("nodeName"), "Pending")),
            fact("IP", string_or(status.get("podIP"), "—")),
        ]),
        "deployments" => facts.extend([
            fact("Ready", format!("{}/{}", count(status.get("readyReplicas")), count(spec.get("replicas")))),
            fact("Available", count(status.get("availableReplicas"))),
            fact("Updated", count(status.get("updatedReplicas"))),
        ]),
        "services" => {
            let ports = array(spec.get("ports"))
                .iter()
                .map(|port| {
                    format!(
                        "{}/{}",
                        port.get("port").map(js_string).unwrap_or_else(|| "undefined".into()),
                        string_or(port.get("protocol"), "TCP")
                    )
                })
                .collect::<Vec<_>>()
                .join(" · ");
            facts.extend([
                fact("Type", string_or(spec.get("type"), "ClusterIP")),
                fact("Cluster IP", string_or(spec.get("clusterIP"), "—")),
                fact("Ports", if ports.is_empty() { "—".into() } else { ports }),
            ]);
        }
        _ => {}
    }
    if facts.is_empty() {
        facts.extend([
            fact("Created", string_or(metadata.get("creationTimestamp"), "—")),
            fact("Labels", record(metadata.get("labels")).len().to_string()),
            fact("Annotations", record(metadata.get("annotations")).len().to_string()),
        ]);
    }
    let labels: Vec<Value> = record(metadata.get("labels"))
        .iter()
        .take(16)
        .map(|(key, label)| json!({ "key": key, "value": js_string(label) }))
        .collect();
    let mut detail = Map::new();
    detail.insert("kind".into(), Value::from(kind));
    detail.insert("name".into(), Value::from(string_or(metadata.get("name"), "Unnamed resource")));
    detail.insert("namespace".into(), Value::from(string_or(metadata.get("namespace"), "")));
    detail.insert("facts".into(), json!(facts));
    detail.insert("containers".into(), Value::Array(containers));
    detail.insert("conditions".into(), Value::Array(conditions));
    detail.insert("labels".into(), Value::Array(labels));
    detail
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pods_deployments_and_services_compact_like_the_node_service() {
        let pod = json!({
            "metadata": { "name": "api-1", "namespace": "prod", "creationTimestamp": "2024-05-01T10:00:00Z" },
            "status": { "phase": "Running", "containerStatuses": [{ "ready": true, "restartCount": 2 }, { "ready": false }] },
        });
        assert_eq!(
            overview_items("pods", &[pod])[0],
            json!({ "namespace": "prod", "name": "api-1", "createdAt": "2024-05-01T10:00:00Z", "primary": "Running", "secondary": "1/2 ready", "badge": "2 restarts" })
        );
        let deployment = json!({ "metadata": { "name": "api" }, "spec": { "replicas": 3 }, "status": { "readyReplicas": 2 } });
        let row = &overview_items("deployments", &[deployment])[0];
        assert_eq!(row["namespace"], "default");
        assert_eq!(row["primary"], "2/3 ready");
        assert_eq!(row["secondary"], "No available replicas");
        let service = json!({ "metadata": { "name": "web" }, "spec": { "clusterIP": "10.0.0.1", "ports": [{ "port": 80, "name": "http" }, { "port": 443 }] } });
        let row = &overview_items("services", &[service])[0];
        assert_eq!(row["primary"], "ClusterIP");
        assert_eq!(row["secondary"], "80/http · 443");
        assert_eq!(row["badge"], "10.0.0.1");
        let node = json!({ "metadata": { "name": "n1", "creationTimestamp": "2024-05-01T10:00:00Z" }, "status": { "conditions": [{ "type": "Ready", "status": "True" }] } });
        let row = &overview_items("nodes", &[node])[0];
        assert_eq!(row["primary"], "Ready: True");
        assert_eq!(row["secondary"], "Created 5/1/2024");
        assert_eq!(overview_items("pods", &vec![json!({}); 90]).len(), 80);
    }

    #[test]
    fn detail_reports_containers_conditions_and_bounded_labels() {
        let pod = json!({
            "metadata": { "name": "api-1", "namespace": "prod", "labels": { "app": "api" } },
            "spec": { "nodeName": "n1", "containers": [{ "name": "web", "image": "nginx" }] },
            "status": {
                "phase": "Running",
                "podIP": "10.1.1.1",
                "containerStatuses": [{ "name": "web", "ready": true, "restartCount": 1, "state": { "running": {} } }],
                "conditions": [{ "type": "Ready", "status": "True" }],
            },
        });
        let detail = Value::Object(format_detail("pods", &pod));
        assert_eq!(detail["facts"], json!([["Phase", "Running"], ["Node", "n1"], ["IP", "10.1.1.1"]]));
        assert_eq!(detail["containers"][0], json!({ "name": "web", "image": "nginx", "state": "running", "ready": true, "restarts": 1 }));
        assert_eq!(detail["conditions"][0], json!({ "type": "Ready", "status": "True", "reason": "", "message": "" }));
        assert_eq!(detail["labels"], json!([{ "key": "app", "value": "api" }]));
        let config = Value::Object(format_detail("configmaps", &json!({ "metadata": { "name": "c" } })));
        assert_eq!(config["facts"], json!([["Created", "—"], ["Labels", "0"], ["Annotations", "0"]]));
    }
}
