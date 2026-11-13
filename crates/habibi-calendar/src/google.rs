//! Google Calendar (events) and Google Tasks (reminders) over OAuth.
//!
//! The user brings their own OAuth client (a "Desktop app" client in Google
//! Cloud Console, with the Calendar and Tasks APIs enabled), exactly as Mail
//! does for Gmail. Sign-in is the installed-app flow: PKCE plus a loopback
//! redirect to an ephemeral `127.0.0.1` port (see [`crate::oauth`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use reqwest::Url;
use serde_json::{Value, json};

use crate::http::{HttpRequest, HttpResponse, Transport};
use crate::ids::{iso, join_parts, parse_iso, split_parts};
use crate::model::*;

/// Least privilege for what Habibi does: list calendars, read/write events,
/// read/write tasks.
pub const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/tasks",
];

const MAX_CALENDARS: usize = 25;
const MAX_PAGES: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct GoogleEndpoints {
    pub auth: String,
    pub token: String,
    /// `https://www.googleapis.com`; Calendar is under `/calendar/v3`, Tasks
    /// under `/tasks/v1`.
    pub api: String,
}

impl Default for GoogleEndpoints {
    fn default() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            api: "https://www.googleapis.com".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OAuthClient {
    pub id: String,
    /// Desktop clients have a (non-confidential) secret; some client types do not.
    pub secret: Option<String>,
}

/// Short-lived access tokens, shared across provider instances and keyed by
/// account id. Never persisted.
#[derive(Default)]
pub struct TokenCache(Mutex<HashMap<String, (String, Instant)>>);

impl TokenCache {
    fn get(&self, account: &str) -> Option<String> {
        let cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        cache
            .get(account)
            .filter(|(_, expires)| *expires > Instant::now() + Duration::from_secs(60))
            .map(|(token, _)| token.clone())
    }

    pub fn put(&self, account: &str, token: String, expires_in: u64) {
        let expires = Instant::now() + Duration::from_secs(expires_in.clamp(60, 86_400));
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(account.into(), (token, expires));
    }

    pub fn forget(&self, account: &str) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(account);
    }
}

/// The parts of a token endpoint response Habibi uses.
#[derive(Debug, Clone, PartialEq)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    pub expires_in: u64,
}

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish().into_bytes()
}

fn parse_tokens(response: &HttpResponse) -> ProviderResult<Tokens> {
    let body = response.json().unwrap_or(Value::Null);
    if !response.success() {
        // `invalid_grant`: the refresh token was revoked or expired.
        return Err(
            if body.get("error").and_then(Value::as_str) == Some("invalid_grant") {
                ProviderError::Auth
            } else {
                ProviderError::Unavailable
            },
        );
    }
    let access = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or(ProviderError::Unavailable)?;
    Ok(Tokens {
        access: access.into(),
        refresh: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_in: body
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600),
    })
}

