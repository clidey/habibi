//! Service-level tests: routes, native messages and provider merging, with
//! a fake EventKit, fake HTTP servers and in-memory secrets. Nothing here
//! touches the network, the Keychain or the macOS privacy prompts.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use habibi_core::{ApiRequest, ApprovalService, Paths, Routes};
use serde_json::{Value, json};

use crate::accounts::{Account, KIND_CALDAV, KIND_GOOGLE, MemorySecrets, SecretStore};
use crate::caldav::tests::{FakeDav, server as dav_server};
use crate::google::tests::{FakeGoogle, endpoints, standard as google_standard};
use crate::http::{HttpRequest, HttpResponse, Transport, TransportError};
use crate::model::*;
use crate::{CalendarService, Options};

/// Routes Google hosts to one fake and everything else to the DAV fake.
struct Fakes {
    google: Arc<FakeGoogle>,
    dav: Arc<FakeDav>,
}

#[async_trait]
impl Transport for Fakes {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        if request.url.contains("google.test") {
            self.google.send(request).await
        } else {
            self.dav.send(request).await
        }
    }
}

struct FakeSystem {
    event_access: Mutex<Access>,
    reminder_access: Mutex<Access>,
    grant_on_request: bool,
    requests: AtomicUsize,
    opened: AtomicUsize,
    events: Vec<EventInfo>,
    reminders: Mutex<Vec<ReminderInfo>>,
    created_events: Mutex<Vec<(String, EventDraft)>>,
    created_reminders: Mutex<Vec<(String, ReminderDraft)>>,
}

fn at(value: &str) -> DateTime<Utc> {
    crate::ids::parse_iso(value).unwrap()
}

