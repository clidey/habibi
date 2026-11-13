//! The `habibiNative` bridge messages the Swift app answered for calendar
//! and Reminders: `calendarAccess`, `calendarEvents` and the `dailyUtility`
//! `reminders.*` actions. Replies are the objects the Swift app produced
//! (for `dailyUtility`, before the shell adds `requestId`).
//!
//! Reads never prompt. Creating or completing a reminder needs the UI's
//! explicit `approved: true` (set only by the confirmation step), a bounded
//! title/notes/id and a writable list, exactly as `Reminders.swift` checked.

use chrono::Utc;
use serde_json::{Value, json};

use crate::ids::{self, SYSTEM};
use crate::model::*;
use crate::service::{Inner, Source};

/// What the UI should open when there is no OS calendar store to send the
/// user to (Windows, Linux): the calendar accounts screen.
pub const OPEN_ACCOUNTS: &str = "calendar-accounts";

const MAX_TITLE_UTF16: usize = 500;
const MAX_NOTES_UTF16: usize = 10_000;
const MAX_ID_UTF16: usize = 2048;

const NO_ACCOUNTS_MESSAGE: &str = "Connect a Google or CalDAV calendar in Settings → Calendar.";

pub async fn calendar_access(inner: &Inner) -> Value {
    let Some(system) = &inner.options.system else {
        let connected = inner
            .accounts
            .list()
            .iter()
            .any(|account| account.calendars);
        return if connected {
            json!({ "ok": true, "reason": "accounts", "message": "" })
        } else {
            json!({ "ok": false, "reason": "noAccounts", "message": NO_ACCOUNTS_MESSAGE, "openSettings": OPEN_ACCOUNTS })
        };
    };
    // Ask through EventKit: this is the macOS Calendar privacy permission
    // users expect, and it grants access without opening Calendar itself.
    let granted = system.request_access(Entity::Event).await;
    let access = system.access(Entity::Event);
    let ok = access.can_read();
    let message = if ok {
        ""
    } else if granted {
        "Habibi needs Full Access to read upcoming events."
    } else {
        "Calendar access was not granted."
    };
    json!({ "ok": ok, "reason": access.calendar_reason(), "message": message })
}

pub async fn calendar_events(inner: &Inner) -> Value {
    let system_access = inner
        .options
        .system
        .as_ref()
        .map(|system| system.access(Entity::Event));
    let (events, succeeded, failed) = inner.merged_events(Utc::now()).await;
    let unavailable: Vec<Value> = failed.iter().map(|failure| failure.to_json()).collect();
    if succeeded == 0 {
        // Distinguish "no events" from "cannot read events": a write-only
        // grant lets Habibi create events but never list them, so an empty
        // agenda here would make a permission problem look like a free day.
        let reason = match system_access {
            Some(access) if !access.can_read() && failed.is_empty() => access.calendar_reason(),
            None if failed.is_empty() => "noAccounts",
            _ => "unavailable",
        };
        return json!({ "ok": false, "events": [], "reason": reason, "unavailable": unavailable });
    }
    let mut reply = json!({ "ok": true, "events": events });
    if !unavailable.is_empty() {
        reply["unavailable"] = json!(unavailable);
    }
    if let Some(access) = system_access.filter(|access| !access.can_read()) {
        reply["systemReason"] = json!(access.calendar_reason());
    }
    reply
}

/// The handler for `dailyUtility` messages whose action starts with `reminders.`.
pub async fn reminders(inner: &Inner, action: &str, message: &Value) -> Value {
    match action {
        "reminders.state" => reminder_state(inner).await,
        "reminders.access" => match &inner.options.system {
            Some(system) => {
                system.request_access(Entity::Reminder).await;
                reminder_state(inner).await
            }
            None => {
                let mut state = reminder_state(inner).await;
                if state.get("access") != Some(&json!(true)) {
                    state["openSettings"] = json!(OPEN_ACCOUNTS);
                }
                state
            }
        },
        "reminders.settings" => match &inner.options.system {
            Some(system) => {
                system.open_settings(Entity::Reminder);
                json!({ "ok": true })
            }
            // No system settings pane to open: send the UI to its own
            // calendar accounts screen instead.
            None => json!({ "ok": true, "openSettings": OPEN_ACCOUNTS }),
        },
        "reminders.create" => create(inner, message).await,
        "reminders.complete" => complete(inner, message).await,
        _ => json!({ "ok": false, "error": "This utility action is unavailable." }),
    }
}

struct Lists {
    sources: Vec<Source>,
    /// `(qualified id, display name)` of writable lists.
    writable: Vec<(String, String)>,
    items: Vec<Value>,
    default_list: String,
}