/// Exchange an authorization code (with its PKCE verifier) for tokens.
pub async fn exchange_code(
    transport: &dyn Transport,
    endpoints: &GoogleEndpoints,
    client: &OAuthClient,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> ProviderResult<Tokens> {
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client.id.as_str()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = client.secret.as_deref().filter(|secret| !secret.is_empty()) {
        pairs.push(("client_secret", secret));
    }
    let request = HttpRequest::new("POST", &endpoints.token)
        .body("application/x-www-form-urlencoded", form(&pairs));
    parse_tokens(
        &transport
            .send(request)
            .await
            .map_err(|_| ProviderError::Unavailable)?,
    )
}

/// The consent-screen URL for the installed-app flow.
pub fn authorization_url(
    endpoints: &GoogleEndpoints,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    let query = form(&[
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", &SCOPES.join(" ")),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ]);
    format!("{}?{}", endpoints.auth, String::from_utf8_lossy(&query))
}

pub struct Google {
    transport: Arc<dyn Transport>,
    endpoints: GoogleEndpoints,
    account: String,
    client: OAuthClient,
    refresh_token: String,
    tokens: Arc<TokenCache>,
}

/// Local midnight of a calendar date: how all-day boundaries and Google
/// Tasks due dates (date-only) are shown.
fn local_midnight(date: NaiveDate) -> Option<DateTime<Utc>> {
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|date| date.with_timezone(&Utc))
}

fn event_time(value: &Value) -> Option<(DateTime<Utc>, bool)> {
    if let Some(date_time) = value.get("dateTime").and_then(Value::as_str) {
        return parse_iso(date_time).map(|date| (date, false));
    }
    let date = NaiveDate::parse_from_str(value.get("date")?.as_str()?, "%Y-%m-%d").ok()?;
    local_midnight(date).map(|date| (date, true))
}

/// Map one Calendar API event. Cancelled events are dropped.
pub fn map_event(item: &Value, calendar_id: &str, calendar_name: &str) -> Option<EventInfo> {
    if item.get("status").and_then(Value::as_str) == Some("cancelled") {
        return None;
    }
    let id = item.get("id")?.as_str()?;
    let (start, all_day) = event_time(item.get("start")?)?;
    let end = item
        .get("end")
        .and_then(event_time)
        .map(|(end, _)| end)
        .unwrap_or(start)
        .max(start);
    let title = item
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty());
    Some(EventInfo {
        id: join_parts(&[calendar_id, id]),
        title: title.unwrap_or("Untitled event").into(),
        start,
        end,
        all_day,
        calendar_id: calendar_id.into(),
        calendar_name: calendar_name.into(),
    })
}

/// Map one calendarList entry to `(calendar, shown in Google's UI)`.
pub fn map_calendar(item: &Value) -> Option<(CalendarInfo, bool)> {
    let id = item.get("id")?.as_str()?;
    let role = item
        .get("accessRole")
        .and_then(Value::as_str)
        .unwrap_or("reader");
    if role == "freeBusyReader" || item.get("deleted").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let name = item
        .get("summaryOverride")
        .or_else(|| item.get("summary"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(id);
    let primary = item.get("primary").and_then(Value::as_bool) == Some(true);
    let shown = primary || item.get("selected").and_then(Value::as_bool) == Some(true);
    Some((
        CalendarInfo {
            id: id.into(),
            name: name.into(),
            writable: matches!(role, "owner" | "writer"),
        },
        shown,
    ))
}

/// Map one Tasks API task. Completed, deleted and hidden tasks are dropped.
pub fn map_task(item: &Value, list_id: &str, list_name: &str) -> Option<ReminderInfo> {
    let done = item.get("status").and_then(Value::as_str) == Some("completed")
        || item.get("deleted").and_then(Value::as_bool) == Some(true)
        || item.get("hidden").and_then(Value::as_bool) == Some(true);
    if done {
        return None;
    }
    let id = item.get("id")?.as_str()?;
    // The Tasks API keeps only the date of `due`; read it as that local day.
    let due = item
        .get("due")
        .and_then(Value::as_str)
        .and_then(|due| due.get(..10))
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        .and_then(local_midnight);
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty());
    Some(ReminderInfo {
        id: join_parts(&[list_id, id]),
        title: title.unwrap_or("Reminder").into(),
        due,
        list_id: list_id.into(),
        list_name: list_name.into(),
        completed: false,
    })
}

/// `2026-11-20T00:00:00.000Z` for the local date of `due`.
pub fn task_due(due: DateTime<Utc>) -> String {
    format!(
        "{}T00:00:00.000Z",
        due.with_timezone(&Local).format("%Y-%m-%d")
    )
}

impl Google {
    pub fn new(
        transport: Arc<dyn Transport>,
        endpoints: GoogleEndpoints,
        account: String,
        client: OAuthClient,
        refresh_token: String,
        tokens: Arc<TokenCache>,
    ) -> Self {
        Self {
            transport,
            endpoints,
            account,
            client,
            refresh_token,
            tokens,
        }
    }

    async fn access_token(&self, force: bool) -> ProviderResult<String> {
        if !force && let Some(token) = self.tokens.get(&self.account) {
            return Ok(token);
        }
        let mut pairs = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", self.refresh_token.as_str()),
            ("client_id", self.client.id.as_str()),
        ];
        if let Some(secret) = self
            .client
            .secret
            .as_deref()
            .filter(|secret| !secret.is_empty())
        {
            pairs.push(("client_secret", secret));
        }
        let request = HttpRequest::new("POST", &self.endpoints.token)
            .body("application/x-www-form-urlencoded", form(&pairs));
        let tokens = parse_tokens(
            &self
                .transport
                .send(request)
                .await
                .map_err(|_| ProviderError::Unavailable)?,
        )?;
        self.tokens
            .put(&self.account, tokens.access.clone(), tokens.expires_in);
        Ok(tokens.access)
    }

    fn url(&self, segments: &[&str], query: &[(&str, &str)]) -> ProviderResult<Url> {
        let mut url = Url::parse(&self.endpoints.api).map_err(|_| ProviderError::Unavailable)?;
        url.path_segments_mut()
            .map_err(|_| ProviderError::Unavailable)?
            .pop_if_empty()
            .extend(segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url)
    }

    /// Call the API, refreshing the access token once on a 401.
    async fn call(
        &self,
        method: &str,
        url: &Url,
        body: Option<&Value>,
        write: bool,
    ) -> ProviderResult<Value> {
        for attempt in 0..2 {
            let token = self.access_token(attempt > 0).await?;
            let mut request = HttpRequest::new(method, url.as_str())
                .header("Authorization", format!("Bearer {token}"));
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = self
                .transport
                .send(request)
                .await
                .map_err(|_| ProviderError::Unavailable)?;
            match response.status {
                200..=299 => return Ok(response.json().unwrap_or(Value::Null)),
                401 if attempt == 0 => {
                    self.tokens.forget(&self.account);
                    continue;
                }
                401 => return Err(ProviderError::Auth),
                403 if write => return Err(ProviderError::ReadOnly),
                404 | 410 => return Err(ProviderError::NotFound),
                _ => return Err(ProviderError::Unavailable),
            }
        }
        Err(ProviderError::Unavailable)
    }

    async fn paged(&self, segments: &[&str], query: &[(&str, &str)]) -> ProviderResult<Vec<Value>> {
        let mut items = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut pairs = query.to_vec();
            if let Some(token) = page_token.as_deref() {
                pairs.push(("pageToken", token));
            }
            let body = self
                .call("GET", &self.url(segments, &pairs)?, None, false)
                .await?;
            items.extend(
                body.get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            page_token = body
                .get("nextPageToken")
                .and_then(Value::as_str)
                .map(str::to_string);
            if page_token.is_none() {
                break;
            }
        }
        Ok(items)
    }

    async fn calendar_list(&self) -> ProviderResult<Vec<(CalendarInfo, bool)>> {
        let items = self
            .paged(
                &["calendar", "v3", "users", "me", "calendarList"],
                &[("maxResults", "250"), ("minAccessRole", "reader")],
            )
            .await?;
        Ok(items.iter().filter_map(map_calendar).collect())
    }

    async fn task_lists(&self) -> ProviderResult<Vec<ListInfo>> {
        let items = self
            .paged(
                &["tasks", "v1", "users", "@me", "lists"],
                &[("maxResults", "100")],
            )
            .await?;
        Ok(items
            .iter()
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?;
                let name = item
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("Tasks");
                Some(ListInfo {
                    id: id.into(),
                    name: name.into(),
                    writable: true,
                })
            })
            .collect())
    }

    /// The account address (the primary calendar's id), used to label it.
    pub async fn primary_email(&self) -> ProviderResult<String> {
        let url = self.url(
            &["calendar", "v3", "users", "me", "calendarList", "primary"],
            &[],
        )?;
        let body = self.call("GET", &url, None, false).await?;
        body.get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(ProviderError::Unavailable)
    }
}

