//! macOS EventKit: the calendars and Reminders lists of every account the
//! user added to macOS. Ported from `native/HabibiApp.swift`
//! (`requestCalendarAccess`, `sendCalendarEvents`) and
//! `native/Reminders.swift`.
//!
//! Reads check `authorizationStatus` and never prompt. Only
//! [`SystemStore::request_access`] asks macOS, and only when the UI asked.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use block2::RcBlock;
use chrono::{DateTime, Utc};
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::Bool;
use objc2::{available, msg_send};
use objc2_event_kit::{
    EKAlarm, EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore, EKReminder,
    EKSpan,
};
use objc2_foundation::{NSArray, NSCalendar, NSCalendarUnit, NSDate, NSError, NSString};

use crate::ids::{join_parts, split_parts};
use crate::model::*;

/// One long-lived store for the whole app: permissions and cached sources
/// are tied to the store's lifetime (see the Swift app's comment), so the
/// store that requested access is the one that reads afterwards.
struct Store(Retained<EKEventStore>);

// SAFETY: EKEventStore is safe to use from any thread; the Swift app used a
// single instance from the main thread and global dispatch queues, which is
// how it is used here (every call runs on a blocking worker thread).
unsafe impl Send for Store {}
unsafe impl Sync for Store {}

#[derive(Default)]
pub struct EventKit {
    store: OnceLock<Arc<Store>>,
}

fn entity_type(entity: Entity) -> EKEntityType {
    match entity {
        Entity::Event => EKEntityType::Event,
        Entity::Reminder => EKEntityType::Reminder,
    }
}

fn status(entity: Entity) -> Access {
    // `Authorized` and `FullAccess` share a value: some macOS releases keep
    // reporting the legacy authorized value after a full grant, and both mean
    // Habibi can read.
    match unsafe { EKEventStore::authorizationStatusForEntityType(entity_type(entity)) } {
        EKAuthorizationStatus::FullAccess => Access::Full,
        EKAuthorizationStatus::WriteOnly => Access::WriteOnly,
        EKAuthorizationStatus::NotDetermined => Access::NotDetermined,
        _ => Access::Denied,
    }
}

fn to_date(date: DateTime<Utc>) -> Retained<NSDate> {
    NSDate::dateWithTimeIntervalSince1970(date.timestamp_millis() as f64 / 1000.0)
}

fn from_date(date: &NSDate) -> Option<DateTime<Utc>> {
    let seconds = date.timeIntervalSince1970();
    if !seconds.is_finite() {
        return None;
    }
    DateTime::from_timestamp_millis((seconds * 1000.0).round() as i64)
}

/// `title` is declared non-null but EventKit returns nil for untitled items.
fn item_title(item: &objc2_event_kit::EKCalendarItem) -> Option<String> {
    let title: Option<Retained<NSString>> = unsafe { msg_send![item, title] };
    title
        .map(|title| title.to_string())
        .filter(|title| !title.trim().is_empty())
}

fn calendar_info(calendar: &EKCalendar) -> CalendarInfo {
    unsafe {
        CalendarInfo {
            id: calendar.calendarIdentifier().to_string(),
            name: calendar.title().to_string(),
            writable: calendar.allowsContentModifications(),
        }
    }
}

impl EventKit {
    pub fn new() -> Self {
        Self::default()
    }

    fn store(&self) -> Arc<Store> {
        self.store
            .get_or_init(|| Arc::new(Store(unsafe { EKEventStore::new() })))
            .clone()
    }

    /// Run `work` on a blocking thread inside an autorelease pool.
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&EKEventStore) -> T + Send + 'static,
    ) -> ProviderResult<T> {
        let store = self.store();
        tokio::task::spawn_blocking(move || autoreleasepool(|_| work(&store.0)))
            .await
            .map_err(|_| ProviderError::Unavailable)
    }

    fn require(entity: Entity) -> ProviderResult<()> {
        if status(entity).can_read() {
            Ok(())
        } else {
            Err(ProviderError::NotAuthorized)
        }
    }
}

