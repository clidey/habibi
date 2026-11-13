//! The merged view over every connected provider.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use habibi_core::{ApprovalService, Paths};
use reqwest::Url;
use serde_json::{Value, json};

use crate::accounts::*;
use crate::caldav::{self, CalDav};
use crate::google::{Google, GoogleEndpoints, OAuthClient, TokenCache};
use crate::http::{ReqwestTransport, Transport};
use crate::ids::{self, SYSTEM};
use crate::model::*;

/// The Swift app showed the next 14 days, at most 30 events.
pub const EVENT_WINDOW_DAYS: i64 = 14;
pub const MAX_EVENTS: usize = 30;
/// The Swift app returned at most 200 reminders.
pub const MAX_REMINDERS: usize = 200;
/// The UI gives up on calendar reads after 10 s and on reminders after 15 s;
/// a slow account is dropped from the merge before that.
const EVENTS_TIMEOUT: Duration = Duration::from_secs(8);
pub const REMINDERS_LIMIT: Duration = Duration::from_secs(12);

/// Everything the service talks to, injectable for tests.
pub struct Options {
    pub transport: Arc<dyn Transport>,
    pub secrets: Arc<dyn SecretStore>,
    /// EventKit on macOS; `None` elsewhere.
    pub system: Option<Arc<dyn SystemStore>>,
    pub google: GoogleEndpoints,
    /// Open a URL in the user's browser (the Google consent screen).
    pub open_url: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// How long the Google sign-in waits for the browser redirect.
    pub sign_in_timeout: Duration,
}

impl Options {
    /// The real transport, credential store and (on macOS) EventKit.
    pub fn platform() -> Self {
        #[cfg(target_os = "macos")]
        let system: Option<Arc<dyn SystemStore>> = Some(Arc::new(crate::eventkit::EventKit::new()));
        #[cfg(not(target_os = "macos"))]
        let system: Option<Arc<dyn SystemStore>> = None;
        Self {
            transport: Arc::new(ReqwestTransport::new()),
            secrets: Arc::new(PlatformSecrets),
            system,
            google: GoogleEndpoints::default(),
            open_url: Arc::new(|url| habibi_platform::open::open_detached(url).is_ok()),
            sign_in_timeout: Duration::from_secs(300),
        }
    }
}

/// One provider in the merge, with the account id that qualifies its ids.
#[derive(Clone)]
pub struct Source {
    pub account: String,
    pub label: String,
    pub provider: Arc<dyn Provider>,
}

pub enum FlowState {
    Pending,
    Connected(Value),
    Failed(&'static str),
}

pub struct Flow {
    pub state: FlowState,
    pub created: Instant,
    pub task: Option<tokio::task::AbortHandle>,
}

pub struct Inner {
    pub paths: Paths,
    pub approvals: Arc<ApprovalService>,
    pub accounts: AccountStore,
    pub options: Options,
    pub tokens: Arc<TokenCache>,
    pub flows: Mutex<HashMap<String, Flow>>,
}

/// A source failed during a merged read.
pub struct Unavailable {
    pub label: String,
    pub error: ProviderError,
}

impl Unavailable {
    pub fn to_json(&self) -> Value {
        json!({ "account": self.label, "error": self.error.message(), "reconnect": self.error == ProviderError::Auth })
    }
}

async fn bounded<T>(
    limit: Duration,
    future: impl Future<Output = ProviderResult<T>>,
) -> ProviderResult<T> {
    tokio::time::timeout(limit, future)
        .await
        .unwrap_or(Err(ProviderError::Unavailable))
}

impl Inner {
    pub fn new(paths: Paths, approvals: Arc<ApprovalService>, options: Options) -> Self {
        let accounts = AccountStore::new(paths.state("calendar-accounts.json"));
        Self {
            paths,
            approvals,
            accounts,
            options,
            tokens: Arc::new(TokenCache::default()),
            flows: Mutex::new(HashMap::new()),
        }
    }

    pub fn mail_client(&self) -> Option<(String, String)> {
        mail_google_client(&self.paths.state("mail-providers.json"))
    }

    pub fn system_label() -> &'static str {
        "This Mac"
    }

    /// Build the provider for a stored account, or `None` when its
    /// credential is missing (the UI shows it as needing reconnection).
    pub fn provider_for(&self, account: &Account) -> Option<Arc<dyn Provider>> {
        let secrets = &self.options.secrets;
        match account.kind.as_str() {
            KIND_GOOGLE => {
                let refresh = secrets.get(&account.secret_name("refresh"))?;
                let client = if account.client_source.as_deref() == Some(CLIENT_MAIL) {
                    let (id, secret) = self.mail_client()?;
                    OAuthClient {
                        id,
                        secret: Some(secret).filter(|secret| !secret.is_empty()),
                    }
                } else {
                    OAuthClient {
                        id: account.client_id.clone()?,
                        secret: secrets.get(&account.secret_name("client-secret")),
                    }
                };
                Some(Arc::new(Google::new(
                    self.options.transport.clone(),
                    self.options.google.clone(),
                    account.id.clone(),
                    client,
                    refresh,
                    self.tokens.clone(),
                )))
            }
            KIND_CALDAV => {
                let password = secrets.get(&account.secret_name("password"))?;
                let base = caldav::validate_server_url(account.server_url.as_deref()?)?;
                let home = account
                    .home_url
                    .as_deref()
                    .and_then(|home| Url::parse(home).ok());
                Some(Arc::new(CalDav::new(
                    self.options.transport.clone(),
                    base,
                    home,
                    &account.username,
                    &password,
                )))
            }
            _ => None,
        }
    }

