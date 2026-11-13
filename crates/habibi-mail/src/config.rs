//! `state_root/.habibi/mail-providers.json`: OAuth client settings per
//! provider and the connected IMAP accounts. The file shape is unchanged:
//!
//! ```json
//! {
//!   "gmail": { "clientId": "", "clientSecret": "", "redirectUri": "" },
//!   "accounts": {
//!     "gmail:me@example.com": {
//!       "provider": "gmail",
//!       "imap": { "email": "me@example.com", "host": "imap.gmail.com", "port": 993 },
//!       "createdAt": "2025-01-01T00:00:00.000Z"
//!     }
//!   }
//! }
//! ```
//!
//! Pre-multi-account installs kept `"<provider>": { "imap": { ... } }`; that
//! is still read, as a `legacy` account.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::js;

pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:4173/api/mail/oauth/callback";

pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    pub auth: &'static str,
    pub token: &'static str,
    pub scopes: &'static [&'static str],
    pub imap_host: &'static str,
    /// The same app password that authenticates IMAP also authenticates SMTP
    /// for both providers, so sending needs no separate credential flow, just
    /// the provider's outbound host next to the inbound one.
    pub smtp: (&'static str, u16),
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "gmail",
        label: "Gmail",
        auth: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        scopes: &["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
        imap_host: "imap.gmail.com",
        smtp: ("smtp.gmail.com", 465),
    },
    Provider {
        id: "zoho",
        label: "Zoho Mail",
        auth: "https://accounts.zoho.com/oauth/v2/auth",
        token: "https://accounts.zoho.com/oauth/v2/token",
        scopes: &["ZohoMail.accounts.READ", "ZohoMail.messages.READ", "ZohoMail.messages.CREATE"],
        imap_host: "imappro.zoho.com",
        smtp: ("smtppro.zoho.com", 465),
    },
];

pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|provider| provider.id == id)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Imap {
    pub email: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub imap: Imap,
    pub legacy: bool,
}

pub struct ConfigFile {
    path: PathBuf,
}

impl ConfigFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The whole file, or `{}` when it is missing or unreadable.
    pub fn read(&self) -> Map<String, Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn write(&self, value: &Map<String, Value>) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
        if let Some(parent) = self.path.parent() {
            create_private_dir(parent)?;
        }
        let temporary = self.path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
        let result = (|| {
            let mut file = private_file(&temporary)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub fn accounts(&self) -> Vec<Account> {
        accounts_from(&self.read())
    }

    pub fn find(&self, id: &str) -> Option<Account> {
        self.accounts().into_iter().find(|account| account.id == id)
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// `${provider}:${email.trim().toLowerCase()}`.
pub fn account_id(provider: &str, email: &str) -> String {
    format!("{provider}:{}", email.trim().to_lowercase())
}

fn imap_from(value: Option<&Value>) -> Option<Imap> {
    let imap = value?;
    let email = js::string_or_empty(imap.get("email"));
    if email.is_empty() {
        return None;
    }
    let port = imap.get("port").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()).unwrap_or(993);
    Some(Imap { email, host: js::string_or_empty(imap.get("host")), port })
}

pub fn accounts_from(config: &Map<String, Value>) -> Vec<Account> {
    let mut accounts = Vec::new();
    if let Some(Value::Object(current)) = config.get("accounts") {
        for (id, value) in current {
            let provider = js::string_or_empty(value.get("provider"));
            if let (false, Some(imap)) = (provider.is_empty(), imap_from(value.get("imap"))) {
                accounts.push(Account { id: id.clone(), provider, imap, legacy: false });
            }
        }
    }
    // Read pre-multi-account settings too; they remain usable until the account
    // is next connected, when it is stored in the new accounts collection.
    for provider in PROVIDERS {
        if let Some(imap) = config.get(provider.id).and_then(|value| imap_from(value.get("imap"))) {
            accounts.push(Account { id: provider.id.into(), provider: provider.id.into(), imap, legacy: true });
        }
    }
    accounts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_current_and_legacy_accounts() {
        let config = json!({
            "accounts": {
                "gmail:me@example.test": { "provider": "gmail", "imap": { "email": "me@example.test", "host": "imap.example.test", "port": 993 } },
                "broken": { "provider": "gmail", "imap": {} }
            },
            "zoho": { "imap": { "email": "old@example.test", "host": "imappro.zoho.com", "port": 993 } }
        });
        let accounts = accounts_from(config.as_object().unwrap());
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].id, "gmail:me@example.test");
        assert!(!accounts[0].legacy);
        assert_eq!(accounts[1].id, "zoho");
        assert!(accounts[1].legacy);
    }

    #[cfg(unix)]
    #[test]
    fn the_config_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let file = ConfigFile::new(root.path().join(".habibi/mail-providers.json"));
        file.write(json!({ "a": 1 }).as_object().unwrap()).unwrap();
        let mode = std::fs::metadata(root.path().join(".habibi/mail-providers.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir = std::fs::metadata(root.path().join(".habibi")).unwrap().permissions().mode();
        assert_eq!(dir & 0o777, 0o700);
        assert_eq!(file.read().get("a"), Some(&json!(1)));
    }
}