fn find_calendar(store: &EKEventStore, entity: Entity, id: &str) -> Option<Retained<EKCalendar>> {
    let calendars = unsafe { store.calendarsForEntityType(entity_type(entity)) };
    calendars
        .to_vec()
        .into_iter()
        .find(|calendar| unsafe { calendar.calendarIdentifier().to_string() } == id)
}

fn save_event(store: &EKEventStore, event: &EKEvent) -> ProviderResult<()> {
    unsafe { store.saveEvent_span_commit_error(event, EKSpan::ThisEvent, true) }
        .map_err(|_| ProviderError::Unavailable)
}

#[async_trait]
impl Provider for EventKit {
    async fn calendars(&self) -> ProviderResult<Vec<CalendarInfo>> {
        let access = status(Entity::Event);
        if access == Access::WriteOnly {
            // A write-only grant can still save to the default calendar.
            return self
                .run(|store| {
                    unsafe { store.defaultCalendarForNewEvents() }
                        .map(|calendar| calendar_info(&calendar))
                        .into_iter()
                        .collect()
                })
                .await;
        }
        Self::require(Entity::Event)?;
        self.run(|store| {
            let calendars = unsafe { store.calendarsForEntityType(EKEntityType::Event) };
            calendars
                .to_vec()
                .iter()
                .map(|calendar| calendar_info(calendar))
                .collect()
        })
        .await
    }