fn time_body(draft: &EventDraft) -> Value {
    json!({
        "summary": draft.title,
        // `date: null` turns an all-day event into a timed one on update.
        "start": { "dateTime": iso(draft.start), "date": null },
        "end": { "dateTime": iso(draft.end), "date": null },
    })
}

#[async_trait]
impl Provider for Google {
    async fn calendars(&self) -> ProviderResult<Vec<CalendarInfo>> {
        Ok(self
            .calendar_list()
            .await?
            .into_iter()
            .map(|(calendar, _)| calendar)
            .collect())
    }

    async fn events(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> ProviderResult<Vec<EventInfo>> {
        let calendars: Vec<CalendarInfo> = self
            .calendar_list()
            .await?
            .into_iter()
            .filter(|(_, shown)| *shown)
            .map(|(calendar, _)| calendar)
            .take(MAX_CALENDARS)
            .collect();
        let (time_min, time_max) = (iso(start), iso(end));
        let mut events = Vec::new();
        let mut failures = 0;
        for calendar in &calendars {
            let url = self.url(
                &["calendar", "v3", "calendars", &calendar.id, "events"],
                &[
                    ("timeMin", &time_min),
                    ("timeMax", &time_max),
                    ("singleEvents", "true"),
                    ("orderBy", "startTime"),
                    ("maxResults", "50"),
                ],
            )?;
            match self.call("GET", &url, None, false).await {
                Ok(body) => events.extend(
                    body.get("items")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|item| map_event(item, &calendar.id, &calendar.name)),
                ),
                Err(ProviderError::Auth) => return Err(ProviderError::Auth),
                Err(_) => failures += 1,
            }
        }
        if failures > 0 && failures == calendars.len() {
            return Err(ProviderError::Unavailable);
        }
        Ok(events)
    }

