//! The provider-neutral shapes every calendar backend maps into, and the one
//! interface they implement.
//!
//! Ids crossing this interface are *local* to the provider. The service
//! qualifies them with the account id before they reach the UI (see
//! [`crate::ids`]), so a provider never has to know about the others.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

/// One calendar a provider can show.
#[derive(Debug, Clone, PartialEq)]
pub struct CalendarInfo {
    pub id: String,
    pub name: String,
    pub writable: bool,
}

/// One event (or one occurrence of a recurring event).
#[derive(Debug, Clone, PartialEq)]
pub struct EventInfo {
    pub id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub calendar_id: String,
    pub calendar_name: String,
}

/// What the UI asked to save. Both create and update use the same fields.
#[derive(Debug, Clone, PartialEq)]
pub struct EventDraft {
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// A reminder / task list.
#[derive(Debug, Clone, PartialEq)]
pub struct ListInfo {
    pub id: String,
    pub name: String,
    pub writable: bool,
}

/// One incomplete reminder / task.
#[derive(Debug, Clone, PartialEq)]
pub struct ReminderInfo {
    pub id: String,
    pub title: String,
    pub due: Option<DateTime<Utc>>,
    pub list_id: String,
    pub list_name: String,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReminderDraft {
    pub title: String,
    pub due: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

/// Why a provider call failed. Every variant maps to a fixed, user-safe
/// message: provider errors, HTTP bodies and OS errors never reach the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// The OS has not granted access (EventKit).
    NotAuthorized,
    /// The stored credential was rejected or revoked; the user must reconnect.
    Auth,
    /// The item, calendar or list does not exist (any more).
    NotFound,
    /// The calendar or list does not accept changes.
    ReadOnly,
    /// The provider cannot do this (yet). The message is user-safe.
    Unsupported(&'static str),
    /// The request was rejected as invalid. The message is user-safe.
    Invalid(&'static str),
    /// Network failure, timeout or an unexpected response.
    Unavailable,
}

impl ProviderError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::NotAuthorized => "Calendar access has not been granted.",
            Self::Auth => "This account needs to be reconnected.",
            Self::NotFound => "That item could not be found.",
            Self::ReadOnly => "That calendar or list is read-only.",
            Self::Unsupported(message) | Self::Invalid(message) => message,
            Self::Unavailable => "The calendar service is unavailable right now.",
        }
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

/// A source of calendars, events and reminder lists.
///
/// Implemented by EventKit (macOS), Google Calendar + Tasks and CalDAV. A new
/// backend (for example Microsoft 365 over Graph) only needs to implement
/// this trait and add an account kind in [`crate::accounts`].
#[async_trait]
pub trait Provider: Send + Sync {
    /// Calendars the user can see. `writable` marks the ones events can be
    /// saved to.
    async fn calendars(&self) -> ProviderResult<Vec<CalendarInfo>>;
    /// Events overlapping `[start, end)`, recurring events expanded.
    async fn events(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> ProviderResult<Vec<EventInfo>>;
    async fn create_event(&self, calendar_id: &str, draft: &EventDraft) -> ProviderResult<()>;
    /// Change the title and times of `event_id`. `calendar_id` is the
    /// calendar the UI had selected; providers refuse to move events.
    async fn update_event(
        &self,
        event_id: &str,
        calendar_id: &str,
        draft: &EventDraft,
    ) -> ProviderResult<()>;

    /// Reminder / task lists. Providers without tasks return an empty list.
    async fn reminder_lists(&self) -> ProviderResult<Vec<ListInfo>> {
        Ok(Vec::new())
    }
    /// Incomplete reminders in every list.
    async fn reminders(&self) -> ProviderResult<Vec<ReminderInfo>> {
        Ok(Vec::new())
    }
    async fn create_reminder(&self, _list_id: &str, _draft: &ReminderDraft) -> ProviderResult<()> {
        Err(ProviderError::Unsupported(
            "This account does not support reminders.",
        ))
    }
    async fn complete_reminder(&self, _reminder_id: &str) -> ProviderResult<()> {
        Err(ProviderError::Unsupported(
            "This account does not support reminders.",
        ))
    }
    /// The list new reminders go to when the UI did not choose one.
    async fn default_reminder_list(&self) -> Option<String> {
        None
    }
}

/// EventKit-style permission state for one entity type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Full,
    WriteOnly,
    NotDetermined,
    Denied,
}

impl Access {
    pub fn can_read(self) -> bool {
        self == Self::Full
    }

    /// The `reason` string the Swift app reported for a calendar it could not read.
    pub fn calendar_reason(self) -> &'static str {
        match self {
            Self::NotDetermined => "notDetermined",
            Self::Denied => "denied",
            Self::WriteOnly | Self::Full => "writeOnly",
        }
    }

    /// The `reason` string the Swift app reported for Reminders.
    pub fn reminders_reason(self) -> &'static str {
        if self == Self::NotDetermined {
            "notDetermined"
        } else {
            "denied"
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "fullAccess",
            Self::WriteOnly => "writeOnly",
            Self::NotDetermined => "notDetermined",
            Self::Denied => "denied",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entity {
    Event,
    Reminder,
}

/// The OS calendar store (EventKit on macOS). Reads never prompt; only
/// [`SystemStore::request_access`] may show the system permission alert.
#[async_trait]
pub trait SystemStore: Provider {
    fn access(&self, entity: Entity) -> Access;
    /// Ask the OS for full access (this may show the system alert). Returns
    /// whether the OS reported a grant.
    async fn request_access(&self, entity: Entity) -> bool;
    /// Open the OS privacy settings for `entity`.
    fn open_settings(&self, entity: Entity) -> bool;
}