async fn collect(inner: &Inner) -> Lists {
    let (sources, _) = inner.sources(Entity::Reminder);
    let (lists, _) = inner
        .gather(
            sources.clone(),
            crate::service::REMINDERS_LIMIT,
            |provider| async move {
                let lists = provider.reminder_lists().await?;
                let items = provider.reminders().await?;
                let default = provider.default_reminder_list().await;
                Ok((lists, items, default))
            },
        )
        .await;
    let several = lists
        .iter()
        .filter(|(_, (lists, _, _))| !lists.is_empty())
        .count()
        > 1;
    let mut writable = Vec::new();
    let mut items: Vec<(Option<chrono::DateTime<Utc>>, Value)> = Vec::new();
    let mut default_list = String::new();
    for (source, (source_lists, reminders, default)) in &lists {
        for list in source_lists.iter().filter(|list| list.writable) {
            let name = if several {
                format!("{} · {}", list.name, source.label)
            } else {
                list.name.clone()
            };
            writable.push((ids::qualify(&source.account, &list.id), name));
        }
        if default_list.is_empty()
            && let Some(default) = default.as_deref().filter(|default| {
                source_lists
                    .iter()
                    .any(|list| list.id == *default && list.writable)
            })
        {
            default_list = ids::qualify(&source.account, default);
        }
        for reminder in reminders {
            items.push((
                reminder.due,
                json!({
                    "id": ids::qualify(&source.account, &reminder.id),
                    "title": reminder.title,
                    "due": reminder.due.map(ids::iso).unwrap_or_default(),
                    "list": reminder.list_name,
                    "listId": ids::qualify(&source.account, &reminder.list_id),
                    "completed": reminder.completed,
                }),
            ));
        }
    }
    if default_list.is_empty() {
        default_list = writable
            .first()
            .map(|(id, _)| id.clone())
            .unwrap_or_default();
    }
    // Due first, undated last, as the Swift app sorted them.
    items.sort_by(|a, b| match (a.0, b.0) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    Lists {
        sources: lists.into_iter().map(|(source, _)| source).collect(),
        writable,
        items: items
            .into_iter()
            .take(crate::service::MAX_REMINDERS)
            .map(|(_, item)| item)
            .collect(),
        default_list,
    }
}

pub async fn reminder_state(inner: &Inner) -> Value {
    let system = inner
        .options
        .system
        .as_ref()
        .map(|system| system.access(Entity::Reminder));
    let lists = collect(inner).await;
    if lists.sources.is_empty() {
        let reason = match system {
            Some(access) if !access.can_read() => access.reminders_reason(),
            Some(_) => "unavailable",
            None => {
                if inner
                    .accounts
                    .list()
                    .iter()
                    .any(|account| account.reminders)
                {
                    "unavailable"
                } else {
                    "noAccounts"
                }
            }
        };
        return json!({ "ok": true, "access": false, "reason": reason, "items": [], "lists": [] });
    }
    let mut reply = json!({
        "ok": true,
        "access": true,
        "items": lists.items,
        "lists": lists.writable.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "defaultList": lists.default_list,
    });
    if let Some(access) = system.filter(|access| !access.can_read()) {
        reply["systemReason"] = json!(access.reminders_reason());
    }
    reply
}

fn error(message: &str) -> Value {
    json!({ "ok": false, "error": message })
}

fn approved(message: &Value) -> bool {
    message.get("approved").and_then(Value::as_bool) == Some(true)
}

async fn create(inner: &Inner, message: &Value) -> Value {
    let title = message
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (sources, _) = inner.sources(Entity::Reminder);
    if sources.is_empty()
        || !approved(message)
        || title.trim().is_empty()
        || ids::utf16_len(title) > MAX_TITLE_UTF16
    {
        return error("Review the reminder and allow Reminders access before saving.");
    }
    let lists = collect(inner).await;
    let requested = message
        .get("listId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let list = if requested.is_empty() {
        lists.default_list.as_str()
    } else {
        requested
    };
    let target = lists
        .writable
        .iter()
        .find(|(id, _)| id == list)
        .and_then(|(id, _)| ids::split(id))
        .and_then(|(account, local)| {
            Some((
                lists
                    .sources
                    .iter()
                    .find(|source| source.account == account)?
                    .clone(),
                local.to_string(),
            ))
        });
    let Some((source, local_list)) = target else {
        return error("Choose a writable Reminders list.");
    };
    let due = match message
        .get("due")
        .and_then(Value::as_str)
        .filter(|due| !due.is_empty())
    {
        Some(raw) => match ids::parse_iso(raw) {
            Some(due) => Some(due),
            None => return error("Choose a valid reminder date."),
        },
        None => None,
    };
    let notes = match message.get("notes").and_then(Value::as_str) {
        Some(notes) if ids::utf16_len(notes) > MAX_NOTES_UTF16 => {
            return error("The reminder note is too long.");
        }
        Some(notes) => Some(notes.to_string()),
        None => None,
    };
    let draft = ReminderDraft {
        title: title.to_string(),
        due,
        notes,
    };
    match source.provider.create_reminder(&local_list, &draft).await {
        Ok(()) => reminder_state(inner).await,
        Err(ProviderError::ReadOnly | ProviderError::NotFound) => {
            error("Choose a writable Reminders list.")
        }
        Err(_) if source.account == SYSTEM => {
            error("Apple Reminders could not save this reminder.")
        }
        Err(ProviderError::Auth) => error("This account needs to be reconnected."),
        Err(_) => error("This reminder could not be saved. Try again."),
    }
}

async fn complete(inner: &Inner, message: &Value) -> Value {
    const CANNOT: &str = "This reminder could not be completed.";
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !approved(message) || ids::utf16_len(id) > MAX_ID_UTF16 {
        return error(CANNOT);
    }
    let Some((account, local)) = ids::split(id) else {
        return error(CANNOT);
    };
    let Some(source) = inner
        .source(account, Entity::Reminder)
        .filter(|source| source.account == SYSTEM || source_wants_reminders(inner, account))
    else {
        return error(CANNOT);
    };
    match source.provider.complete_reminder(local).await {
        Ok(()) => reminder_state(inner).await,
        Err(ProviderError::NotFound | ProviderError::ReadOnly | ProviderError::NotAuthorized) => {
            error(CANNOT)
        }
        Err(_) if source.account == SYSTEM => {
            error("Apple Reminders could not update this reminder.")
        }
        Err(ProviderError::Auth) => error("This account needs to be reconnected."),
        Err(_) => error("This reminder could not be updated. Try again."),
    }
}

fn source_wants_reminders(inner: &Inner, account: &str) -> bool {
    inner
        .accounts
        .get(account)
        .is_some_and(|account| account.reminders)
}