    async fn create_event(&self, calendar_id: &str, draft: &EventDraft) -> ProviderResult<()> {
        let url = self.url(&["calendar", "v3", "calendars", calendar_id, "events"], &[])?;
        let mut body = time_body(draft);
        for key in ["start", "end"] {
            if let Some(object) = body.get_mut(key).and_then(Value::as_object_mut) {
                object.remove("date");
            }
        }
        self.call("POST", &url, Some(&body), true).await.map(|_| ())
    }

    async fn update_event(
        &self,
        event_id: &str,
        calendar_id: &str,
        draft: &EventDraft,
    ) -> ProviderResult<()> {
        let parts = split_parts(event_id, 2).ok_or(ProviderError::NotFound)?;
        if parts[0] != calendar_id {
            return Err(ProviderError::Unsupported(
                "Moving an event to another calendar isn't supported yet.",
            ));
        }
        let url = self.url(
            &[
                "calendar",
                "v3",
                "calendars",
                &parts[0],
                "events",
                &parts[1],
            ],
            &[],
        )?;
        self.call("PATCH", &url, Some(&time_body(draft)), true)
            .await
            .map(|_| ())
    }

    async fn reminder_lists(&self) -> ProviderResult<Vec<ListInfo>> {
        self.task_lists().await
    }

    async fn reminders(&self) -> ProviderResult<Vec<ReminderInfo>> {
        let mut reminders = Vec::new();
        for list in self.task_lists().await?.into_iter().take(MAX_CALENDARS) {
            let items = self
                .paged(
                    &["tasks", "v1", "lists", &list.id, "tasks"],
                    &[
                        ("showCompleted", "false"),
                        ("showHidden", "false"),
                        ("maxResults", "100"),
                    ],
                )
                .await;
            match items {
                Ok(items) => reminders.extend(
                    items
                        .iter()
                        .filter_map(|item| map_task(item, &list.id, &list.name)),
                ),
                Err(ProviderError::Auth) => return Err(ProviderError::Auth),
                Err(_) => {}
            }
        }
        Ok(reminders)
    }

    async fn create_reminder(&self, list_id: &str, draft: &ReminderDraft) -> ProviderResult<()> {
        let url = self.url(&["tasks", "v1", "lists", list_id, "tasks"], &[])?;
        let mut body = json!({ "title": draft.title });
        if let Some(notes) = draft.notes.as_deref().filter(|notes| !notes.is_empty()) {
            body["notes"] = json!(notes);
        }
        if let Some(due) = draft.due {
            body["due"] = json!(task_due(due));
        }
        self.call("POST", &url, Some(&body), true).await.map(|_| ())
    }

    async fn complete_reminder(&self, reminder_id: &str) -> ProviderResult<()> {
        let parts = split_parts(reminder_id, 2).ok_or(ProviderError::NotFound)?;
        let url = self.url(
            &["tasks", "v1", "lists", &parts[0], "tasks", &parts[1]],
            &[],
        )?;
        self.call("PATCH", &url, Some(&json!({ "status": "completed" })), true)
            .await
            .map(|_| ())
    }

