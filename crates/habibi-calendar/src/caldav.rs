//! CalDAV (RFC 4791): VEVENT calendars and VTODO task lists with a user name
//! and app password. Works with iCloud, Fastmail, Nextcloud and other
//! sabre/dav-style servers.
//!
//! Credentials are only ever sent to the site the user typed (or a sibling
//! host of it, as iCloud's partitioned `pNN-caldav.icloud.com` hosts are);
//! a server cannot redirect Habibi into sending them somewhere else.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::Url;

use crate::http::{HttpRequest, HttpResponse, Transport};
use crate::ics::{self, Component, Property};
use crate::model::*;

const DAV: &str = "DAV:";
const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
const MAX_REDIRECTS: usize = 5;
/// Bounds on what one account can make Habibi fetch.
const MAX_COLLECTIONS: usize = 100;
const MAX_ITEMS_PER_COLLECTION: usize = 500;

const PROPFIND_PRINCIPAL: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>"#;
const PROPFIND_HOME: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#;
const PROPFIND_COLLECTIONS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>"#;

/// One `<d:response>` from a multistatus body, reduced to what Habibi uses.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DavEntry {
    pub href: String,
    pub display_name: Option<String>,
    pub resource_types: Vec<String>,
    /// `None` when the server did not report supported components.
    pub components: Option<Vec<String>>,
    /// `None` when the server did not report privileges.
    pub privileges: Option<Vec<String>>,
    pub principal: Option<String>,
    pub home: Option<String>,
    pub data: Option<String>,
    pub etag: Option<String>,
}

/// Parse a `207 Multi-Status` body. Only properties from `200` propstats count.
fn is(node: &roxmltree::Node, namespace: &str, name: &str) -> bool {
    node.is_element()
        && node.tag_name().name() == name
        && node.tag_name().namespace() == Some(namespace)
}

fn child<'a, 'input>(
    node: roxmltree::Node<'a, 'input>,
    namespace: &str,
    name: &str,
) -> Option<roxmltree::Node<'a, 'input>> {
    node.children()
        .find(|candidate| is(candidate, namespace, name))
}

fn href_of(node: roxmltree::Node) -> Option<String> {
    child(node, DAV, "href")
        .and_then(|href| href.text())
        .map(|text| text.trim().to_string())
}

pub fn parse_multistatus(body: &str) -> Vec<DavEntry> {
    let Ok(document) = roxmltree::Document::parse(body) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for response in document
        .descendants()
        .filter(|node| is(node, DAV, "response"))
    {
        let Some(href) = href_of(response) else {
            continue;
        };
        let mut entry = DavEntry {
            href,
            ..DavEntry::default()
        };
        for propstat in response.children().filter(|node| is(node, DAV, "propstat")) {
            let ok = child(propstat, DAV, "status")
                .and_then(|status| status.text())
                .is_some_and(|status| status.split_whitespace().nth(1) == Some("200"));
            let Some(prop) = child(propstat, DAV, "prop") else {
                continue;
            };
            if !ok {
                continue;
            }
            for property in prop.children().filter(roxmltree::Node::is_element) {
                let name = property.tag_name().name();
                let namespace = property.tag_name().namespace();
                match (namespace, name) {
                    (Some(DAV), "displayname") => {
                        entry.display_name = property
                            .text()
                            .map(|text| text.trim().to_string())
                            .filter(|text| !text.is_empty());
                    }
                    (Some(DAV), "resourcetype") => {
                        entry.resource_types = property
                            .children()
                            .filter(roxmltree::Node::is_element)
                            .map(|kind| kind.tag_name().name().to_string())
                            .collect();
                    }
                    (Some(CALDAV), "supported-calendar-component-set") => {
                        entry.components = Some(
                            property
                                .children()
                                .filter(|node| is(node, CALDAV, "comp"))
                                .filter_map(|comp| {
                                    comp.attribute("name").map(str::to_ascii_uppercase)
                                })
                                .collect(),
                        );
                    }
                    (Some(DAV), "current-user-privilege-set") => {
                        entry.privileges = Some(
                            property
                                .descendants()
                                .filter(|node| is(node, DAV, "privilege"))
                                .flat_map(|privilege| {
                                    privilege.children().filter(roxmltree::Node::is_element)
                                })
                                .map(|privilege| privilege.tag_name().name().to_string())
                                .collect(),
                        );
                    }
                    (Some(DAV), "current-user-principal") => entry.principal = href_of(property),
                    (Some(CALDAV), "calendar-home-set") => entry.home = href_of(property),
                    (Some(CALDAV), "calendar-data") => {
                        entry.data = property.text().map(str::to_string)
                    }
                    (Some(DAV), "getetag") => {
                        entry.etag = property.text().map(|text| text.trim().to_string())
                    }
                    _ => {}
                }
            }
        }
        entries.push(entry);
    }
    entries
}