    async fn events(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> ProviderResult<Vec<EventInfo>> {
        Self::require(Entity::Event)?;
        self.run(move |store| {
            let predicate = unsafe {
                store.predicateForEventsWithStartDate_endDate_calendars(
                    &to_date(start),
                    &to_date(end),
                    None,
                )
            };
            let events = unsafe { store.eventsMatchingPredicate(&predicate) };
            events
                .to_vec()
                .iter()
                .filter_map(|event| unsafe {
                    let identifier = event.eventIdentifier()?.to_string();
                    let start = from_date(&event.startDate())?;
                    let end = from_date(&event.endDate()).unwrap_or(start).max(start);
                    let calendar = event.calendar()?;
                    Some(EventInfo {
                        // The occurrence start tells instances of a recurring
                        // event apart; the identifier alone names the series.
                        id: join_parts(&[&identifier, &start.timestamp().to_string()]),
                        title: item_title(event).unwrap_or_else(|| "Untitled event".into()),
                        start,
                        end,
                        all_day: event.isAllDay(),
                        calendar_id: calendar.calendarIdentifier().to_string(),
                        calendar_name: calendar.title().to_string(),
                    })
                })
                .collect()
        })
        .await
    }

    async fn create_event(&self, calendar_id: &str, draft: &EventDraft) -> ProviderResult<()> {
        if status(Entity::Event) == Access::NotDetermined || status(Entity::Event) == Access::Denied
        {
            return Err(ProviderError::NotAuthorized);
        }
        let (calendar_id, draft) = (calendar_id.to_string(), draft.clone());
        self.run(move |store| {
            let calendar = find_calendar(store, Entity::Event, &calendar_id)
                .or_else(|| unsafe { store.defaultCalendarForNewEvents() }.filter(|calendar| unsafe { calendar.calendarIdentifier().to_string() } == calendar_id))
                .ok_or(ProviderError::NotFound)?;
            if !unsafe { calendar.allowsContentModifications() } {
                return Err(ProviderError::ReadOnly);
            }
            unsafe {
                let event = EKEvent::eventWithEventStore(store);
                event.setTitle(Some(&NSString::from_str(&draft.title)));
                event.setStartDate(Some(&to_date(draft.start)));
                event.setEndDate(Some(&to_date(draft.end)));
                event.setCalendar(Some(&calendar));
                save_event(store, &event)
            }
        })
        .await?
    }

    async fn update_event(
        &self,
        event_id: &str,
        calendar_id: &str,
        draft: &EventDraft,
    ) -> ProviderResult<()> {
        Self::require(Entity::Event)?;
        let parts = split_parts(event_id, 2).ok_or(ProviderError::NotFound)?;
        let occurrence = parts[1]
            .parse::<i64>()
            .ok()
            .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
            .ok_or(ProviderError::NotFound)?;
        let (identifier, calendar_id, draft) =
            (parts[0].clone(), calendar_id.to_string(), draft.clone());
        self.run(move |store| unsafe {
            // Find this occurrence, not the first one of the series.
            let window = chrono::Duration::seconds(1);
            let predicate = store.predicateForEventsWithStartDate_endDate_calendars(
                &to_date(occurrence - window),
                &to_date(occurrence + window),
                None,
            );
            let event = store
                .eventsMatchingPredicate(&predicate)
                .to_vec()
                .into_iter()
                .find(|event| {
                    event
                        .eventIdentifier()
                        .is_some_and(|id| id.to_string() == identifier)
                        && from_date(&event.startDate())
                            .is_some_and(|start| (start - occurrence).num_seconds().abs() <= 1)
                })
                .or_else(|| store.eventWithIdentifier(&NSString::from_str(&identifier)))
                .ok_or(ProviderError::NotFound)?;
            let calendar = event.calendar().ok_or(ProviderError::NotFound)?;
            if calendar.calendarIdentifier().to_string() != calendar_id {
                return Err(ProviderError::Unsupported(
                    "Moving an event to another calendar isn't supported yet.",
                ));
            }
            if !calendar.allowsContentModifications() {
                return Err(ProviderError::ReadOnly);
            }
            event.setTitle(Some(&NSString::from_str(&draft.title)));
            event.setStartDate(Some(&to_date(draft.start)));
            event.setEndDate(Some(&to_date(draft.end)));
            save_event(store, &event)
        })
        .await?
    }

    async fn reminder_lists(&self) -> ProviderResult<Vec<ListInfo>> {
        Self::require(Entity::Reminder)?;
        self.run(|store| {
            let calendars = unsafe { store.calendarsForEntityType(EKEntityType::Reminder) };
            calendars
                .to_vec()
                .iter()
                .map(|calendar| {
                    let info = calendar_info(calendar);
                    ListInfo {
                        id: info.id,
                        name: info.name,
                        writable: info.writable,
                    }
                })
                .collect()
        })
        .await
    }

    async fn reminders(&self) -> ProviderResult<Vec<ReminderInfo>> {
        Self::require(Entity::Reminder)?;
        let (sender, receiver) = tokio::sync::oneshot::channel::<Vec<ReminderInfo>>();
        let sender = Arc::new(Mutex::new(Some(sender)));
        self.run(move |store| {
            let predicate = unsafe {
                store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars(
                    None, None, None,
                )
            };
            let block = RcBlock::new(move |values: *mut NSArray<EKReminder>| {
                // Map inside the callback: EventKit objects stay on its queue.
                let items = autoreleasepool(|_| {
                    let Some(values) = (unsafe { values.as_ref() }) else {
                        return Vec::new();
                    };
                    let calendar = NSCalendar::currentCalendar();
                    values
                        .to_vec()
                        .iter()
                        .filter_map(|reminder| unsafe {
                            let list = reminder.calendar()?;
                            let due = reminder
                                .dueDateComponents()
                                .and_then(|components| calendar.dateFromComponents(&components));
                            Some(ReminderInfo {
                                id: reminder.calendarItemIdentifier().to_string(),
                                title: item_title(reminder).unwrap_or_else(|| "Reminder".into()),
                                due: due.as_deref().and_then(from_date),
                                list_id: list.calendarIdentifier().to_string(),
                                list_name: list.title().to_string(),
                                completed: reminder.isCompleted(),
                            })
                        })
                        .collect()
                });
                if let Some(sender) = sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let _ = sender.send(items);
                }
            });
            unsafe { store.fetchRemindersMatchingPredicate_completion(&predicate, &block) };
        })
        .await?;
        tokio::time::timeout(Duration::from_secs(30), receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or(ProviderError::Unavailable)
    }

    async fn create_reminder(&self, list_id: &str, draft: &ReminderDraft) -> ProviderResult<()> {
        Self::require(Entity::Reminder)?;
        let (list_id, draft) = (list_id.to_string(), draft.clone());
        self.run(move |store| unsafe {
            let list = find_calendar(store, Entity::Reminder, &list_id)
                .filter(|calendar| calendar.allowsContentModifications())
                .ok_or(ProviderError::ReadOnly)?;
            let reminder = EKReminder::reminderWithEventStore(store);
            reminder.setTitle(Some(&NSString::from_str(&draft.title)));
            reminder.setCalendar(Some(&list));
            if let Some(due) = draft.due {
                let date = to_date(due);
                let units = NSCalendarUnit::Year
                    | NSCalendarUnit::Month
                    | NSCalendarUnit::Day
                    | NSCalendarUnit::Hour
                    | NSCalendarUnit::Minute;
                let components = NSCalendar::currentCalendar().components_fromDate(units, &date);
                reminder.setDueDateComponents(Some(&components));
                reminder.addAlarm(&EKAlarm::alarmWithAbsoluteDate(&date));
            }
            if let Some(notes) = &draft.notes {
                reminder.setNotes(Some(&NSString::from_str(notes)));
            }
            store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|_| ProviderError::Unavailable)
        })
        .await?
    }

