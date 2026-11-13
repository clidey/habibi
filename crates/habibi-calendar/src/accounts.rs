//! Connected calendar accounts: metadata in
//! `state_root/.habibi/calendar-accounts.json` (0o600) and credentials in
//! the OS credential store under [`SECRET_SERVICE`]. Neither tokens nor
//! passwords are ever written to the file or returned to the UI.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Credential-store service name for calendar secrets.
pub const SECRET_SERVICE: &str = "Habibi Calendar";

pub const KIND_GOOGLE: &str = "google";
pub const KIND_CALDAV: &str = "caldav";

/// Where a Google account's OAuth client comes from.
pub const CLIENT_OWN: &str = "own";
/// Reuse the Gmail OAuth client the user configured for Mail (read-only).
pub const CLIENT_MAIL: &str = "mail";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    /// [`KIND_GOOGLE`] or [`KIND_CALDAV`]. Unknown kinds (from a newer
    /// version) are kept in the file but get no provider.
    pub kind: String,
    /// Display name, e.g. `Google` or `Fastmail`.
    pub label: String,
    /// Google account address / CalDAV user name.
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_source: Option<String>,
    #[serde(default = "yes")]
    pub calendars: bool,
    #[serde(default = "yes")]
    pub reminders: bool,
    #[serde(default)]
    pub created_at: String,
}

fn yes() -> bool {
    true
}

impl Account {
    /// What the UI may see about this account: no secrets, no client id.
    pub fn public_json(&self, connected: bool) -> Value {
        let detail = match self.kind.as_str() {
            KIND_CALDAV => {
                let host = self
                    .server_url
                    .as_deref()
                    .and_then(|url| reqwest::Url::parse(url).ok())
                    .and_then(|url| url.host_str().map(str::to_string))
                    .unwrap_or_default();
                if host.is_empty() {
                    self.username.clone()
                } else {
                    format!("{} · {host}", self.username)
                }
            }
            _ => self.username.clone(),
        };
        json!({
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "detail": detail,
            "connected": connected,
            "calendars": self.calendars,
            "reminders": self.reminders,
            "sharedClient": self.client_source.as_deref() == Some(CLIENT_MAIL),
        })
    }

    /// The short name used to tell same-named calendars apart.
    pub fn display(&self) -> String {
        if self.username.is_empty() {
            self.label.clone()
        } else {
            format!("{} ({})", self.label, self.username)
        }
    }

    pub fn secret_name(&self, purpose: &str) -> String {
        format!("{}:{}:{purpose}", self.kind, self.id)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AccountsFile {
    #[serde(default)]
    accounts: Vec<Value>,
}

/// The JSON account list. Writes are serialized by a mutex and atomic.
pub struct AccountStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AccountStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read_file(&self) -> AccountsFile {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn list(&self) -> Vec<Account> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        self.read_file()
            .accounts
            .into_iter()
            .filter_map(|value| serde_json::from_value::<Account>(value).ok())
            .filter(|account| {
                !account.id.is_empty() && crate::ids::split(&format!("{}:x", account.id)).is_some()
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.list().into_iter().find(|account| account.id == id)
    }

    /// Insert or replace (by id).
    pub fn upsert(&self, account: &Account) -> std::io::Result<()> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut file = self.read_file();
        let value = serde_json::to_value(account).map_err(std::io::Error::other)?;
        let existing = file
            .accounts
            .iter()
            .position(|entry| entry.get("id").and_then(Value::as_str) == Some(&account.id));
        match existing {
            Some(index) => file.accounts[index] = value,
            None => file.accounts.push(value),
        }
        write_private(&self.path, &file)
    }

    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut file = self.read_file();
        let before = file.accounts.len();
        file.accounts
            .retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
        if file.accounts.len() == before {
            return Ok(false);
        }
        write_private(&self.path, &file).map(|()| true)
    }
}

/// Write JSON with `0o700` on the directory and `0o600` on the file, via a
/// temporary file and rename so a crash never leaves a half-written list.
fn write_private(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent"))?;
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let temporary = directory.join(format!(".calendar-accounts.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// The Gmail OAuth client Mail stored in `mail-providers.json`, if any. Read
/// only: Calendar never writes Mail's configuration.
pub fn mail_google_client(path: &Path) -> Option<(String, String)> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let gmail = value.get("gmail")?;
    let id = gmail.get("clientId")?.as_str()?.trim().to_string();
    let secret = gmail
        .get("clientSecret")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    (!id.is_empty()).then_some((id, secret))
}

/// Secret storage, injectable so tests never touch the real credential store.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, secret: &str) -> bool;
    fn delete(&self, name: &str) -> bool;
}

/// `habibi_platform::secrets` under [`SECRET_SERVICE`].
pub struct PlatformSecrets;

impl SecretStore for PlatformSecrets {
    fn get(&self, name: &str) -> Option<String> {
        habibi_platform::secrets::get(SECRET_SERVICE, name)
    }

    fn set(&self, name: &str, secret: &str) -> bool {
        habibi_platform::secrets::set(SECRET_SERVICE, name, secret).is_ok()
    }

    fn delete(&self, name: &str) -> bool {
        habibi_platform::secrets::delete(SECRET_SERVICE, name).is_ok()
    }
}

/// In-memory secrets for tests.
#[derive(Default)]
pub struct MemorySecrets(pub Mutex<std::collections::HashMap<String, String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(name)
            .cloned()
    }

    fn set(&self, name: &str, secret: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(name.into(), secret.into());
        true
    }

    fn delete(&self, name: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(name);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> Account {
        Account {
            id: id.into(),
            kind: KIND_CALDAV.into(),
            label: "Fastmail".into(),
            username: "me@fastmail.com".into(),
            server_url: Some("https://caldav.fastmail.com/dav/".into()),
            calendars: true,
            reminders: true,
            ..Account::default()
        }
    }

    #[test]
    fn writes_private_atomic_json_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join(".habibi")
            .join("calendar-accounts.json");
        let store = AccountStore::new(path.clone());
        store.upsert(&account("a1")).unwrap();
        store.upsert(&account("b2")).unwrap();
        let mut changed = account("a1");
        changed.label = "Work".into();
        store.upsert(&changed).unwrap();
        let listed = store.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].label, "Work");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert!(store.remove("a1").unwrap());
        assert!(!store.remove("a1").unwrap());
        assert_eq!(store.list().len(), 1);
        let leftovers = fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary files remain");
    }

    #[test]
    fn public_json_never_carries_credentials_or_client_ids() {
        let mut google = account("g1");
        google.kind = KIND_GOOGLE.into();
        google.client_id = Some("123.apps.googleusercontent.com".into());
        let text = google.public_json(true).to_string();
        assert!(!text.contains("apps.googleusercontent"));
        assert_eq!(
            account("c").public_json(false)["detail"],
            "me@fastmail.com · caldav.fastmail.com"
        );
    }

    #[test]
    fn reads_the_mail_gmail_client_read_only() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail-providers.json");
        assert_eq!(mail_google_client(&path), None);
        fs::write(
            &path,
            r#"{"gmail":{"clientId":" id.apps ","clientSecret":"s"},"accounts":[]}"#,
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(
            mail_google_client(&path),
            Some(("id.apps".into(), "s".into()))
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn unknown_or_malformed_entries_are_skipped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("calendar-accounts.json");
        fs::write(&path, r#"{"accounts":[{"id":"bad id","kind":"caldav","label":"x"},{"nope":1},{"id":"ok","kind":"microsoft","label":"M"}]}"#).unwrap();
        let store = AccountStore::new(path);
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "microsoft");
    }
}