/// A calendar collection.
#[derive(Debug, Clone, PartialEq)]
pub struct Collection {
    pub url: Url,
    pub name: String,
    pub events: bool,
    pub todos: bool,
    pub writable: bool,
}

/// The registrable-ish part of a host: `icloud.com` for
/// `p42-caldav.icloud.com`, `example.co.uk` for `dav.example.co.uk`.
fn site(host: &str) -> String {
    let labels: Vec<&str> = host.trim_end_matches('.').split('.').collect();
    if labels.len() <= 2 || host.parse::<std::net::IpAddr>().is_ok() {
        return host.to_ascii_lowercase();
    }
    let keep = if labels[labels.len() - 2].len() <= 3 {
        3
    } else {
        2
    };
    labels[labels.len().saturating_sub(keep)..]
        .join(".")
        .to_ascii_lowercase()
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// Validate the server URL the user typed. HTTPS only, except plain HTTP to
/// this machine (a local Radicale/Nextcloud test server).
pub fn validate_server_url(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 2048 {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut url = Url::parse(&with_scheme).ok()?;
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && is_loopback(&url));
    if !allowed
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Some(url)
}

pub struct CalDav {
    transport: Arc<dyn Transport>,
    base: Url,
    home: Option<Url>,
    authorization: String,
}

impl CalDav {
    pub fn new(
        transport: Arc<dyn Transport>,
        base: Url,
        home: Option<Url>,
        username: &str,
        password: &str,
    ) -> Self {
        let authorization = format!(
            "Basic {}",
            crate::ids::base64(format!("{username}:{password}").as_bytes())
        );
        Self {
            transport,
            base,
            home,
            authorization,
        }
    }

    fn allowed(&self, url: &Url) -> bool {
        let same_scheme = url.scheme() == self.base.scheme();
        let hosts = (
            url.host_str().unwrap_or_default(),
            self.base.host_str().unwrap_or_default(),
        );
        same_scheme
            && !hosts.0.is_empty()
            && (hosts.0.eq_ignore_ascii_case(hosts.1) || site(hosts.0) == site(hosts.1))
    }

    /// Send with credentials, following same-site redirects only.
    async fn send(
        &self,
        method: &str,
        url: &Url,
        depth: Option<&str>,
        body: Option<(&str, String)>,
        extra: &[(&str, String)],
    ) -> ProviderResult<(HttpResponse, Url)> {
        let mut url = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            if !self.allowed(&url) {
                return Err(ProviderError::Unavailable);
            }
            let mut request = HttpRequest::new(method, url.as_str())
                .header("Authorization", self.authorization.clone());
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            for (name, value) in extra {
                request = request.header(name, value.clone());
            }
            if let Some((content_type, body)) = &body {
                request = request.body(content_type, body.clone().into_bytes());
            }
            let response = self
                .transport
                .send(request)
                .await
                .map_err(|_| ProviderError::Unavailable)?;
            if matches!(response.status, 301 | 302 | 307 | 308) {
                let location = response
                    .header("Location")
                    .ok_or(ProviderError::Unavailable)?;
                url = url.join(location).map_err(|_| ProviderError::Unavailable)?;
                continue;
            }
            if response.status == 401 {
                return Err(ProviderError::Auth);
            }
            return Ok((response, url));
        }
        Err(ProviderError::Unavailable)
    }

    async fn propfind(
        &self,
        url: &Url,
        depth: &str,
        body: &str,
    ) -> ProviderResult<(Vec<DavEntry>, Url)> {
        let (response, final_url) = self
            .send(
                "PROPFIND",
                url,
                Some(depth),
                Some(("application/xml; charset=utf-8", body.to_string())),
                &[],
            )
            .await?;
        if response.status != 207 {
            return Err(if response.status == 404 {
                ProviderError::NotFound
            } else {
                ProviderError::Unavailable
            });
        }
        Ok((parse_multistatus(&response.text()), final_url))
    }

    /// Find the calendar home: principal → `calendar-home-set`, trying
    /// `/.well-known/caldav` when the URL typed is not a DAV endpoint.
    pub async fn discover(&self) -> ProviderResult<Url> {
        let mut candidates = vec![self.base.clone()];
        if let Ok(well_known) = self.base.join("/.well-known/caldav") {
            candidates.push(well_known);
        }
        for candidate in candidates {
            let (entries, final_url) =
                match self.propfind(&candidate, "0", PROPFIND_PRINCIPAL).await {
                    Ok(found) => found,
                    // A rejected password is final; anything else may just mean
                    // this was the wrong endpoint.
                    Err(ProviderError::Auth) => return Err(ProviderError::Auth),
                    Err(_) => continue,
                };
            if let Some(home) = entries.iter().find_map(|entry| entry.home.clone()) {
                return final_url
                    .join(&home)
                    .map_err(|_| ProviderError::Unavailable);
            }
            let Some(principal) = entries.iter().find_map(|entry| entry.principal.clone()) else {
                continue;
            };
            let principal = final_url
                .join(&principal)
                .map_err(|_| ProviderError::Unavailable)?;
            let (entries, final_url) = self.propfind(&principal, "0", PROPFIND_HOME).await?;
            if let Some(home) = entries.iter().find_map(|entry| entry.home.clone()) {
                return final_url
                    .join(&home)
                    .map_err(|_| ProviderError::Unavailable);
            }
        }
        Err(ProviderError::NotFound)
    }

    async fn home(&self) -> ProviderResult<Url> {
        match &self.home {
            Some(home) => Ok(home.clone()),
            None => self.discover().await,
        }
    }

    pub async fn collections(&self) -> ProviderResult<Vec<Collection>> {
        let home = self.home().await?;
        let (entries, final_url) = self.propfind(&home, "1", PROPFIND_COLLECTIONS).await?;
        let mut collections = Vec::new();
        for entry in entries
            .into_iter()
            .filter(|entry| entry.resource_types.iter().any(|kind| kind == "calendar"))
        {
            let Ok(url) = final_url.join(&entry.href) else {
                continue;
            };
            if !self.allowed(&url) {
                continue;
            }
            let components = entry
                .components
                .clone()
                .unwrap_or_else(|| vec!["VEVENT".into(), "VTODO".into()]);
            let writable = entry.privileges.as_ref().is_none_or(|privileges| {
                privileges.iter().any(|privilege| {
                    matches!(
                        privilege.as_str(),
                        "write" | "write-content" | "bind" | "all"
                    )
                })
            });
            let name = entry.display_name.clone().unwrap_or_else(|| {
                url.path_segments()
                    .and_then(|mut segments| {
                        segments
                            .rfind(|segment| !segment.is_empty())
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "Calendar".into())
            });
            collections.push(Collection {
                url,
                name,
                events: components.iter().any(|component| component == "VEVENT"),
                todos: components.iter().any(|component| component == "VTODO"),
                writable,
            });
            if collections.len() >= MAX_COLLECTIONS {
                break;
            }
        }
        Ok(collections)
    }

    async fn report(&self, collection: &Url, body: String) -> ProviderResult<Vec<(Url, DavEntry)>> {
        let (response, final_url) = self
            .send(
                "REPORT",
                collection,
                Some("1"),
                Some(("application/xml; charset=utf-8", body)),
                &[],
            )
            .await?;
        if response.status != 207 {
            return Err(ProviderError::Unavailable);
        }
        Ok(parse_multistatus(&response.text())
            .into_iter()
            .filter(|entry| entry.data.is_some())
            .take(MAX_ITEMS_PER_COLLECTION)
            .filter_map(|entry| {
                final_url
                    .join(&entry.href)
                    .ok()
                    .filter(|url| self.allowed(url))
                    .map(|url| (url, entry))
            })
            .collect())
    }

    fn collection_for<'a>(collections: &'a [Collection], resource: &str) -> Option<&'a Collection> {
        collections.iter().find(|collection| {
            resource.starts_with(collection.url.as_str())
                && resource.len() > collection.url.as_str().len()
        })
    }

    fn resource_url(&self, local: &str) -> ProviderResult<Url> {
        let url = Url::parse(local).map_err(|_| ProviderError::NotFound)?;
        if self.allowed(&url) {
            Ok(url)
        } else {
            Err(ProviderError::NotFound)
        }
    }

    /// GET one resource with its ETag.
    async fn fetch(&self, url: &Url) -> ProviderResult<(Component, Option<String>)> {
        let (response, _) = self.send("GET", url, None, None, &[]).await?;
        match response.status {
            200 => {}
            404 | 410 => return Err(ProviderError::NotFound),
            _ => return Err(ProviderError::Unavailable),
        }
        let calendar = ics::parse(&response.text())
            .into_iter()
            .find(|component| component.name == "VCALENDAR")
            .ok_or(ProviderError::Unavailable)?;
        Ok((calendar, response.header("ETag").map(str::to_string)))
    }

    async fn put(
        &self,
        url: &Url,
        calendar: &Component,
        condition: (&str, String),
    ) -> ProviderResult<()> {
        let (response, _) = self
            .send(
                "PUT",
                url,
                None,
                Some(("text/calendar; charset=utf-8", calendar.serialize())),
                &[condition],
            )
            .await?;
        match response.status {
            200..=299 => Ok(()),
            403 => Err(ProviderError::ReadOnly),
            404 | 410 => Err(ProviderError::NotFound),
            412 => Err(ProviderError::Invalid(
                "This item changed elsewhere. Refresh and try again.",
            )),
            _ => Err(ProviderError::Unavailable),
        }
    }

    async fn put_new(&self, collection: &Url, component: Component) -> ProviderResult<()> {
        let url = collection
            .join(&format!("{}.ics", uuid::Uuid::new_v4()))
            .map_err(|_| ProviderError::Unavailable)?;
        self.put(
            &url,
            &ics::calendar_with(component),
            ("If-None-Match", "*".into()),
        )
        .await
    }
}