    /// Every source that can serve `entity`, system first, plus the accounts
    /// that cannot (missing credential).
    pub fn sources(&self, entity: Entity) -> (Vec<Source>, Vec<Unavailable>) {
        let mut sources = Vec::new();
        let mut missing = Vec::new();
        if let Some(system) = &self.options.system
            && system.access(entity).can_read()
        {
            let provider: Arc<dyn Provider> = system.clone();
            sources.push(Source {
                account: SYSTEM.into(),
                label: Self::system_label().into(),
                provider,
            });
        }
        for account in self.accounts.list() {
            let wanted = match entity {
                Entity::Event => account.calendars,
                Entity::Reminder => account.reminders,
            };
            if !wanted || !matches!(account.kind.as_str(), KIND_GOOGLE | KIND_CALDAV) {
                continue;
            }
            match self.provider_for(&account) {
                Some(provider) => sources.push(Source {
                    account: account.id.clone(),
                    label: account.display(),
                    provider,
                }),
                None => missing.push(Unavailable {
                    label: account.display(),
                    error: ProviderError::Auth,
                }),
            }
        }
        (sources, missing)
    }

    pub fn source(&self, account: &str, entity: Entity) -> Option<Source> {
        if account == SYSTEM {
            // Writing an event only needs a write-only grant.
            let system = self.options.system.as_ref()?;
            let access = system.access(entity);
            let usable =
                access.can_read() || (entity == Entity::Event && access == Access::WriteOnly);
            let provider: Arc<dyn Provider> = system.clone();
            return usable.then(|| Source {
                account: SYSTEM.into(),
                label: Self::system_label().into(),
                provider,
            });
        }
        let account = self.accounts.get(account)?;
        let provider = self.provider_for(&account)?;
        Some(Source {
            account: account.id.clone(),
            label: account.display(),
            provider,
        })
    }

    /// Run `read` on every source concurrently, each bounded by `limit`.
    pub async fn gather<T: Send + 'static, F, Fut>(
        &self,
        sources: Vec<Source>,
        limit: Duration,
        read: F,
    ) -> (Vec<(Source, T)>, Vec<Unavailable>)
    where
        F: Fn(Arc<dyn Provider>) -> Fut,
        Fut: Future<Output = ProviderResult<T>> + Send + 'static,
    {
        let mut set = tokio::task::JoinSet::new();
        for (index, source) in sources.iter().enumerate() {
            let future = read(source.provider.clone());
            set.spawn(async move { (index, bounded(limit, future).await) });
        }
        let mut results: Vec<(usize, ProviderResult<T>)> = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(result) = joined {
                results.push(result);
            }
        }
        results.sort_by_key(|(index, _)| *index);
        let mut ok = Vec::new();
        let mut failed = Vec::new();
        for (index, result) in results {
            let source = sources[index].clone();
            match result {
                Ok(value) => ok.push((source, value)),
                Err(error) => failed.push(Unavailable {
                    label: source.label,
                    error,
                }),
            }
        }
        (ok, failed)
    }

    /// Events in the next 14 days from every source, merged and capped.
    pub async fn merged_events(&self, now: DateTime<Utc>) -> (Vec<Value>, usize, Vec<Unavailable>) {
        let (sources, mut missing) = self.sources(Entity::Event);
        let end = now + chrono::Duration::days(EVENT_WINDOW_DAYS);
        let (results, failed) = self
            .gather(sources, EVENTS_TIMEOUT, move |provider| async move {
                provider.events(now, end).await
            })
            .await;
        missing.extend(failed);
        let succeeded = results.len();
        let mut events: Vec<(Source, EventInfo)> = results
            .into_iter()
            .flat_map(|(source, events)| {
                events.into_iter().map(move |event| (source.clone(), event))
            })
            .collect();
        events.sort_by(|a, b| {
            a.1.start
                .cmp(&b.1.start)
                .then_with(|| a.1.title.cmp(&b.1.title))
        });
        let events = events
            .into_iter()
            .take(MAX_EVENTS)
            .map(|(source, event)| {
                json!({
                    "id": ids::qualify(&source.account, &event.id),
                    "title": event.title,
                    "start": ids::iso(event.start),
                    "end": ids::iso(event.end),
                    "calendar": event.calendar_name,
                    "calendarId": ids::qualify(&source.account, &event.calendar_id),
                    "account": source.label,
                    "allDay": event.all_day,
                })
            })
            .collect();
        (events, succeeded, missing)
    }

    /// Writable calendars of every source, `(qualified id, name, source)`.
    pub async fn writable_calendars(&self) -> (Vec<(String, String, Source)>, Vec<Unavailable>) {
        let (mut sources, missing) = self.sources(Entity::Event);
        // A write-only EventKit grant can still save to the default calendar.
        if !sources.iter().any(|source| source.account == SYSTEM)
            && let Some(source) = self.source(SYSTEM, Entity::Event)
        {
            sources.insert(0, source);
        }
        let (results, mut failed) = self
            .gather(sources, EVENTS_TIMEOUT, |provider| async move {
                provider.calendars().await
            })
            .await;
        failed.extend(missing);
        let calendars = results
            .into_iter()
            .flat_map(|(source, calendars)| {
                calendars
                    .into_iter()
                    .filter(|calendar| calendar.writable)
                    .map(move |calendar| {
                        (
                            ids::qualify(&source.account, &calendar.id),
                            calendar.name,
                            source.clone(),
                        )
                    })
            })
            .collect();
        (calendars, failed)
    }
}
