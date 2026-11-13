//! Secrets in the OS credential store: macOS Keychain, Windows Credential
//! Manager, or the Secret Service on Linux (GNOME Keyring, KWallet).
//!
//! Service names are the ones the macOS app already used, so existing Keychain
//! items keep working: `Habibi Mail`, `Habibi LLM Provider`, `Habibi WhoDB`.
//! (macOS may ask once to let the new app read an item the old app created.)
//! Secret values never appear in process arguments.

use crate::{PlatformError, PlatformResult};

pub const MAIL: &str = "Habibi Mail";
pub const LLM: &str = "Habibi LLM Provider";
pub const WHODB: &str = "Habibi WhoDB";

fn entry(service: &str, account: &str) -> PlatformResult<keyring_core::Entry> {
    if account.is_empty() || account.len() > 2048 {
        return Err(PlatformError::Failed("Invalid credential name.".into()));
    }
    // Install the OS store once (Keychain, Credential Manager, Secret
    // Service), then use whichever store is the default. `keyring::Entry`
    // refuses outright when the OS store could not start (Linux without a
    // Secret Service), even if a replacement store has been installed.
    let _ = keyring::Entry::store_status();
    keyring_core::Entry::new(service, account)
        .map_err(|_| PlatformError::Failed("The system credential store is unavailable.".into()))
}

/// The stored secret, or `None` when there is none (or the store is locked).
pub fn get(service: &str, account: &str) -> Option<String> {
    entry(service, account).ok()?.get_password().ok()
}

pub fn set(service: &str, account: &str, secret: &str) -> PlatformResult<()> {
    if secret.is_empty() || secret.len() > 262_144 {
        return Err(PlatformError::Failed("Invalid credential.".into()));
    }
    entry(service, account)?
        .set_password(secret)
        .map_err(|_| PlatformError::Failed("The credential could not be saved.".into()))
}

/// Remove a secret. Removing one that does not exist succeeds.
pub fn delete(service: &str, account: &str) -> PlatformResult<()> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(_) => Err(PlatformError::Failed(
            "The credential could not be removed.".into(),
        )),
    }
}