fn time_range(start: DateTime<Utc>, end: DateTime<Utc>) -> String {
    format!(
        r#"start="{}" end="{}""#,
        ics::format_utc(start),
        ics::format_utc(end)
    )
}

fn stamp(component: &mut Component) {
    let now = ics::format_utc(Utc::now());
    component.set(Property::new("DTSTAMP", now.clone()));
    component.set(Property::new("LAST-MODIFIED", now));
}

#[async_trait]
impl Provider for CalDav {
    async fn calendars(&self) -> ProviderResult<Vec<CalendarInfo>> {
        Ok(self
            .collections()
            .await?
            .into_iter()
            .filter(|collection| collection.events)
            .map(|collection| CalendarInfo {
                id: collection.url.to_string(),
                name: collection.name,
                writable: collection.writable,
            })
            .collect())
    }

    async fn events(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> ProviderResult<Vec<EventInfo>> {
        let range = time_range(start, end);
        // `expand` asks the server to return recurring events as UTC
        // instances in the window; servers that ignore it return masters,
        // which are filtered to the window below.
        let body = format!(
            r#"<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand {range}/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range {range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#
        );
        let mut events = Vec::new();
        let mut failures = 0;
        let collections: Vec<Collection> = self
            .collections()
            .await?
            .into_iter()
            .filter(|collection| collection.events)
            .collect();
        for collection in &collections {
            let Ok(entries) = self.report(&collection.url, body.clone()).await else {
                failures += 1;
                continue;
            };
            for (url, entry) in entries {
                for calendar in ics::parse(entry.data.as_deref().unwrap_or_default()) {
                    for event in calendar.children_named("VEVENT") {
                        let Some((event_start, event_end, all_day)) = ics::event_times(event)
                        else {
                            continue;
                        };
                        let overlaps = event_start < end
                            && (event_end > start
                                || (event_end == event_start && event_start >= start));
                        if !overlaps
                            || event.property("STATUS").is_some_and(|status| {
                                status.value.eq_ignore_ascii_case("CANCELLED")
                            })
                        {
                            continue;
                        }
                        let id = match event.property("RECURRENCE-ID") {
                            Some(instance) => format!("{url}#{}", instance.value.trim()),
                            None if ics::is_recurring(event) => format!("{url}#master"),
                            None => url.to_string(),
                        };
                        events.push(EventInfo {
                            id,
                            title: event
                                .text("SUMMARY")
                                .filter(|title| !title.trim().is_empty())
                                .unwrap_or_else(|| "Untitled event".into()),
                            start: event_start,
                            end: event_end,
                            all_day,
                            calendar_id: collection.url.to_string(),
                            calendar_name: collection.name.clone(),
                        });
                    }
                }
            }
        }
        if failures > 0 && failures == collections.len() {
            return Err(ProviderError::Unavailable);
        }
        Ok(events)
    }

    async fn create_event(&self, calendar_id: &str, draft: &EventDraft) -> ProviderResult<()> {
        let collections = self.collections().await?;
        let collection = collections
            .iter()
            .find(|collection| collection.url.as_str() == calendar_id && collection.events)
            .ok_or(ProviderError::NotFound)?;
        if !collection.writable {
            return Err(ProviderError::ReadOnly);
        }
        let mut event = Component::new("VEVENT");
        event.properties.push(Property::new(
            "UID",
            format!("{}@habibi", uuid::Uuid::new_v4()),
        ));
        stamp(&mut event);
        event
            .properties
            .push(Property::new("DTSTART", ics::format_utc(draft.start)));
        event
            .properties
            .push(Property::new("DTEND", ics::format_utc(draft.end)));
        event
            .properties
            .push(Property::text("SUMMARY", &draft.title));
        self.put_new(&collection.url, event).await
    }

    async fn update_event(
        &self,
        event_id: &str,
        calendar_id: &str,
        draft: &EventDraft,
    ) -> ProviderResult<()> {
        if event_id.contains('#') {
            return Err(ProviderError::Unsupported(
                "Recurring events can't be edited from Habibi yet.",
            ));
        }
        let url = self.resource_url(event_id)?;
        if !url.as_str().starts_with(calendar_id) || calendar_id.is_empty() {
            return Err(ProviderError::Unsupported(
                "Moving an event to another calendar isn't supported yet.",
            ));
        }
        let (mut calendar, etag) = self.fetch(&url).await?;
        if calendar.children_named("VEVENT").count() != 1 {
            return Err(ProviderError::Unsupported(
                "Recurring events can't be edited from Habibi yet.",
            ));
        }
        let event = calendar
            .first_child_mut("VEVENT")
            .ok_or(ProviderError::NotFound)?;
        if ics::is_recurring(event) {
            return Err(ProviderError::Unsupported(
                "Recurring events can't be edited from Habibi yet.",
            ));
        }
        event.set(Property::text("SUMMARY", &draft.title));
        event.set(Property::new("DTSTART", ics::format_utc(draft.start)));
        event.set(Property::new("DTEND", ics::format_utc(draft.end)));
        event.remove("DURATION");
        let sequence = event
            .property("SEQUENCE")
            .and_then(|property| property.value.trim().parse::<u32>().ok())
            .unwrap_or(0);
        event.set(Property::new(
            "SEQUENCE",
            (sequence.saturating_add(1)).to_string(),
        ));
        stamp(event);
        let condition = match etag {
            Some(etag) => ("If-Match", etag),
            None => ("If-Match", "*".into()),
        };
        self.put(&url, &calendar, condition).await
    }

    async fn reminder_lists(&self) -> ProviderResult<Vec<ListInfo>> {
        Ok(self
            .collections()
            .await?
            .into_iter()
            .filter(|collection| collection.todos)
            .map(|collection| ListInfo {
                id: collection.url.to_string(),
                name: collection.name,
                writable: collection.writable,
            })
            .collect())
    }

    async fn reminders(&self) -> ProviderResult<Vec<ReminderInfo>> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"><c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#;
        let mut reminders = Vec::new();
        for collection in self
            .collections()
            .await?
            .into_iter()
            .filter(|collection| collection.todos)
        {
            let Ok(entries) = self.report(&collection.url, body.to_string()).await else {
                continue;
            };
            for (url, entry) in entries {
                for calendar in ics::parse(entry.data.as_deref().unwrap_or_default()) {
                    // One reminder per resource: overrides of a recurring task
                    // share the resource and would duplicate it.
                    let Some(todo) = calendar
                        .children_named("VTODO")
                        .find(|todo| !ics::todo_done(todo))
                    else {
                        continue;
                    };
                    reminders.push(ReminderInfo {
                        id: url.to_string(),
                        title: todo
                            .text("SUMMARY")
                            .filter(|title| !title.trim().is_empty())
                            .unwrap_or_else(|| "Reminder".into()),
                        due: todo
                            .property("DUE")
                            .and_then(ics::parse_time)
                            .map(|time| time.instant),
                        list_id: collection.url.to_string(),
                        list_name: collection.name.clone(),
                        completed: false,
                    });
                }
            }
        }
        Ok(reminders)
    }