    async fn default_reminder_list(&self) -> Option<String> {
        // Google returns the default list first.
        self.task_lists()
            .await
            .ok()?
            .into_iter()
            .next()
            .map(|list| list.id)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::http::TransportError;

    /// Answers by `METHOD path` prefix (query ignored) and records requests.
    #[derive(Default)]
    pub struct FakeGoogle {
        pub routes: Mutex<Vec<(String, u16, Value)>>,
        pub requests: Mutex<Vec<HttpRequest>>,
    }

    impl FakeGoogle {
        pub fn route(&self, key: &str, status: u16, body: Value) {
            self.routes.lock().unwrap().push((key.into(), status, body));
        }
    }

    #[async_trait]
    impl Transport for FakeGoogle {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
            self.requests.lock().unwrap().push(request.clone());
            let url = Url::parse(&request.url).map_err(|_| TransportError)?;
            let key = format!("{} {}", request.method, url.path());
            let routes = self.routes.lock().unwrap();
            let found = routes.iter().rev().find(|(route, _, _)| *route == key);
            Ok(match found {
                Some((_, status, body)) => HttpResponse {
                    status: *status,
                    headers: vec![],
                    body: serde_json::to_vec(body).unwrap(),
                },
                None => HttpResponse {
                    status: 404,
                    ..HttpResponse::default()
                },
            })
        }
    }

    pub fn endpoints() -> GoogleEndpoints {
        GoogleEndpoints {
            auth: "https://accounts.google.test/auth".into(),
            token: "https://oauth.google.test/token".into(),
            api: "https://api.google.test".into(),
        }
    }

    pub fn standard(fake: &FakeGoogle) {
        fake.route(
            "POST /token",
            200,
            json!({ "access_token": "at-1", "expires_in": 3600 }),
        );
        fake.route(
            "GET /calendar/v3/users/me/calendarList",
            200,
            json!({ "items": [
                { "id": "me@gmail.com", "summary": "me@gmail.com", "summaryOverride": "Personal", "accessRole": "owner", "primary": true },
                { "id": "en.usa#holiday@group.v.calendar.google.com", "summary": "Holidays", "accessRole": "reader", "selected": true },
                { "id": "hidden@group.calendar.google.com", "summary": "Hidden", "accessRole": "writer", "selected": false },
                { "id": "busy@x", "summary": "Busy", "accessRole": "freeBusyReader", "selected": true }
            ]}),
        );
        fake.route(
            "GET /calendar/v3/calendars/me@gmail.com/events",
            200,
            json!({ "items": [
                { "id": "ev1", "summary": "Dentist", "start": { "dateTime": "2026-11-13T10:00:00+01:00" }, "end": { "dateTime": "2026-11-13T11:00:00+01:00" } },
                { "id": "ev2", "status": "cancelled", "start": { "dateTime": "2026-11-13T10:00:00Z" } }
            ]}),
        );
        fake.route(
            "GET /calendar/v3/calendars/en.usa%23holiday@group.v.calendar.google.com/events",
            200,
            json!({ "items": [ { "id": "h1", "summary": "Thanksgiving", "start": { "date": "2026-11-26" }, "end": { "date": "2026-11-27" } } ]}),
        );
        fake.route(
            "GET /tasks/v1/users/@me/lists",
            200,
            json!({ "items": [ { "id": "L1", "title": "My Tasks" } ] }),
        );
        fake.route(
            "GET /tasks/v1/lists/L1/tasks",
            200,
            json!({ "items": [
                { "id": "t1", "title": "Pay rent", "due": "2026-12-01T00:00:00.000Z", "status": "needsAction" },
                { "id": "t2", "title": "Done", "status": "completed" }
            ]}),
        );
    }

    pub fn google(fake: Arc<FakeGoogle>, tokens: Arc<TokenCache>) -> Google {
        Google::new(
            fake,
            endpoints(),
            "acct".into(),
            OAuthClient {
                id: "cid".into(),
                secret: Some("csecret".into()),
            },
            "rt-1".into(),
            tokens,
        )
    }