impl FakeSystem {
    fn new(access: Access) -> Self {
        let now = Utc::now();
        let event = |id: &str, hours: i64, calendar: &str| EventInfo {
            id: id.into(),
            title: format!("Mac {id}"),
            start: now + chrono::Duration::hours(hours),
            end: now + chrono::Duration::hours(hours + 1),
            all_day: false,
            calendar_id: calendar.into(),
            calendar_name: if calendar == "home" {
                "Home".into()
            } else {
                "Subscribed".into()
            },
        };
        Self {
            event_access: Mutex::new(access),
            reminder_access: Mutex::new(access),
            grant_on_request: true,
            requests: AtomicUsize::new(0),
            opened: AtomicUsize::new(0),
            events: vec![event("e1", 30, "home"), event("e2", 2, "subscribed")],
            reminders: Mutex::new(vec![ReminderInfo {
                id: "r1".into(),
                title: "Mac reminder".into(),
                due: None,
                list_id: "inbox".into(),
                list_name: "Reminders".into(),
                completed: false,
            }]),
            created_events: Mutex::new(Vec::new()),
            created_reminders: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Provider for FakeSystem {
    async fn calendars(&self) -> ProviderResult<Vec<CalendarInfo>> {
        Ok(vec![
            CalendarInfo {
                id: "home".into(),
                name: "Home".into(),
                writable: true,
            },
            CalendarInfo {
                id: "subscribed".into(),
                name: "Subscribed".into(),
                writable: false,
            },
        ])
    }
    async fn events(&self, _: DateTime<Utc>, _: DateTime<Utc>) -> ProviderResult<Vec<EventInfo>> {
        Ok(self.events.clone())
    }
    async fn create_event(&self, calendar_id: &str, draft: &EventDraft) -> ProviderResult<()> {
        if calendar_id != "home" {
            return Err(ProviderError::ReadOnly);
        }
        self.created_events
            .lock()
            .unwrap()
            .push((calendar_id.into(), draft.clone()));
        Ok(())
    }
    async fn update_event(
        &self,
        event_id: &str,
        calendar_id: &str,
        draft: &EventDraft,
    ) -> ProviderResult<()> {
        self.created_events
            .lock()
            .unwrap()
            .push((format!("{event_id}@{calendar_id}"), draft.clone()));
        Ok(())
    }
    async fn reminder_lists(&self) -> ProviderResult<Vec<ListInfo>> {
        Ok(vec![
            ListInfo {
                id: "inbox".into(),
                name: "Reminders".into(),
                writable: true,
            },
            ListInfo {
                id: "shared".into(),
                name: "Shared".into(),
                writable: false,
            },
        ])
    }
    async fn reminders(&self) -> ProviderResult<Vec<ReminderInfo>> {
        Ok(self.reminders.lock().unwrap().clone())
    }
    async fn create_reminder(&self, list_id: &str, draft: &ReminderDraft) -> ProviderResult<()> {
        self.created_reminders
            .lock()
            .unwrap()
            .push((list_id.into(), draft.clone()));
        Ok(())
    }
    async fn complete_reminder(&self, reminder_id: &str) -> ProviderResult<()> {
        let mut reminders = self.reminders.lock().unwrap();
        let before = reminders.len();
        reminders.retain(|reminder| reminder.id != reminder_id);
        if reminders.len() == before {
            Err(ProviderError::NotFound)
        } else {
            Ok(())
        }
    }
    async fn default_reminder_list(&self) -> Option<String> {
        Some("inbox".into())
    }
}

#[async_trait]
impl SystemStore for FakeSystem {
    fn access(&self, entity: Entity) -> Access {
        match entity {
            Entity::Event => *self.event_access.lock().unwrap(),
            Entity::Reminder => *self.reminder_access.lock().unwrap(),
        }
    }
    async fn request_access(&self, entity: Entity) -> bool {
        self.requests.fetch_add(1, Ordering::SeqCst);
        if self.grant_on_request {
            match entity {
                Entity::Event => *self.event_access.lock().unwrap() = Access::Full,
                Entity::Reminder => *self.reminder_access.lock().unwrap() = Access::Full,
            }
        }
        self.grant_on_request
    }
    fn open_settings(&self, _: Entity) -> bool {
        self.opened.fetch_add(1, Ordering::SeqCst);
        true
    }
}

struct Harness {
    service: Arc<CalendarService>,
    approvals: Arc<ApprovalService>,
    secrets: Arc<MemorySecrets>,
    google: Arc<FakeGoogle>,
    dav: Arc<FakeDav>,
    opened_urls: Arc<Mutex<Vec<String>>>,
    _directory: tempfile::TempDir,
    paths: Paths,
}

fn harness(system: Option<Arc<FakeSystem>>) -> Harness {
    let directory = tempfile::tempdir().unwrap();
    let paths = Paths::new(directory.path(), directory.path(), directory.path());
    let approvals = Arc::new(ApprovalService::default());
    let secrets = Arc::new(MemorySecrets::default());
    let google = Arc::new(FakeGoogle::default());
    let dav = dav_server();
    let opened_urls = Arc::new(Mutex::new(Vec::new()));
    let opened = opened_urls.clone();
    let options = Options {
        transport: Arc::new(Fakes {
            google: google.clone(),
            dav: dav.clone(),
        }),
        secrets: secrets.clone(),
        system: system.map(|system| system as Arc<dyn SystemStore>),
        google: endpoints(),
        open_url: Arc::new(move |url| {
            opened.lock().unwrap().push(url.to_string());
            true
        }),
        sign_in_timeout: Duration::from_secs(5),
    };
    let service = CalendarService::with_options(paths.clone(), approvals.clone(), options);
    Harness {
        service,
        approvals,
        secrets,
        google,
        dav,
        opened_urls,
        _directory: directory,
        paths,
    }
}

impl Harness {
    async fn get(&self, path: &str) -> Value {
        self.service
            .handle(&ApiRequest::get(path))
            .await
            .unwrap()
            .json_value()
            .unwrap()
    }
    async fn post(&self, path: &str, body: Value) -> Value {
        self.service
            .handle(&ApiRequest::post(path, &body))
            .await
            .unwrap()
            .json_value()
            .unwrap()
    }
    async fn native(&self, message: Value) -> Value {
        self.service.native_message(&message).await.unwrap()
    }
    async fn daily(&self, action: &str, extra: Value) -> Value {
        let mut message =
            json!({ "type": "dailyUtility", "action": action, "requestId": "daily-1" });
        message
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.native(message).await
    }
    fn add_google(&self) -> String {
        google_standard(&self.google);
        let account = Account {
            id: "g1".into(),
            kind: KIND_GOOGLE.into(),
            label: "Google".into(),
            username: "me@gmail.com".into(),
            client_id: Some("cid".into()),
            client_source: Some("own".into()),
            calendars: true,
            reminders: true,
            ..Account::default()
        };
        self.secrets.set(&account.secret_name("refresh"), "rt");
        crate::accounts::AccountStore::new(self.paths.state("calendar-accounts.json"))
            .upsert(&account)
            .unwrap();
        account.id
    }
    fn add_caldav(&self) -> String {
        let account = Account {
            id: "d1".into(),
            kind: KIND_CALDAV.into(),
            label: "Fastmail".into(),
            username: "me@example.com".into(),
            server_url: Some(crate::caldav::tests::BASE.into()),
            home_url: Some(crate::caldav::tests::HOME.into()),
            calendars: true,
            reminders: true,
            ..Account::default()
        };
        self.secrets.set(&account.secret_name("password"), "pw");
        crate::accounts::AccountStore::new(self.paths.state("calendar-accounts.json"))
            .upsert(&account)
            .unwrap();
        account.id
    }
    async fn approved(&self, path: &str, action: &str, payload: Value) -> Value {
        let token = self.approvals.issue(action, payload.clone()).token;
        let mut body = payload;
        body["approvalToken"] = json!(token);
        self.post(path, body).await
    }
}

#[tokio::test]
async fn messages_owned_elsewhere_are_not_answered() {
    let h = harness(None);
    for message in [
        json!({ "type": "dailyUtility", "action": "clipboard.state" }),
        json!({ "type": "dailyUtility", "action": "focus" }),
        json!({ "type": "contacts" }),
        json!({ "type": "dailyUtility" }),
        json!({}),
    ] {
        assert_eq!(h.service.native_message(&message).await, None, "{message}");
    }
    let request = ApiRequest::get("/api/mail/status");
    assert!(h.service.handle(&request).await.is_none());
}

#[tokio::test]
async fn calendar_events_report_reasons_without_prompting() {
    for (access, reason) in [
        (Access::NotDetermined, "notDetermined"),
        (Access::Denied, "denied"),
        (Access::WriteOnly, "writeOnly"),
    ] {
        let system = Arc::new(FakeSystem::new(access));
        let h = harness(Some(system.clone()));
        let reply = h.native(json!({ "type": "calendarEvents" })).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["events"], json!([]));
        assert_eq!(reply["reason"], reason);
        assert_eq!(
            system.requests.load(Ordering::SeqCst),
            0,
            "reads never prompt"
        );
    }
    let h = harness(None);
    let reply = h.native(json!({ "type": "calendarEvents" })).await;
    assert_eq!(
        (reply["ok"].clone(), reply["reason"].clone()),
        (json!(false), json!("noAccounts"))
    );
}

#[tokio::test]
async fn calendar_events_merge_sources_sorted_with_qualified_ids() {
    let system = Arc::new(FakeSystem::new(Access::Full));
    let h = harness(Some(system));
    h.add_google();
    let reply = h.native(json!({ "type": "calendarEvents" })).await;
    assert_eq!(reply["ok"], true, "{reply}");
    let events = reply["events"].as_array().unwrap();
    let starts: Vec<&str> = events
        .iter()
        .map(|event| event["start"].as_str().unwrap())
        .collect();
    let mut sorted = starts.clone();
    sorted.sort();
    assert_eq!(starts, sorted);
    let ids: Vec<&str> = events
        .iter()
        .map(|event| event["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"system:e1"));
    assert!(ids.iter().any(|id| id.starts_with("g1:me@gmail.com/ev1")));
    let dentist = events.iter().find(|event| event["title"] == "Dentist");
    // The fixed Google fixtures may fall outside "now + 14 days"; the fake
    // returns them regardless, which is what this merge test needs.
    let dentist = dentist.unwrap();
    assert_eq!(dentist["calendar"], "Personal");
    assert_eq!(dentist["calendarId"], "g1:me@gmail.com");
    assert_eq!(dentist["account"], "Google (me@gmail.com)");
    for event in events {
        for key in ["id", "title", "start", "end", "calendar"] {
            assert!(event[key].is_string(), "Swift shape kept: {key}");
        }
    }
}

#[tokio::test]
async fn a_failing_account_does_not_hide_the_others() {
    let system = Arc::new(FakeSystem::new(Access::Full));
    let h = harness(Some(system));
    h.add_google();
    h.google
        .route("POST /token", 400, json!({ "error": "invalid_grant" }));
    let reply = h.native(json!({ "type": "calendarEvents" })).await;
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["events"].as_array().unwrap().len(), 2);
    assert_eq!(reply["unavailable"][0]["reconnect"], true);
    assert!(
        !reply.to_string().contains("invalid_grant"),
        "provider errors never reach the UI"
    );
}

#[tokio::test]
async fn events_are_capped_at_thirty() {
    let mut system = FakeSystem::new(Access::Full);
    let now = Utc::now();
    system.events = (0..45)
        .map(|index| EventInfo {
            id: format!("e{index}"),
            title: "x".into(),
            start: now + chrono::Duration::minutes(45 - index),
            end: now + chrono::Duration::minutes(46 - index),
            all_day: false,
            calendar_id: "home".into(),
            calendar_name: "Home".into(),
        })
        .collect();
    let h = harness(Some(Arc::new(system)));
    let reply = h.native(json!({ "type": "calendarEvents" })).await;
    let events = reply["events"].as_array().unwrap();
    assert_eq!(events.len(), 30);
    assert_eq!(events[0]["id"], "system:e44");
}

#[tokio::test]
async fn calendar_access_prompts_only_when_asked_and_matches_swift_reply() {
    let system = Arc::new(FakeSystem::new(Access::NotDetermined));
    let h = harness(Some(system.clone()));
    let reply = h.native(json!({ "type": "calendarAccess" })).await;
    assert_eq!(
        reply,
        json!({ "ok": true, "reason": "writeOnly", "message": "" })
    );
    assert_eq!(system.requests.load(Ordering::SeqCst), 1);

    let mut denied = FakeSystem::new(Access::Denied);
    denied.grant_on_request = false;
    let h = harness(Some(Arc::new(denied)));
    let reply = h.native(json!({ "type": "calendarAccess" })).await;
    assert_eq!(
        reply,
        json!({ "ok": false, "reason": "denied", "message": "Calendar access was not granted." })
    );

    let h = harness(None);
    let reply = h.native(json!({ "type": "calendarAccess" })).await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["openSettings"], "calendar-accounts");
}

#[tokio::test]
async fn calendars_route_keeps_names_and_adds_qualified_writable_items() {
    let h = harness(Some(Arc::new(FakeSystem::new(Access::Full))));
    h.add_google();
    let reply = h.get("/api/calendars").await;
    assert_eq!(reply["ok"], true);
    assert_eq!(
        reply["calendars"],
        json!(["Home", "Personal", "Hidden"]),
        "read-only calendars are not offered"
    );
    assert_eq!(reply["items"][0]["id"], "system:home");
    assert_eq!(reply["items"][1]["id"], "g1:me@gmail.com");
    assert_eq!(
        reply["items"][1]["label"],
        "Personal · Google (me@gmail.com)"
    );

    let empty = harness(None).get("/api/calendars").await;
    assert_eq!(
        empty,
        json!({ "ok": false, "calendars": [], "needsAccount": true })
    );
}

#[tokio::test]
async fn creating_an_event_needs_an_approval_bound_to_the_payload() {
    let system = Arc::new(FakeSystem::new(Access::Full));
    let h = harness(Some(system.clone()));
    let payload = json!({ "title": "Lunch", "calendar": "system:home", "start": "2026-11-20T12:30:00.000Z", "end": "2026-11-20T13:30:00.000Z" });
    let refused = h.post("/api/calendar/event", payload.clone()).await;
    assert_eq!(
        refused,
        json!({ "ok": false, "error": "Calendar creation needs explicit approval" })
    );

    // A token for different details does not authorize this event.
    let token = h
        .approvals
        .issue(
            "calendar.create",
            json!({ "title": "Other", "calendar": "system:home", "start": "x", "end": "y" }),
        )
        .token;
    let mut body = payload.clone();
    body["approvalToken"] = json!(token);
    assert_eq!(h.post("/api/calendar/event", body).await["ok"], false);
    assert!(system.created_events.lock().unwrap().is_empty());

    assert_eq!(
        h.approved("/api/calendar/event", "calendar.create", payload)
            .await,
        json!({ "ok": true })
    );
    // An older UI sends the calendar's name.
    let by_name = json!({ "title": "Gym", "calendar": "Home", "start": "2026-11-21T08:00:00Z", "end": "2026-11-21T09:00:00Z" });
    assert_eq!(
        h.approved("/api/calendar/event", "calendar.create", by_name)
            .await,
        json!({ "ok": true })
    );
    let created = system.created_events.lock().unwrap().clone();
    assert_eq!(created.len(), 2);
    assert_eq!(created[0].0, "home");
    assert_eq!(created[0].1.title, "Lunch");

    let bad = json!({ "title": " ", "calendar": "system:home", "start": "2026-11-21T08:00:00Z", "end": "2026-11-21T07:00:00Z" });
    assert_eq!(
        h.approved("/api/calendar/event", "calendar.create", bad)
            .await["error"],
        "Check the event details."
    );
    let read_only = json!({ "title": "x", "calendar": "Subscribed", "start": "2026-11-21T08:00:00Z", "end": "2026-11-21T09:00:00Z" });
    assert_eq!(
        h.approved("/api/calendar/event", "calendar.create", read_only)
            .await["error"],
        "Choose a writable calendar."
    );
}

#[tokio::test]
async fn updating_an_event_routes_to_its_account_and_refuses_moves() {
    let system = Arc::new(FakeSystem::new(Access::Full));
    let h = harness(Some(system.clone()));
    h.add_google();
    let payload = json!({ "id": "system:e1", "title": "Moved", "calendar": "system:home", "start": "2026-11-20T12:30:00Z", "end": "2026-11-20T13:30:00Z" });
    assert_eq!(
        h.post("/api/calendar/event/update", payload.clone()).await["error"],
        "Calendar changes need explicit approval"
    );
    assert_eq!(
        h.approved("/api/calendar/event/update", "calendar.update", payload)
            .await,
        json!({ "ok": true })
    );
    assert_eq!(system.created_events.lock().unwrap()[0].0, "e1@home");

    let cross = json!({ "id": "system:e1", "title": "x", "calendar": "g1:me@gmail.com", "start": "2026-11-20T12:30:00Z", "end": "2026-11-20T13:30:00Z" });
    assert_eq!(
        h.approved("/api/calendar/event/update", "calendar.update", cross)
            .await["error"],
        "Moving an event to another calendar isn't supported yet."
    );
    h.google.route(
        "PATCH /calendar/v3/calendars/me@gmail.com/events/ev1",
        200,
        json!({}),
    );
    let google = json!({ "id": "g1:me@gmail.com/ev1", "title": "Dentist", "calendar": "g1:me@gmail.com", "start": "2026-11-20T12:30:00Z", "end": "2026-11-20T13:30:00Z" });
    assert_eq!(
        h.approved("/api/calendar/event/update", "calendar.update", google)
            .await,
        json!({ "ok": true })
    );
    let unknown = json!({ "id": "nobody:x", "title": "x", "calendar": "nobody:c", "start": "2026-11-20T12:30:00Z", "end": "2026-11-20T13:30:00Z" });
    assert_eq!(
        h.approved("/api/calendar/event/update", "calendar.update", unknown)
            .await["ok"],
        false
    );
}

#[tokio::test]
async fn reminders_state_merges_writable_lists_and_sorts_by_due() {
    let system = Arc::new(FakeSystem::new(Access::Full));
    let h = harness(Some(system));
    h.add_google();
    let state = h.daily("reminders.state", json!({})).await;
    assert_eq!(state["ok"], true);
    assert_eq!(state["access"], true);
    assert!(state.get("requestId").is_none(), "the shell adds requestId");
    assert_eq!(
        state["lists"],
        json!([{ "id": "system:inbox", "name": "Reminders · This Mac" }, { "id": "g1:L1", "name": "My Tasks · Google (me@gmail.com)" }])
    );
    assert_eq!(state["defaultList"], "system:inbox");
    let items = state["items"].as_array().unwrap();
    assert_eq!(items[0]["title"], "Pay rent", "dated items first");
    assert_eq!(items[1]["title"], "Mac reminder");
    assert_eq!(items[1]["due"], "");
    assert_eq!(items[0]["list"], "My Tasks");
}

#[tokio::test]
async fn reminders_without_access_match_the_swift_reply() {
    let system = Arc::new(FakeSystem::new(Access::NotDetermined));
    let h = harness(Some(system.clone()));
    let state = h.daily("reminders.state", json!({})).await;
    assert_eq!(
        state,
        json!({ "ok": true, "access": false, "reason": "notDetermined", "items": [], "lists": [] })
    );
    *system.reminder_access.lock().unwrap() = Access::Denied;
    assert_eq!(
        h.daily("reminders.state", json!({})).await["reason"],
        "denied"
    );
    assert_eq!(system.requests.load(Ordering::SeqCst), 0);

    let state = h.daily("reminders.access", json!({})).await;
    assert_eq!(system.requests.load(Ordering::SeqCst), 1);
    assert_eq!(state["access"], true);

    assert_eq!(
        h.daily("reminders.settings", json!({})).await,
        json!({ "ok": true })
    );
    assert_eq!(system.opened.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.daily("reminders.nope", json!({})).await,
        json!({ "ok": false, "error": "This utility action is unavailable." })
    );
}

#[tokio::test]
async fn without_a_system_store_reminders_point_at_account_settings() {
    let h = harness(None);
    let state = h.daily("reminders.state", json!({})).await;
    assert_eq!(state["access"], false);
    assert_eq!(state["reason"], "noAccounts");
    assert_eq!(
        h.daily("reminders.settings", json!({})).await,
        json!({ "ok": true, "openSettings": "calendar-accounts" })
    );
    assert_eq!(
        h.daily("reminders.access", json!({})).await["openSettings"],
        "calendar-accounts"
    );

    h.add_google();
    let state = h.daily("reminders.state", json!({})).await;
    assert_eq!(state["access"], true);
    assert_eq!(
        state["lists"],
        json!([{ "id": "g1:L1", "name": "My Tasks" }])
    );
    assert_eq!(state["defaultList"], "g1:L1");
}

#[tokio::test]
async fn reminder_writes_keep_the_swift_guards() {
    let system = Arc::new(FakeSystem::new(Access::Full));
    let h = harness(Some(system.clone()));
    let review = "Review the reminder and allow Reminders access before saving.";
    assert_eq!(
        h.daily("reminders.create", json!({ "title": "Call" }))
            .await["error"],
        review,
        "needs approved: true"
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "Call", "approved": "true" })
        )
        .await["error"],
        review
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "  ", "approved": true })
        )
        .await["error"],
        review
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "x".repeat(501), "approved": true })
        )
        .await["error"],
        review
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "Call", "approved": true, "listId": "system:shared" })
        )
        .await["error"],
        "Choose a writable Reminders list."
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "Call", "approved": true, "listId": "elsewhere:inbox" })
        )
        .await["error"],
        "Choose a writable Reminders list."
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "Call", "approved": true, "due": "tomorrow" })
        )
        .await["error"],
        "Choose a valid reminder date."
    );
    assert_eq!(
        h.daily(
            "reminders.create",
            json!({ "title": "Call", "approved": true, "notes": "n".repeat(10_001) })
        )
        .await["error"],
        "The reminder note is too long."
    );
    assert!(system.created_reminders.lock().unwrap().is_empty());

    let state = h.daily("reminders.create", json!({ "title": "Call", "approved": true, "due": "2026-11-20T09:00:00.000Z", "notes": "n" })).await;
    assert_eq!(
        state["ok"], true,
        "a successful create returns the refreshed list"
    );
    let created = system.created_reminders.lock().unwrap().clone();
    assert_eq!(
        created[0].0, "inbox",
        "an empty listId uses the default list"
    );
    assert_eq!(created[0].1.due, Some(at("2026-11-20T09:00:00Z")));

    let cannot = "This reminder could not be completed.";
    assert_eq!(
        h.daily("reminders.complete", json!({ "id": "system:r1" }))
            .await["error"],
        cannot
    );
    assert_eq!(
        h.daily(
            "reminders.complete",
            json!({ "id": "x".repeat(2049), "approved": true })
        )
        .await["error"],
        cannot
    );
    assert_eq!(
        h.daily(
            "reminders.complete",
            json!({ "id": "system:missing", "approved": true })
        )
        .await["error"],
        cannot
    );
    let state = h
        .daily(
            "reminders.complete",
            json!({ "id": "system:r1", "approved": true }),
        )
        .await;
    assert_eq!(state["items"], json!([]));
}