    async fn create_reminder(&self, list_id: &str, draft: &ReminderDraft) -> ProviderResult<()> {
        let collections = self.collections().await?;
        let collection = collections
            .iter()
            .find(|collection| collection.url.as_str() == list_id && collection.todos)
            .ok_or(ProviderError::NotFound)?;
        if !collection.writable {
            return Err(ProviderError::ReadOnly);
        }
        let mut todo = Component::new("VTODO");
        todo.properties.push(Property::new(
            "UID",
            format!("{}@habibi", uuid::Uuid::new_v4()),
        ));
        stamp(&mut todo);
        todo.properties
            .push(Property::text("SUMMARY", &draft.title));
        todo.properties
            .push(Property::new("STATUS", "NEEDS-ACTION"));
        if let Some(notes) = draft.notes.as_deref().filter(|notes| !notes.is_empty()) {
            todo.properties.push(Property::text("DESCRIPTION", notes));
        }
        if let Some(due) = draft.due {
            todo.properties
                .push(Property::new("DUE", ics::format_utc(due)));
            // Matches the Swift app's absolute alarm at the due time.
            let mut alarm = Component::new("VALARM");
            alarm.properties.push(Property::new("ACTION", "DISPLAY"));
            alarm
                .properties
                .push(Property::text("DESCRIPTION", &draft.title));
            alarm.properties.push(Property {
                name: "TRIGGER".into(),
                params: vec![("VALUE".into(), "DATE-TIME".into())],
                value: ics::format_utc(due),
            });
            todo.children.push(alarm);
        }
        self.put_new(&collection.url, todo).await
    }