    #[test]
    fn maps_timed_all_day_and_untitled_events() {
        let timed = map_event(&json!({ "id": "a", "start": { "dateTime": "2026-11-13T10:00:00+01:00" }, "end": { "dateTime": "2026-11-13T10:30:00+01:00" } }), "cal", "Cal").unwrap();
        assert_eq!(iso(timed.start), "2026-11-13T09:00:00Z");
        assert_eq!(timed.title, "Untitled event");
        assert!(!timed.all_day);
        assert_eq!(split_parts(&timed.id, 2).unwrap(), vec!["cal", "a"]);
        let all_day = map_event(&json!({ "id": "b", "summary": "Trip", "start": { "date": "2026-11-26" }, "end": { "date": "2026-11-28" } }), "cal", "Cal").unwrap();
        assert!(all_day.all_day);
        assert_eq!(all_day.end - all_day.start, chrono::Duration::days(2));
        assert!(
            map_event(
                &json!({ "id": "c", "status": "cancelled", "start": { "date": "2026-11-26" } }),
                "cal",
                "Cal"
            )
            .is_none()
        );
        assert!(map_event(&json!({ "id": "d" }), "cal", "Cal").is_none());
    }

    #[test]
    fn maps_calendar_roles_and_visibility() {
        let (owner, shown) = map_calendar(&json!({ "id": "x", "summary": "S", "summaryOverride": "Mine", "accessRole": "owner", "primary": true })).unwrap();
        assert_eq!(
            (owner.name.as_str(), owner.writable, shown),
            ("Mine", true, true)
        );
        let (reader, shown) =
            map_calendar(&json!({ "id": "y", "summary": "Hol", "accessRole": "reader" })).unwrap();
        assert!(!reader.writable && !shown);
        assert!(map_calendar(&json!({ "id": "z", "accessRole": "freeBusyReader" })).is_none());
    }

