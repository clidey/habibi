//! WhoDB sign-in tokens in the OS credential store.
//!
//! The macOS helper (`native/HabibiKeychain.swift`) stored one generic
//! password per instance: service `Habibi WhoDB`, account = the instance
//! origin (e.g. `https://app.whodb.com`), value = the JSON
//! `{"accessToken","refreshToken","expiresAt"}`. The same names are used
//! here so existing sessions keep working.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Milliseconds since the Unix epoch, written as an integer like `Date.now()`.
    #[serde(serialize_with = "js_number")]
    pub expires_at: f64,
}

fn js_number<S: serde::Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    crate::util::number_value(*value).serialize(serializer)
}

/// Raw secret storage, injectable so tests never touch the real Keychain.
#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn get(&self, account: &str) -> Option<String>;
    async fn set(&self, account: &str, secret: &str) -> Result<(), ()>;
}

/// `habibi_platform::secrets` under the `Habibi WhoDB` service.
pub struct SystemSecrets;

#[async_trait]
impl SecretStore for SystemSecrets {
    async fn get(&self, account: &str) -> Option<String> {
        let account = account.to_string();
        // The credential store can block (or show a system prompt); keep it
        // off the async workers.
        tokio::task::spawn_blocking(move || habibi_platform::secrets::get(habibi_platform::secrets::WHODB, &account))
            .await
            .ok()
            .flatten()
    }

    async fn set(&self, account: &str, secret: &str) -> Result<(), ()> {
        let (account, secret) = (account.to_string(), secret.to_string());
        tokio::task::spawn_blocking(move || {
            habibi_platform::secrets::set(habibi_platform::secrets::WHODB, &account, &secret).map_err(|_| ())
        })
        .await
        .map_err(|_| ())?
    }
}

#[derive(Clone)]
pub struct TokenStore {
    secrets: Arc<dyn SecretStore>,
}

impl TokenStore {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        Self { secrets }
    }

    /// Saved tokens for `host`, or `None` when absent or malformed.
    pub async fn get(&self, host: &str) -> Option<Tokens> {
        let saved: Value = serde_json::from_str(&self.secrets.get(host).await?).ok()?;
        let access = saved.get("accessToken").and_then(Value::as_str).filter(|token| !token.is_empty())?;
        let expires_at = saved.get("expiresAt").and_then(Value::as_f64).filter(|value| value.is_finite())?;
        let refresh = saved.get("refreshToken").and_then(Value::as_str).unwrap_or("");
        Some(Tokens { access_token: access.into(), refresh_token: refresh.into(), expires_at })
    }

    /// Save, then read back: a truncated or failed write must never report a
    /// successful sign-in.
    pub(crate) async fn set(&self, host: &str, tokens: &Tokens) -> Result<(), ()> {
        let secret = serde_json::to_string(tokens).map_err(|_| ())?;
        self.secrets.set(host, &secret).await?;
        if self.secrets.get(host).await.as_deref() != Some(secret.as_str()) {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(test)]
pub mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// In-memory secrets; `truncate` simulates a store that cuts long values.
    #[derive(Default)]
    pub struct MemorySecrets {
        pub values: Mutex<HashMap<String, String>>,
        pub truncate: Option<usize>,
    }

    #[async_trait]
    impl SecretStore for MemorySecrets {
        async fn get(&self, account: &str) -> Option<String> {
            self.values.lock().unwrap().get(account).cloned()
        }

        async fn set(&self, account: &str, secret: &str) -> Result<(), ()> {
            let value = match self.truncate {
                Some(limit) => secret.chars().take(limit).collect(),
                None => secret.to_string(),
            };
            self.values.lock().unwrap().insert(account.to_string(), value);
            Ok(())
        }
    }

    #[tokio::test]
    async fn tokens_round_trip_under_the_instance_origin() {
        let secrets = Arc::new(MemorySecrets::default());
        let store = TokenStore::new(secrets.clone());
        let tokens = Tokens { access_token: "private-access".into(), refresh_token: "private-refresh".into(), expires_at: 1.0e12 };
        store.set("https://app.whodb.com", &tokens).await.unwrap();
        assert_eq!(store.get("https://app.whodb.com").await, Some(tokens));
        let raw = secrets.values.lock().unwrap()["https://app.whodb.com"].clone();
        assert_eq!(raw, r#"{"accessToken":"private-access","refreshToken":"private-refresh","expiresAt":1000000000000}"#);
    }

    #[tokio::test]
    async fn truncated_writes_cannot_report_a_successful_sign_in() {
        let secrets = Arc::new(MemorySecrets { truncate: Some(128), ..Default::default() });
        let store = TokenStore::new(secrets);
        let tokens = Tokens { access_token: "a".repeat(8000), refresh_token: "r".repeat(8000), expires_at: 1.0e13 };
        assert!(store.set("https://app.whodb.com", &tokens).await.is_err());
        assert_eq!(store.get("https://app.whodb.com").await, None);
    }
}