#[tokio::test]
async fn caldav_accounts_connect_store_secrets_privately_and_remove() {
    let h = harness(None);
    let bad = h
        .post(
            "/api/calendar/accounts/caldav",
            json!({ "serverUrl": "http://dav.example.com", "username": "u", "password": "p" }),
        )
        .await;
    assert_eq!(bad["error"], "Enter an https:// CalDAV server address.");
    let reply = h
        .post(
            "/api/calendar/accounts/caldav",
            json!({ "serverUrl": crate::caldav::tests::BASE, "username": "me@example.com", "password": "abcd efgh ijkl mnop" }),
        )
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["calendars"], 2);
    assert_eq!(reply["lists"], 1);
    let id = reply["account"]["id"].as_str().unwrap().to_string();

    let file = std::fs::read_to_string(h.paths.state("calendar-accounts.json")).unwrap();
    assert!(!file.contains("abcdefghijklmnop") && !file.contains("abcd efgh"));
    assert_eq!(
        h.secrets.get(&format!("caldav:{id}:password")).as_deref(),
        Some("abcdefghijklmnop")
    );
    let listed = h.get("/api/calendar/accounts").await;
    assert_eq!(listed["accounts"][0]["connected"], true);
    assert_eq!(listed["system"], Value::Null);
    assert!(!listed.to_string().contains("abcdefghijklmnop"));

    // Reconnecting the same login reuses the account.
    h.post("/api/calendar/accounts/caldav", json!({ "serverUrl": crate::caldav::tests::BASE, "username": "me@example.com", "password": "new" })).await;
    assert_eq!(
        h.get("/api/calendar/accounts").await["accounts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    assert_eq!(
        h.post("/api/calendar/accounts/remove", json!({ "id": id }))
            .await,
        json!({ "ok": true })
    );
    assert_eq!(h.secrets.get(&format!("caldav:{id}:password")), None);
    assert_eq!(h.get("/api/calendar/accounts").await["accounts"], json!([]));
    assert_eq!(
        h.post("/api/calendar/accounts/remove", json!({ "id": id }))
            .await["ok"],
        false
    );
}

