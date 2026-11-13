//! Typed WhoDB tool results (`src/server/services/whodb-results.ts`).

use serde_json::{Map, Value, json};

use crate::util::{array, record, take, truthy};

/// `typeof value === 'string' ? value.slice(0, limit) : ''`.
fn text(value: Option<&Value>, limit: usize) -> String {
    crate::util::bounded(value, limit)
}

/// The JSON payload of an MCP tool result, or an error when the tool failed
/// or did not return a typed, successful object. Only typed JSON results
/// enter the UI.
pub(crate) fn unwrap_result(value: &Value) -> Result<Map<String, Value>, ()> {
    if truthy(value.get("isError")) {
        return Err(());
    }
    let mut data = record(value.get("structuredContent"));
    if data.is_empty()
        && let Some(Value::Array(content)) = value.get("content") {
            for part in content.iter().take(8) {
                let part = record(Some(part));
                let (Some(Value::String(kind)), Some(Value::String(text))) = (part.get("type"), part.get("text")) else {
                    continue;
                };
                if kind != "text" || text.chars().count() > 2_000_000 {
                    continue;
                }
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    data = record(Some(&parsed));
                    break;
                }
            }
        }
    if data.is_empty() || truthy(data.get("error")) || data.get("ok") == Some(&Value::Bool(false)) {
        return Err(());
    }
    Ok(data)
}

fn cell(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::from(""),
        Some(Value::String(text)) => Value::from(take(text, 2000)),
        Some(value @ (Value::Number(_) | Value::Bool(_))) => value.clone(),
        Some(other) => Value::from(take(&other.to_string(), 2000)),
    }
}

/// A bounded table (or text) for the UI from one tool result.
pub fn normalize_result(value: &Value, project: &str) -> Value {
    let wrapper = record(Some(value));
    let inner = record(wrapper.get("data"));
    let data = if inner.is_empty() { wrapper.clone() } else { inner };
    let raw: &[Value] = if let Some(Value::Array(rows)) = data.get("rows") {
        rows
    } else if let Some(Value::Array(items)) = data.get("items") {
        items
    } else {
        array(wrapper.get("data"))
    };
    let mut columns: Vec<String> = array(data.get("columns"))
        .iter()
        .take(40)
        .map(|column| match column {
            Value::String(name) => name.clone(),
            other => {
                let column = record(Some(other));
                let name = if truthy(column.get("name")) { column.get("name") } else { column.get("Name") };
                text(name, 160)
            }
        })
        .collect();
    let first = raw.first();
    if columns.is_empty() && truthy(first) && !first.is_some_and(Value::is_array) {
        columns = record(first).keys().take(40).cloned().collect();
    }
    if columns.is_empty()
        && let Some(Value::Array(cells)) = first {
            columns = (1..=cells.len().min(40)).map(|index| format!("Column {index}")).collect();
        }
    let rows: Vec<Value> = raw
        .iter()
        .take(100)
        .map(|row| {
            let cells: Vec<Value> = columns
                .iter()
                .enumerate()
                .map(|(index, column)| match row {
                    Value::Array(values) => cell(values.get(index)),
                    other => cell(other.get(column)),
                })
                .collect();
            Value::Array(cells)
        })
        .collect();
    let provenance: Vec<String> = array(data.get("provenance"))
        .iter()
        .take(20)
        .map(|item| match item {
            Value::String(name) => take(name, 160),
            other => {
                let item = record(Some(other));
                text(if truthy(item.get("name")) { item.get("name") } else { item.get("source") }, 160)
            }
        })
        .filter(|item| !item.is_empty())
        .collect();
    let warnings: Vec<String> = array(wrapper.get("warnings"))
        .iter()
        .chain(array(data.get("warnings")))
        .take(8)
        .map(|item| text(Some(item), 1000))
        .filter(|item| !item.is_empty())
        .collect();
    let partial = wrapper.get("truncated") == Some(&Value::Bool(true))
        || data.get("partial") == Some(&Value::Bool(true))
        || raw.len() > 100;
    let first_of = |keys: &[&str], source: &Map<String, Value>| {
        keys.iter().map(|key| source.get(*key)).find(|value| truthy(*value)).flatten().cloned()
    };
    let title = text(first_of(&["title", "name"], &data).as_ref(), 200);
    let sql = text(
        first_of(&["sql", "query"], &data).or_else(|| wrapper.get("sql").cloned()).as_ref(),
        20_000,
    );
    let body = if rows.is_empty() {
        take(&serde_json::to_string_pretty(&Value::Object(data.clone())).unwrap_or_default(), 20_000)
    } else {
        String::new()
    };
    json!({
        "project": take(project, 160),
        "title": if title.is_empty() { "WhoDB result".to_string() } else { title },
        "columns": columns,
        "rows": rows,
        "sql": sql,
        "provenance": provenance,
        "warnings": warnings,
        "partial": partial,
        "text": body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_and_malformed_results_fail_closed() {
        assert!(unwrap_result(&json!({ "isError": true, "content": [] })).is_err());
        assert!(unwrap_result(&json!({ "structuredContent": { "error": "private credential error" } })).is_err());
        assert!(unwrap_result(&json!({ "structuredContent": { "ok": false } })).is_err());
        assert!(unwrap_result(&json!({ "content": [{ "type": "text", "text": "not json" }] })).is_err());
        let parsed = unwrap_result(&json!({ "content": [{ "type": "text", "text": "{\"orgs\":[]}" }] })).unwrap();
        assert_eq!(Value::Object(parsed), json!({ "orgs": [] }));
    }

    #[test]
    fn results_are_bounded_to_100_rows_and_marked_partial() {
        let rows: Vec<Value> = (0..500).map(|_| json!(["test"])).collect();
        let result = normalize_result(&json!({ "data": { "columns": ["name"], "rows": rows } }), "Retail");
        assert_eq!(result["rows"].as_array().unwrap().len(), 100);
        assert_eq!(result["partial"], true);
        assert_eq!(result["sql"], "");
        assert_eq!(result["text"], "");
    }

    #[test]
    fn columns_come_from_objects_or_positions_and_warnings_merge() {
        let objects = normalize_result(&json!({ "items": [{ "a": 1, "b": { "x": 1 } }], "warnings": ["w"] }), "P");
        assert_eq!(objects["columns"], json!(["a", "b"]));
        assert_eq!(objects["rows"], json!([[1, "{\"x\":1}"]]));
        // As in the Node service, a result without a `data` wrapper reads its
        // warnings from both levels (they are the same object).
        assert_eq!(objects["warnings"], json!(["w", "w"]));
        let positional = normalize_result(&json!({ "data": { "rows": [[null, true]] }, "truncated": true }), "P");
        assert_eq!(positional["columns"], json!(["Column 1", "Column 2"]));
        assert_eq!(positional["rows"], json!([["", true]]));
        assert_eq!(positional["partial"], true);
        let empty = normalize_result(&json!({ "data": { "title": "Catalog", "entities": [] } }), "P");
        assert_eq!(empty["title"], "Catalog");
        assert!(empty["text"].as_str().unwrap().contains("\"entities\""));
    }
}
