//! Local address-book names for phone numbers, used as a fallback when
//! WhatsApp doesn't return a contact name. macOS reads Contacts; Windows and
//! Linux have no system address book Habibi can read, so they report
//! `unavailable` and the UI keeps showing numbers.
//!
//! Reads never prompt. Only [`request_access`] shows the system alert.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Contact {
    /// Digits only, at least 7 of them.
    pub phone: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Granted,
    NotDetermined,
    Denied,
    Unavailable,
}

/// Keep only digits; numbers shorter than 7 digits aren't useful for matching.
pub fn phone_digits(value: &str) -> Option<String> {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    (digits.len() >= 7).then_some(digits)
}

/// "Given Family", or the nickname when both are empty.
pub fn display_name(given: &str, family: &str, nickname: &str) -> Option<String> {
    let name = [given, family].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ");
    let label = if name.is_empty() { nickname.to_string() } else { name };
    (!label.is_empty()).then_some(label)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;
    use std::sync::Mutex;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::AllocAnyThread;
    use objc2_contacts::{
        CNAuthorizationStatus, CNContact, CNContactFamilyNameKey, CNContactFetchRequest, CNContactGivenNameKey,
        CNContactNicknameKey, CNContactPhoneNumbersKey, CNContactStore, CNEntityType, CNKeyDescriptor,
    };
    use objc2_foundation::{NSArray, NSError};

    use super::{display_name, phone_digits, Access, Contact};

    pub fn access() -> Access {
        match unsafe { CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts) } {
            CNAuthorizationStatus::Authorized => Access::Granted,
            CNAuthorizationStatus::NotDetermined => Access::NotDetermined,
            _ => Access::Denied,
        }
    }

    pub fn request_access() -> bool {
        let (sender, receiver) = std::sync::mpsc::channel::<bool>();
        let sender = Mutex::new(Some(sender));
        let store = unsafe { CNContactStore::new() };
        let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            if let Some(sender) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = sender.send(granted.as_bool());
            }
        });
        unsafe { store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &block) };
        // The user may take a while to answer the system alert. The store stays
        // alive until the alert is answered.
        let granted = receiver.recv_timeout(Duration::from_secs(300)).unwrap_or(false);
        drop(store);
        granted
    }

    pub fn read() -> Vec<Contact> {
        let store = unsafe { CNContactStore::new() };
        let keys: Retained<NSArray<ProtocolObject<dyn CNKeyDescriptor>>> = unsafe {
            NSArray::from_slice(&[
                ProtocolObject::from_ref(CNContactGivenNameKey),
                ProtocolObject::from_ref(CNContactFamilyNameKey),
                ProtocolObject::from_ref(CNContactNicknameKey),
                ProtocolObject::from_ref(CNContactPhoneNumbersKey),
            ])
        };
        let request = unsafe { CNContactFetchRequest::initWithKeysToFetch(CNContactFetchRequest::alloc(), &keys) };
        let contacts = Mutex::new(Vec::new());
        let block = RcBlock::new(|contact: NonNull<CNContact>, _stop: NonNull<Bool>| {
            let contact = unsafe { contact.as_ref() };
            let (given, family, nickname) =
                unsafe { (contact.givenName().to_string(), contact.familyName().to_string(), contact.nickname().to_string()) };
            let Some(name) = display_name(&given, &family, &nickname) else { return };
            let numbers = unsafe { contact.phoneNumbers() };
            let mut found = contacts.lock().unwrap_or_else(|e| e.into_inner());
            for labeled in numbers.iter() {
                let value = unsafe { labeled.value().stringValue() }.to_string();
                if let Some(phone) = phone_digits(&value) {
                    found.push(Contact { phone, name: name.clone() });
                }
            }
        });
        // A failed enumeration returns what was read so far, as the Swift did.
        let _ = unsafe { store.enumerateContactsWithFetchRequest_error_usingBlock(&request, None, &block) };
        drop(block);
        contacts.into_inner().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{Access, Contact};

    pub fn access() -> Access {
        Access::Unavailable
    }

    pub fn request_access() -> bool {
        false
    }

    pub fn read() -> Vec<Contact> {
        Vec::new()
    }
}

pub fn access() -> Access {
    imp::access()
}

/// Show the system permission alert (macOS only) and wait for the answer.
/// Blocks; call from a blocking thread.
pub fn request_access() -> bool {
    imp::request_access()
}

/// Every contact phone number with its display name. Call only when
/// [`access`] is [`Access::Granted`]; this blocks while Contacts is read.
pub fn read() -> Vec<Contact> {
    imp::read()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_numbers_keep_digits_and_need_seven() {
        assert_eq!(phone_digits("+44 (20) 7946-0958").as_deref(), Some("442079460958"));
        assert_eq!(phone_digits("123-456"), None);
    }

    #[test]
    fn names_prefer_given_and_family_then_nickname() {
        assert_eq!(display_name("Ada", "Lovelace", "A").as_deref(), Some("Ada Lovelace"));
        assert_eq!(display_name("", "Lovelace", "").as_deref(), Some("Lovelace"));
        assert_eq!(display_name("", "", "Ace").as_deref(), Some("Ace"));
        assert_eq!(display_name("", "", ""), None);
    }
}