#[tokio::test]
async fn caldav_rejected_passwords_are_reported_safely() {
    let h = harness(None);
    h.dav.routes.lock().unwrap().insert(
        0,
        (
            "PROPFIND".into(),
            crate::caldav::tests::BASE.into(),
            HttpResponse {
                status: 401,
                ..HttpResponse::default()
            },
        ),
    );
    let reply = h
        .post(
            "/api/calendar/accounts/caldav",
            json!({ "serverUrl": crate::caldav::tests::BASE, "username": "u", "password": "p" }),
        )
        .await;
    assert_eq!(
        reply,
        json!({ "ok": false, "error": "The server rejected that user name or app password." })
    );
    assert!(h.secrets.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn caldav_sources_merge_into_events_and_reminders() {
    let h = harness(None);
    h.add_caldav();
    h.dav.route(
        "REPORT",
        "https://dav.example.com/dav/calendars/user/me/work/",
        207,
        &crate::caldav::tests::multistatus(&format!(
            r#"<d:response><d:href>/dav/calendars/user/me/work/a.ics</d:href><d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
DTSTART:{start}
DTEND:{start}
SUMMARY:Soon
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#,
            start = crate::ics::format_utc(Utc::now() + chrono::Duration::hours(3))
        )),
    );
    let reply = h.native(json!({ "type": "calendarEvents" })).await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["events"][0]["title"], "Soon");
    assert_eq!(
        reply["events"][0]["id"],
        "d1:https://dav.example.com/dav/calendars/user/me/work/a.ics"
    );
}

/// Drive the loopback redirect the way the browser would.
async fn redirect(url: &str, code: &str) {
    let parsed = reqwest::Url::parse(url).unwrap();
    let query: std::collections::HashMap<String, String> =
        parsed.query_pairs().into_owned().collect();
    let redirect = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", redirect.port().unwrap()))
        .await
        .unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let target = format!("/callback?state={}&code={code}", query["state"]);
    stream
        .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut page = String::new();
    let _ = stream.read_to_string(&mut page).await;
}

async fn wait_for(h: &Harness, flow: &str) -> Value {
    for _ in 0..100 {
        let status = h
            .get(&format!("/api/calendar/accounts/google/status?flow={flow}"))
            .await;
        if status["status"] != "pending" {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the sign-in never finished");
}

#[tokio::test]
async fn google_sign_in_uses_pkce_loopback_and_stores_only_secrets_in_the_store() {
    let h = harness(None);
    h.google.route(
        "POST /token",
        200,
        json!({ "access_token": "at", "refresh_token": "rt-new", "expires_in": 3600 }),
    );
    h.google.route(
        "GET /calendar/v3/users/me/calendarList/primary",
        200,
        json!({ "id": "me@gmail.com" }),
    );
    let bad = h
        .post(
            "/api/calendar/accounts/google",
            json!({ "clientId": "bad id!" }),
        )
        .await;
    assert_eq!(bad["ok"], false);

    let started = h
        .post(
            "/api/calendar/accounts/google",
            json!({ "clientId": "123-abc.apps.googleusercontent.com", "clientSecret": "GOCSPX-s" }),
        )
        .await;
    assert_eq!(started["ok"], true);
    let url = started["url"].as_str().unwrap();
    assert_eq!(h.opened_urls.lock().unwrap().as_slice(), [url.to_string()]);
    assert!(
        url.starts_with("https://accounts.google.test/auth?")
            && url.contains("code_challenge_method=S256")
    );
    let flow = started["flow"].as_str().unwrap().to_string();
    assert_eq!(
        h.get(&format!("/api/calendar/accounts/google/status?flow={flow}"))
            .await["status"],
        "pending"
    );

    redirect(url, "the-code").await;
    let status = wait_for(&h, &flow).await;
    assert_eq!(status["status"], "connected", "{status}");
    assert_eq!(status["account"]["detail"], "me@gmail.com");

    let exchange = h
        .google
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|request| request.url.ends_with("/token"))
        .cloned()
        .unwrap();
    let form = String::from_utf8(exchange.body).unwrap();
    assert!(
        form.contains("grant_type=authorization_code")
            && form.contains("code=the-code")
            && form.contains("code_verifier=")
    );
    assert!(form.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A"));

    let id = status["account"]["id"].as_str().unwrap();
    assert_eq!(
        h.secrets.get(&format!("google:{id}:refresh")).as_deref(),
        Some("rt-new")
    );
    assert_eq!(
        h.secrets
            .get(&format!("google:{id}:client-secret"))
            .as_deref(),
        Some("GOCSPX-s")
    );
    let file = std::fs::read_to_string(h.paths.state("calendar-accounts.json")).unwrap();
    assert!(!file.contains("rt-new") && !file.contains("GOCSPX") && !file.contains("\"at\""));
    let listed = h.get("/api/calendar/accounts").await.to_string();
    assert!(
        !listed.contains("rt-new")
            && !listed.contains("GOCSPX")
            && !listed.contains("googleusercontent")
    );
    assert_eq!(
        h.get("/api/calendar/accounts/google/status?flow=unknown")
            .await["ok"],
        false
    );
}

#[tokio::test]
async fn google_sign_in_can_reuse_the_mail_client_read_only() {
    let h = harness(None);
    let mail = h.paths.state("mail-providers.json");
    assert_eq!(
        h.post(
            "/api/calendar/accounts/google",
            json!({ "useMailClient": true })
        )
        .await["ok"],
        false
    );
    std::fs::create_dir_all(mail.parent().unwrap()).unwrap();
    std::fs::write(&mail, r#"{"gmail":{"clientId":"mail-client.apps","clientSecret":"mail-secret","redirectUri":"http://127.0.0.1:4173/api/mail/oauth/callback"}}"#).unwrap();
    let before = std::fs::read(&mail).unwrap();
    assert_eq!(
        h.get("/api/calendar/accounts").await["mailGoogleClient"],
        true
    );

    h.google.route(
        "POST /token",
        200,
        json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 3600 }),
    );
    h.google.route(
        "GET /calendar/v3/users/me/calendarList/primary",
        200,
        json!({ "id": "me@gmail.com" }),
    );
    let started = h
        .post(
            "/api/calendar/accounts/google",
            json!({ "useMailClient": true }),
        )
        .await;
    let url = started["url"].as_str().unwrap();
    assert!(url.contains("client_id=mail-client.apps"));
    redirect(url, "c").await;
    let status = wait_for(&h, started["flow"].as_str().unwrap()).await;
    assert_eq!(status["status"], "connected");
    assert_eq!(status["account"]["sharedClient"], true);
    let id = status["account"]["id"].as_str().unwrap();
    assert_eq!(
        h.secrets.get(&format!("google:{id}:client-secret")),
        None,
        "Mail's secret is not copied"
    );
    assert_eq!(
        std::fs::read(&mail).unwrap(),
        before,
        "mail-providers.json is never written"
    );
    let form = String::from_utf8(
        h.google
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|request| request.url.ends_with("/token"))
            .unwrap()
            .body
            .clone(),
    )
    .unwrap();
    assert!(form.contains("client_secret=mail-secret"));
}

#[tokio::test]
async fn google_sign_in_without_a_refresh_token_fails_cleanly() {
    let h = harness(None);
    h.google.route(
        "POST /token",
        200,
        json!({ "access_token": "at", "expires_in": 3600 }),
    );
    let started = h
        .post(
            "/api/calendar/accounts/google",
            json!({ "clientId": "cid" }),
        )
        .await;
    redirect(started["url"].as_str().unwrap(), "c").await;
    let status = wait_for(&h, started["flow"].as_str().unwrap()).await;
    assert_eq!(status["status"], "failed");
    assert!(status["error"].as_str().unwrap().contains("refresh token"));
    assert!(h.secrets.0.lock().unwrap().is_empty());
    assert_eq!(h.get("/api/calendar/accounts").await["accounts"], json!([]));
}
