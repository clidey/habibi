//! `/api/calendars`, `/api/calendar/event` and `/api/calendar/event/update`.

use habibi_core::ApiResponse;
use habibi_core::api::text;
use serde_json::{Value, json};

use crate::ids::{self, SYSTEM};
use crate::model::*;
use crate::service::{Inner, Source};

const MAX_TITLE: usize = 1000;
const MAX_SPAN_DAYS: i64 = 366;

/// `{ ok, calendars: [name] }` as before, plus `items` with the
/// provider-qualified ids the event form now submits.
pub async fn list(inner: &Inner) -> ApiResponse {
    let (calendars, failed) = inner.writable_calendars().await;
    if calendars.is_empty() {
        let no_sources = inner.options.system.is_none() && inner.accounts.list().is_empty();
        return ApiResponse::json(
            &json!({ "ok": false, "calendars": [], "needsAccount": no_sources }),
        );
    }
    let several = {
        let mut accounts: Vec<&str> = calendars
            .iter()
            .map(|(_, _, source)| source.account.as_str())
            .collect();
        accounts.dedup();
        accounts.len() > 1
    };
    let names: Vec<&str> = calendars.iter().map(|(_, name, _)| name.as_str()).collect();
    let items: Vec<Value> = calendars
        .iter()
        .map(|(id, name, source)| {
            json!({
                "id": id,
                "name": name,
                "account": source.label,
                "label": if several { format!("{name} · {}", source.label) } else { name.clone() },
            })
        })
        .collect();
    let unavailable: Vec<Value> = failed.iter().map(|failure| failure.to_json()).collect();
    ApiResponse::json(
        &json!({ "ok": true, "calendars": names, "items": items, "unavailable": unavailable }),
    )
}

fn draft(body: &Value) -> Result<EventDraft, &'static str> {
    let title = text(body.get("title")).trim().to_string();
    let start = ids::parse_iso(&text(body.get("start")));
    let end = ids::parse_iso(&text(body.get("end")));
    match (start, end) {
        (Some(start), Some(end))
            if !title.is_empty()
                && ids::utf16_len(&title) <= MAX_TITLE
                && end > start
                && end - start <= chrono::Duration::days(MAX_SPAN_DAYS) =>
        {
            Ok(EventDraft { title, start, end })
        }
        _ => Err("Check the event details."),
    }
}

/// `calendar` is a qualified id from the new form or, from an older UI, a
/// calendar name (resolved to the first writable calendar with that name,
/// macOS calendars first).
async fn resolve_calendar(inner: &Inner, calendar: &str) -> Option<(Source, String)> {
    if let Some((account, local)) = ids::split(calendar)
        && let Some(source) = inner.source(account, Entity::Event)
    {
        return Some((source, local.to_string()));
    }
    let (calendars, _) = inner.writable_calendars().await;
    calendars
        .into_iter()
        .find(|(_, name, _)| name == calendar)
        .and_then(|(id, _, source)| {
            let local = ids::split(&id)?.1.to_string();
            Some((source, local))
        })
}

fn failure(error: &ProviderError) -> ApiResponse {
    let message = match error {
        ProviderError::NotFound => "That calendar or event could not be found.",
        ProviderError::NotAuthorized => "Calendar access has not been granted.",
        other => other.message(),
    };
    ApiResponse::json(&json!({ "ok": false, "error": message }))
}

pub async fn create(inner: &Inner, body: &Value) -> ApiResponse {
    let payload = json!({
        "title": text(body.get("title")),
        "calendar": text(body.get("calendar")),
        "start": text(body.get("start")),
        "end": text(body.get("end")),
    });
    let token = body.get("approvalToken").and_then(Value::as_str);
    if !inner.approvals.consume(token, "calendar.create", &payload) {
        return ApiResponse::error("Calendar creation needs explicit approval");
    }
    let draft = match draft(&payload) {
        Ok(draft) => draft,
        Err(message) => return ApiResponse::error(message),
    };
    let Some((source, calendar)) = resolve_calendar(inner, &text(payload.get("calendar"))).await
    else {
        return ApiResponse::error("Choose a writable calendar.");
    };
    match source.provider.create_event(&calendar, &draft).await {
        Ok(()) => ApiResponse::json(&json!({ "ok": true })),
        Err(error) => failure(&error),
    }
}

pub async fn update(inner: &Inner, body: &Value) -> ApiResponse {
    let payload = json!({
        "id": text(body.get("id")),
        "title": text(body.get("title")),
        "calendar": text(body.get("calendar")),
        "start": text(body.get("start")),
        "end": text(body.get("end")),
    });
    let token = body.get("approvalToken").and_then(Value::as_str);
    if !inner.approvals.consume(token, "calendar.update", &payload) {
        return ApiResponse::error("Calendar changes need explicit approval");
    }
    let draft = match draft(&payload) {
        Ok(draft) => draft,
        Err(message) => return ApiResponse::error(message),
    };
    let id = text(payload.get("id"));
    let Some((account, local)) = ids::split(&id).filter(|_| id.len() <= 4096) else {
        return ApiResponse::error("That calendar or event could not be found.");
    };
    let Some(source) = inner.source(account, Entity::Event) else {
        return ApiResponse::error(if account == SYSTEM {
            "Calendar access has not been granted."
        } else {
            "This account needs to be reconnected."
        });
    };
    // The calendar must belong to the event's own account; a name from an
    // older UI is resolved within that account.
    let calendar = text(payload.get("calendar"));
    let calendar = match ids::split(&calendar) {
        Some((owner, local)) if owner == account => local.to_string(),
        Some(_) => {
            return ApiResponse::error("Moving an event to another calendar isn't supported yet.");
        }
        None => match source.provider.calendars().await {
            Ok(calendars) => match calendars
                .into_iter()
                .find(|candidate| candidate.name == calendar)
            {
                Some(found) => found.id,
                None => return ApiResponse::error("Choose a writable calendar."),
            },
            Err(error) => return failure(&error),
        },
    };
    match source.provider.update_event(local, &calendar, &draft).await {
        Ok(()) => ApiResponse::json(&json!({ "ok": true })),
        Err(error) => failure(&error),
    }
}
