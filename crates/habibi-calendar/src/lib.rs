//! Calendars, events and reminders for Habibi behind one provider interface
//! ([`model::Provider`]):
//!
//! - **EventKit** on macOS (the default there): every account the user added
//!   to macOS. Ported from `native/calendar-events.swift`,
//!   `native/Reminders.swift` and the calendar parts of `HabibiApp.swift`.
//! - **Google Calendar + Google Tasks** over OAuth (installed-app flow with
//!   PKCE and a loopback redirect; the user supplies the OAuth client).
//! - **CalDAV** with a user name and app password (iCloud, Fastmail,
//!   Nextcloud, …), VEVENT for events and VTODO for reminders.
//!
//! Reads merge every connected source; ids handed to the UI are qualified
//! with the account they came from (`system:…`, `<account-id>:…`).

pub mod accounts;
pub mod caldav;
mod connect;
#[cfg(target_os = "macos")]
pub mod eventkit;
mod events;
pub mod google;
pub mod http;
pub mod ics;
pub mod ids;
pub mod model;
mod native;
pub mod oauth;
pub mod service;

use std::sync::Arc;

use async_trait::async_trait;
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method, Paths, Routes, body};
use serde_json::Value;

pub use service::Options;

pub struct CalendarService {
    inner: Arc<service::Inner>,
}

impl CalendarService {
    /// The production service: real HTTP, the OS credential store under
    /// `Habibi Calendar`, and EventKit on macOS.
    pub fn new(paths: Paths, approvals: Arc<ApprovalService>) -> Arc<Self> {
        Self::with_options(paths, approvals, Options::platform())
    }

    /// The service with injected transport, secrets and system store (tests).
    pub fn with_options(
        paths: Paths,
        approvals: Arc<ApprovalService>,
        options: Options,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(service::Inner::new(paths, approvals, options)),
        })
    }

    /// Answer a `habibiNative` bridge message this service owns:
    /// `calendarAccess`, `calendarEvents`, and `dailyUtility` messages whose
    /// `action` starts with `reminders.`. Returns the reply object the Swift
    /// app produced (for `dailyUtility`, without `requestId`, which the shell
    /// adds), or `None` for messages owned by someone else.
    pub async fn native_message(&self, message: &Value) -> Option<Value> {
        match message.get("type").and_then(Value::as_str)? {
            "calendarAccess" => Some(native::calendar_access(&self.inner).await),
            "calendarEvents" => Some(native::calendar_events(&self.inner).await),
            "dailyUtility" => {
                let action = message.get("action").and_then(Value::as_str)?;
                if !action.starts_with("reminders.") {
                    return None;
                }
                Some(native::reminders(&self.inner, action, message).await)
            }
            _ => None,
        }
    }
}

#[async_trait]
impl Routes for CalendarService {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        let inner = &self.inner;
        if request.is(Method::Get, "/api/calendars") {
            return Some(events::list(inner).await);
        }
        if request.is(Method::Post, "/api/calendar/event") {
            let body = body!(request.json());
            return Some(events::create(inner, &body).await);
        }
        if request.is(Method::Post, "/api/calendar/event/update") {
            let body = body!(request.json());
            return Some(events::update(inner, &body).await);
        }
        if request.is(Method::Get, "/api/calendar/accounts") {
            return Some(connect::list(inner));
        }
        if request.is(Method::Post, "/api/calendar/accounts/google") {
            let body = body!(request.json());
            return Some(connect::start_google(inner, &body).await);
        }
        if request.is(Method::Get, "/api/calendar/accounts/google/status") {
            return Some(connect::google_status(
                inner,
                request.query("flow").unwrap_or_default(),
            ));
        }
        if request.is(Method::Post, "/api/calendar/accounts/google/cancel") {
            let body = body!(request.json());
            return Some(connect::google_cancel(
                inner,
                &habibi_core::api::text(body.get("flow")),
            ));
        }
        if request.is(Method::Post, "/api/calendar/accounts/caldav") {
            let body = body!(request.json());
            return Some(connect::connect_caldav(inner, &body).await);
        }
        if request.is(Method::Post, "/api/calendar/accounts/remove") {
            let body = body!(request.json());
            return Some(connect::remove(inner, &body));
        }
        None
    }
}

#[cfg(test)]
mod tests;
