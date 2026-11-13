//! Provider API keys. In the app they live in the OS credential store under
//! the service the macOS helper used (`Habibi LLM Provider`) and the account
//! `provider:<id>`, so keys saved by the old app keep working. Keys never go
//! into files, process arguments, logs or responses.

use std::collections::HashMap;
use std::sync::Mutex;

use habibi_platform::secrets;

/// The credential-store account for a provider, as `keyAccount()` produced.
pub fn key_account(provider: &str) -> String {
    format!("provider:{provider}")
}

/// Where provider keys are kept. Calls may block (the OS store can prompt).
pub trait KeyStore: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    /// True when the secret was stored.
    fn set(&self, account: &str, secret: &str) -> bool;
}

/// The OS credential store (Keychain, Credential Manager, Secret Service).
pub struct PlatformKeyStore;

impl KeyStore for PlatformKeyStore {
    fn get(&self, account: &str) -> Option<String> {
        secrets::get(secrets::LLM, account).filter(|secret| !secret.is_empty())
    }

    fn set(&self, account: &str, secret: &str) -> bool {
        secrets::set(secrets::LLM, account, secret).is_ok()
    }
}

/// An in-memory store for tests and for callers that must not touch the OS
/// credential store.
#[derive(Default)]
pub struct MemoryKeyStore {
    secrets: Mutex<HashMap<String, String>>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, account: &str) -> Option<String> {
        self.secrets.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned()
    }

    fn set(&self, account: &str, secret: &str) -> bool {
        self.secrets.lock().unwrap_or_else(|e| e.into_inner()).insert(account.into(), secret.into());
        true
    }
}