    async fn complete_reminder(&self, reminder_id: &str) -> ProviderResult<()> {
        Self::require(Entity::Reminder)?;
        let reminder_id = reminder_id.to_string();
        self.run(move |store| unsafe {
            let item = store
                .calendarItemWithIdentifier(&NSString::from_str(&reminder_id))
                .ok_or(ProviderError::NotFound)?;
            let reminder = item
                .downcast::<EKReminder>()
                .map_err(|_| ProviderError::NotFound)?;
            if !reminder
                .calendar()
                .is_some_and(|calendar| calendar.allowsContentModifications())
            {
                return Err(ProviderError::ReadOnly);
            }
            reminder.setCompleted(true);
            store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|_| ProviderError::Unavailable)
        })
        .await?
    }

    async fn default_reminder_list(&self) -> Option<String> {
        if !status(Entity::Reminder).can_read() {
            return None;
        }
        self.run(|store| {
            unsafe { store.defaultCalendarForNewReminders() }
                .map(|calendar| unsafe { calendar.calendarIdentifier().to_string() })
        })
        .await
        .ok()
        .flatten()
    }
}

#[async_trait]
impl SystemStore for EventKit {
    fn access(&self, entity: Entity) -> Access {
        status(entity)
    }

    async fn request_access(&self, entity: Entity) -> bool {
        let (sender, receiver) = tokio::sync::oneshot::channel::<bool>();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let requested = self
            .run(move |store| {
                let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
                    if let Some(sender) = sender
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .take()
                    {
                        let _ = sender.send(granted.as_bool());
                    }
                });
                let pointer = RcBlock::as_ptr(&block);
                unsafe {
                    match (entity, available!(macos = 14.0)) {
                        (Entity::Event, true) => {
                            store.requestFullAccessToEventsWithCompletion(pointer)
                        }
                        (Entity::Reminder, true) => {
                            store.requestFullAccessToRemindersWithCompletion(pointer)
                        }
                        #[allow(deprecated)]
                        (_, false) => {
                            store.requestAccessToEntityType_completion(entity_type(entity), pointer)
                        }
                    }
                }
            })
            .await;
        if requested.is_err() {
            return false;
        }
        // The user may take a while to answer the system alert.
        let granted = tokio::time::timeout(Duration::from_secs(300), receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        // EventKit can call back before authorizationStatus has propagated;
        // a short pause makes the result match what the next read sees.
        tokio::time::sleep(Duration::from_millis(200)).await;
        granted
    }

    fn open_settings(&self, entity: Entity) -> bool {
        let pane = match entity {
            Entity::Event => "Privacy_Calendars",
            Entity::Reminder => "Privacy_Reminders",
        };
        habibi_platform::open::open_detached(&format!(
            "x-apple.systempreferences:com.apple.preference.security?{pane}"
        ))
        .is_ok()
    }
}