    async fn complete_reminder(&self, reminder_id: &str) -> ProviderResult<()> {
        let url = self.resource_url(reminder_id)?;
        let collections = self.collections().await?;
        let collection =
            Self::collection_for(&collections, url.as_str()).ok_or(ProviderError::NotFound)?;
        if !collection.writable || !collection.todos {
            return Err(ProviderError::ReadOnly);
        }
        let (mut calendar, etag) = self.fetch(&url).await?;
        let todo = calendar
            .first_child_mut("VTODO")
            .ok_or(ProviderError::NotFound)?;
        let now = ics::format_utc(Utc::now());
        todo.set(Property::new("STATUS", "COMPLETED"));
        todo.set(Property::new("COMPLETED", now));
        todo.set(Property::new("PERCENT-COMPLETE", "100"));
        stamp(todo);
        let condition = ("If-Match", etag.unwrap_or_else(|| "*".into()));
        self.put(&url, &calendar, condition).await
    }

    async fn default_reminder_list(&self) -> Option<String> {
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::http::TransportError;
    use std::sync::Mutex;

    /// A scripted CalDAV server: `(method, url) -> response`, recording requests.
    #[derive(Default)]
    pub struct FakeDav {
        pub routes: Mutex<Vec<(String, String, HttpResponse)>>,
        pub requests: Mutex<Vec<HttpRequest>>,
    }

    impl FakeDav {
        pub fn route(&self, method: &str, url: &str, status: u16, body: &str) {
            self.routes.lock().unwrap().push((
                method.into(),
                url.into(),
                HttpResponse {
                    status,
                    headers: vec![("ETag".into(), "\"e1\"".into())],
                    body: body.as_bytes().to_vec(),
                },
            ));
        }
        pub fn redirect(&self, method: &str, url: &str, location: &str) {
            self.routes.lock().unwrap().push((
                method.into(),
                url.into(),
                HttpResponse {
                    status: 301,
                    headers: vec![("Location".into(), location.into())],
                    body: vec![],
                },
            ));
        }
    }

    #[async_trait]
    impl Transport for FakeDav {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
            self.requests.lock().unwrap().push(request.clone());
            let routes = self.routes.lock().unwrap();
            Ok(routes
                .iter()
                .find(|(method, url, _)| *method == request.method && *url == request.url)
                .map(|(_, _, response)| response.clone())
                .unwrap_or(HttpResponse {
                    status: 404,
                    ..HttpResponse::default()
                }))
        }
    }