    #[test]
    fn maps_tasks_to_local_due_dates() {
        let task = map_task(
            &json!({ "id": "t", "title": " Pay ", "due": "2026-12-01T00:00:00.000Z" }),
            "L",
            "List",
        )
        .unwrap();
        assert_eq!(task.title, "Pay");
        let local = task.due.unwrap().with_timezone(&Local);
        assert_eq!(
            local.format("%Y-%m-%d %H:%M").to_string(),
            "2026-12-01 00:00"
        );
        assert!(map_task(&json!({ "id": "t", "status": "completed" }), "L", "List").is_none());
        assert!(map_task(&json!({ "id": "t", "hidden": true }), "L", "List").is_none());
        let due = Local
            .with_ymd_and_hms(2026, 12, 1, 18, 30, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(task_due(due), "2026-12-01T00:00:00.000Z");
    }

    #[tokio::test]
    async fn reads_shown_calendars_with_one_token_refresh() {
        let fake = Arc::new(FakeGoogle::default());
        standard(&fake);
        let provider = google(fake.clone(), Arc::new(TokenCache::default()));
        let start = parse_iso("2026-11-12T00:00:00Z").unwrap();
        let events = provider
            .events(start, start + chrono::Duration::days(14))
            .await
            .unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Dentist", "Thanksgiving"]
        );
        assert_eq!(events[0].calendar_name, "Personal");
        let requests = fake.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url.ends_with("/token"))
                .count(),
            1,
            "the access token is cached"
        );
        let token = String::from_utf8(requests[0].body.clone()).unwrap();
        assert!(
            token.contains("grant_type=refresh_token")
                && token.contains("refresh_token=rt-1")
                && token.contains("client_secret=csecret")
        );
        let listed = requests
            .iter()
            .find(|request| request.url.contains("/events?"))
            .unwrap();
        assert!(
            listed.url.contains("singleEvents=true")
                && listed.url.contains("timeMin=2026-11-12T00%3A00%3A00Z")
        );
        assert_eq!(listed.header_value("Authorization"), Some("Bearer at-1"));
        assert!(!requests.iter().any(|request| request.url.contains("hidden%40") || request.url.contains("hidden@")));
    }

    #[tokio::test]
    async fn a_revoked_refresh_token_is_an_auth_error() {
        let fake = Arc::new(FakeGoogle::default());
        fake.route("POST /token", 400, json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }));
        let provider = google(fake, Arc::new(TokenCache::default()));
        assert_eq!(provider.calendars().await, Err(ProviderError::Auth));
    }

    #[tokio::test]
    async fn retries_once_after_a_401_with_a_fresh_token() {
        let fake = Arc::new(FakeGoogle::default());
        standard(&fake);
        fake.route("GET /tasks/v1/users/@me/lists", 401, json!({}));
        let tokens = Arc::new(TokenCache::default());
        tokens.put("acct", "stale".into(), 3600);
        let provider = google(fake.clone(), tokens);
        assert_eq!(provider.reminder_lists().await, Err(ProviderError::Auth));
        let requests = fake.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url.contains("/lists"))
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url.ends_with("/token"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn writes_events_and_tasks_with_the_expected_bodies() {
        let fake = Arc::new(FakeGoogle::default());
        standard(&fake);
        fake.route(
            "POST /calendar/v3/calendars/me@gmail.com/events",
            200,
            json!({ "id": "new" }),
        );
        fake.route(
            "PATCH /calendar/v3/calendars/me@gmail.com/events/ev1",
            200,
            json!({}),
        );
        fake.route("POST /tasks/v1/lists/L1/tasks", 200, json!({ "id": "t9" }));
        fake.route("PATCH /tasks/v1/lists/L1/tasks/t1", 200, json!({}));
        let provider = google(fake.clone(), Arc::new(TokenCache::default()));
        let start = parse_iso("2026-11-20T10:00:00Z").unwrap();
        let draft = EventDraft {
            title: "Sync".into(),
            start,
            end: start + chrono::Duration::hours(1),
        };
        provider.create_event("me@gmail.com", &draft).await.unwrap();
        provider
            .update_event(
                &join_parts(&["me@gmail.com", "ev1"]),
                "me@gmail.com",
                &draft,
            )
            .await
            .unwrap();
        assert!(matches!(
            provider
                .update_event(&join_parts(&["me@gmail.com", "ev1"]), "other", &draft)
                .await,
            Err(ProviderError::Unsupported(_))
        ));
        provider
            .create_reminder(
                "L1",
                &ReminderDraft {
                    title: "Call".into(),
                    due: None,
                    notes: Some("n".into()),
                },
            )
            .await
            .unwrap();
        provider
            .complete_reminder(&join_parts(&["L1", "t1"]))
            .await
            .unwrap();
        let requests = fake.requests.lock().unwrap();
        let bodies: Vec<Value> = requests
            .iter()
            .filter(|request| request.method != "GET" && !request.url.ends_with("/token"))
            .map(|request| serde_json::from_slice(&request.body).unwrap())
            .collect();
        assert_eq!(
            bodies[0],
            json!({ "summary": "Sync", "start": { "dateTime": "2026-11-20T10:00:00Z" }, "end": { "dateTime": "2026-11-20T11:00:00Z" } })
        );
        assert_eq!(
            bodies[1]["start"],
            json!({ "dateTime": "2026-11-20T10:00:00Z", "date": null })
        );
        assert_eq!(bodies[2], json!({ "title": "Call", "notes": "n" }));
        assert_eq!(bodies[3], json!({ "status": "completed" }));
    }

    #[tokio::test]
    async fn read_only_writes_map_to_read_only() {
        let fake = Arc::new(FakeGoogle::default());
        standard(&fake);
        fake.route(
            "POST /calendar/v3/calendars/ro/events",
            403,
            json!({ "error": { "message": "secret detail" } }),
        );
        let provider = google(fake, Arc::new(TokenCache::default()));
        let start = Utc::now();
        let result = provider
            .create_event(
                "ro",
                &EventDraft {
                    title: "x".into(),
                    start,
                    end: start,
                },
            )
            .await;
        assert_eq!(result, Err(ProviderError::ReadOnly));
    }

    #[test]
    fn authorization_url_uses_pkce_offline_access_and_loopback_redirect() {
        let url = authorization_url(
            &endpoints(),
            "cid",
            "http://127.0.0.1:5555/callback",
            "st",
            "ch",
        );
        let parsed = Url::parse(&url).unwrap();
        let query: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["code_challenge"], "ch");
        assert_eq!(query["redirect_uri"], "http://127.0.0.1:5555/callback");
        assert_eq!(query["access_type"], "offline");
        assert_eq!(query["scope"], SCOPES.join(" "));
        assert!(!query.contains_key("client_secret"));
    }
}
