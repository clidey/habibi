//! App passwords and OAuth refresh tokens in the OS credential store, under
//! the `Habibi Mail` service with the account names the macOS `security`
//! calls used (`imap:<account id>`, `imap:<provider>` for legacy settings,
//! `refresh:<provider>`), so existing installs keep their credentials.

#[cfg(test)]
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

use habibi_platform::secrets;

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    fn set(&self, account: &str, secret: &str) -> bool;
    fn delete(&self, account: &str);
}

/// The real credential store.
pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Option<String> {
        secrets::get(secrets::MAIL, account).filter(|secret| !secret.is_empty())
    }

    fn set(&self, account: &str, secret: &str) -> bool {
        secrets::set(secrets::MAIL, account, secret).is_ok()
    }

    fn delete(&self, account: &str) {
        let _ = secrets::delete(secrets::MAIL, account);
    }
}

/// Credential-store calls can block (macOS may show an access prompt), so
/// they run off the async workers.
pub async fn get(store: &Arc<dyn SecretStore>, account: String) -> String {
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || store.get(&account)).await.ok().flatten().unwrap_or_default()
}

pub async fn set(store: &Arc<dyn SecretStore>, account: String, secret: String) -> bool {
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || store.set(&account, &secret)).await.unwrap_or(false)
}

pub async fn delete(store: &Arc<dyn SecretStore>, account: String) {
    let store = Arc::clone(store);
    let _ = tokio::task::spawn_blocking(move || store.delete(&account)).await;
}

/// The user-facing name of the credential store in error messages.
pub fn store_name() -> &'static str {
    match habibi_platform::os() {
        "macos" => "macOS Keychain",
        "windows" => "Windows Credential Manager",
        _ => "the system keyring",
    }
}

/// In-memory store for tests; never touches the real Keychain.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    pub items: Mutex<HashMap<String, String>>,
    pub fail_writes: bool,
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Option<String> {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned()
    }

    fn set(&self, account: &str, secret: &str) -> bool {
        if self.fail_writes {
            return false;
        }
        self.items.lock().unwrap_or_else(|e| e.into_inner()).insert(account.into(), secret.into());
        true
    }

    fn delete(&self, account: &str) {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
    }
}