    pub fn multistatus(responses: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">{responses}</d:multistatus>"#
        )
    }

    pub const COLLECTIONS: &str = r#"
      <d:response><d:href>/dav/calendars/user/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/calendars/user/me/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/calendars/user/me/holidays/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Holidays</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/calendars/user/me/tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>"#;

    pub const BASE: &str = "https://dav.example.com/dav/";
    pub const HOME: &str = "https://dav.example.com/dav/calendars/user/me/";

    pub fn server() -> Arc<FakeDav> {
        let fake = Arc::new(FakeDav::default());
        fake.route("PROPFIND", BASE, 207, &multistatus(r#"<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/user/me/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#));
        fake.route("PROPFIND", "https://dav.example.com/dav/principals/user/me/", 207, &multistatus(r#"<d:response><d:href>/dav/principals/user/me/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/dav/calendars/user/me/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#));
        fake.route("PROPFIND", HOME, 207, &multistatus(COLLECTIONS));
        fake
    }

    pub fn client(fake: &Arc<FakeDav>) -> CalDav {
        CalDav::new(
            fake.clone(),
            Url::parse(BASE).unwrap(),
            None,
            "me@example.com",
            "app pass",
        )
    }

    #[tokio::test]
    async fn discovers_home_and_lists_collections_with_privileges() {
        let fake = server();
        let dav = client(&fake);
        assert_eq!(dav.discover().await.unwrap().as_str(), HOME);
        let calendars = dav.calendars().await.unwrap();
        assert_eq!(
            calendars
                .iter()
                .map(|calendar| (calendar.name.as_str(), calendar.writable))
                .collect::<Vec<_>>(),
            vec![("Work", true), ("Holidays", false)]
        );
        let lists = dav.reminder_lists().await.unwrap();
        assert_eq!(lists.len(), 1);
        assert!(
            lists[0].writable,
            "a 404 privilege propstat means unknown, which is treated as writable"
        );
        let auth = fake.requests.lock().unwrap()[0]
            .header_value("Authorization")
            .unwrap()
            .to_string();
        assert_eq!(
            auth,
            format!("Basic {}", crate::ids::base64(b"me@example.com:app pass"))
        );
    }

    #[tokio::test]
    async fn bad_password_is_an_auth_error() {
        let fake = Arc::new(FakeDav::default());
        fake.route("PROPFIND", BASE, 401, "");
        assert_eq!(client(&fake).discover().await, Err(ProviderError::Auth));
    }

    #[tokio::test]
    async fn redirects_to_another_site_never_receive_credentials() {
        let fake = Arc::new(FakeDav::default());
        fake.redirect("PROPFIND", BASE, "https://evil.example.net/steal/");
        fake.redirect(
            "PROPFIND",
            "https://dav.example.com/.well-known/caldav",
            "https://p1-dav.example.com/dav/",
        );
        let _ = client(&fake).discover().await;
        let requests = fake.requests.lock().unwrap();
        assert!(
            requests
                .iter()
                .all(|request| !request.url.contains("evil.example.net"))
        );
        assert!(
            requests
                .iter()
                .any(|request| request.url == "https://p1-dav.example.com/dav/"),
            "same-site hops are followed"
        );
    }

    #[test]
    fn server_urls_must_be_https_except_loopback() {
        assert_eq!(
            validate_server_url("caldav.icloud.com").unwrap().as_str(),
            "https://caldav.icloud.com/"
        );
        assert_eq!(
            validate_server_url("https://cloud.example.org/remote.php/dav")
                .unwrap()
                .as_str(),
            "https://cloud.example.org/remote.php/dav/"
        );
        assert!(validate_server_url("http://cloud.example.org/").is_none());
        assert!(validate_server_url("http://127.0.0.1:5232/").is_some());
        assert!(validate_server_url("https://user:pw@example.org/").is_none());
        assert!(validate_server_url("file:///etc/passwd").is_none());
        assert_eq!(site("p42-caldav.icloud.com"), "icloud.com");
        assert_eq!(site("dav.example.co.uk"), "example.co.uk");
    }

    #[tokio::test]
    async fn events_come_from_expanded_reports_and_skip_cancelled() {
        let fake = server();
        let data = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r1\r\nRECURRENCE-ID:20261113T090000Z\r\nDTSTART:20261113T090000Z\r\nDTEND:20261113T093000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:r1\r\nRECURRENCE-ID:20261114T090000Z\r\nDTSTART:20261114T090000Z\r\nDTEND:20261114T093000Z\r\nSUMMARY:Standup\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let single = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:s1\nDTSTART:20261115T120000Z\nDTEND:20261115T130000Z\nSUMMARY:Lunch &amp; learn\nEND:VEVENT\nEND:VCALENDAR\n";
        fake.route(
            "REPORT",
            "https://dav.example.com/dav/calendars/user/me/work/",
            207,
            &multistatus(&format!(
                r#"<d:response><d:href>/dav/calendars/user/me/work/r1.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>{data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/calendars/user/me/work/s1.ics</d:href><d:propstat><d:prop><c:calendar-data>{single}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
            )),
        );
        fake.route(
            "REPORT",
            "https://dav.example.com/dav/calendars/user/me/holidays/",
            207,
            &multistatus(""),
        );
        let start = crate::ids::parse_iso("2026-11-12T00:00:00Z").unwrap();
        let events = client(&fake)
            .events(start, start + chrono::Duration::days(14))
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].id,
            "https://dav.example.com/dav/calendars/user/me/work/r1.ics#20261113T090000Z"
        );
        assert_eq!(events[1].title, "Lunch & learn");
        assert_eq!(events[1].calendar_name, "Work");
        let report = fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|request| request.method == "REPORT")
            .cloned()
            .unwrap();
        let body = String::from_utf8(report.body.clone()).unwrap();
        assert!(body.contains(r#"<c:expand start="20261112T000000Z" end="20261126T000000Z"/>"#));
        assert_eq!(report.header_value("Depth"), Some("1"));
    }

    #[tokio::test]
    async fn vtodo_reminders_are_listed_and_completed_with_if_match() {
        let fake = server();
        let tasks = "https://dav.example.com/dav/calendars/user/me/tasks/";
        let todo = "BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:t1\nSUMMARY:Buy milk\nDUE;VALUE=DATE:20261120\nX-KEEP:yes\nEND:VTODO\nEND:VCALENDAR\n";
        fake.route(
            "REPORT",
            tasks,
            207,
            &multistatus(&format!(r#"<d:response><d:href>/dav/calendars/user/me/tasks/t1.ics</d:href><d:propstat><d:prop><c:calendar-data>{todo}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#)),
        );
        fake.route("GET", &format!("{tasks}t1.ics"), 200, todo);
        fake.route("PUT", &format!("{tasks}t1.ics"), 204, "");
        let dav = client(&fake);
        let reminders = dav.reminders().await.unwrap();
        assert_eq!(reminders.len(), 1);
        assert_eq!(reminders[0].title, "Buy milk");
        assert!(reminders[0].due.is_some());
        dav.complete_reminder(&reminders[0].id).await.unwrap();
        let put = fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .rfind(|request| request.method == "PUT")
            .cloned()
            .unwrap();
        assert_eq!(put.header_value("If-Match"), Some("\"e1\""));
        let body = String::from_utf8(put.body).unwrap();
        assert!(
            body.contains("STATUS:COMPLETED")
                && body.contains("PERCENT-COMPLETE:100")
                && body.contains("X-KEEP:yes")
        );
    }

    #[tokio::test]
    async fn creates_events_and_todos_with_if_none_match_and_refuses_read_only() {
        let fake = server();
        let dav = client(&fake);
        let start = crate::ids::parse_iso("2026-11-20T10:00:00Z").unwrap();
        let draft = EventDraft {
            title: "Plan, review; ship".into(),
            start,
            end: start + chrono::Duration::hours(1),
        };
        let holidays = "https://dav.example.com/dav/calendars/user/me/holidays/";
        assert_eq!(
            dav.create_event(holidays, &draft).await,
            Err(ProviderError::ReadOnly)
        );
        let work = "https://dav.example.com/dav/calendars/user/me/work/";
        // New resources get random names the fake cannot route, so inspect
        // the attempted PUT rather than its result.
        let _ = dav.create_event(work, &draft).await;
        let put = fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .rfind(|request| request.method == "PUT")
            .cloned()
            .unwrap();
        assert!(put.url.starts_with(work) && put.url.ends_with(".ics"));
        assert_eq!(put.header_value("If-None-Match"), Some("*"));
        let body = String::from_utf8(put.body).unwrap();
        assert!(body.contains("SUMMARY:Plan\\, review\\; ship"));
        assert!(
            body.contains("DTSTART:20261120T100000Z") && body.contains("DTEND:20261120T110000Z")
        );

        let tasks = "https://dav.example.com/dav/calendars/user/me/tasks/";
        let reminder = ReminderDraft {
            title: "Call".into(),
            due: Some(start),
            notes: Some("line1\nline2".into()),
        };
        let _ = dav.create_reminder(tasks, &reminder).await;
        let put = fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .rfind(|request| request.method == "PUT")
            .cloned()
            .unwrap();
        let body = String::from_utf8(put.body).unwrap();
        assert!(
            body.contains("BEGIN:VTODO")
                && body.contains("DUE:20261120T100000Z")
                && body.contains("BEGIN:VALARM")
        );
        assert!(body.contains("DESCRIPTION:line1\\nline2"));
    }

    #[tokio::test]
    async fn recurring_and_cross_calendar_updates_are_refused() {
        let fake = server();
        let dav = client(&fake);
        let start = crate::ids::parse_iso("2026-11-20T10:00:00Z").unwrap();
        let draft = EventDraft {
            title: "x".into(),
            start,
            end: start,
        };
        let work = "https://dav.example.com/dav/calendars/user/me/work/";
        assert!(matches!(
            dav.update_event(&format!("{work}r1.ics#20261113T090000Z"), work, &draft)
                .await,
            Err(ProviderError::Unsupported(_))
        ));
        assert!(matches!(
            dav.update_event(
                &format!("{work}a.ics"),
                "https://dav.example.com/dav/calendars/user/me/holidays/",
                &draft
            )
            .await,
            Err(ProviderError::Unsupported(_))
        ));
        assert_eq!(
            dav.update_event("https://evil.example.net/a.ics", work, &draft)
                .await,
            Err(ProviderError::NotFound)
        );
        fake.route("GET", &format!("{work}m.ics"), 200, "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:m\nRRULE:FREQ=DAILY\nDTSTART:20261101T090000Z\nEND:VEVENT\nEND:VCALENDAR\n");
        assert!(matches!(
            dav.update_event(&format!("{work}m.ics"), work, &draft)
                .await,
            Err(ProviderError::Unsupported(_))
        ));
    }

    #[tokio::test]
    async fn updates_keep_unknown_properties_and_bump_sequence() {
        let fake = server();
        let work = "https://dav.example.com/dav/calendars/user/me/work/";
        fake.route("GET", &format!("{work}e.ics"), 200, "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:e\nSEQUENCE:2\nDTSTART;VALUE=DATE:20261101\nDURATION:P1D\nSUMMARY:Old\nLOCATION:Room 1\nEND:VEVENT\nEND:VCALENDAR\n");
        fake.route("PUT", &format!("{work}e.ics"), 204, "");
        let start = crate::ids::parse_iso("2026-11-20T10:00:00Z").unwrap();
        let draft = EventDraft {
            title: "New".into(),
            start,
            end: start + chrono::Duration::minutes(30),
        };
        client(&fake)
            .update_event(&format!("{work}e.ics"), work, &draft)
            .await
            .unwrap();
        let put = fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .rfind(|request| request.method == "PUT")
            .cloned()
            .unwrap();
        let body = String::from_utf8(put.body).unwrap();
        assert!(
            body.contains("SUMMARY:New")
                && body.contains("LOCATION:Room 1")
                && body.contains("SEQUENCE:3")
        );
        assert!(!body.contains("DURATION") && body.contains("DTEND:20261120T103000Z"));
    }

    #[test]
    fn multistatus_ignores_failed_propstats_and_bad_xml() {
        let entries = parse_multistatus(&multistatus(COLLECTIONS));
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[3].privileges, None);
        assert!(parse_multistatus("<not xml").is_empty());
        assert!(parse_multistatus(r#"<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>"#).is_empty());
    }
}
