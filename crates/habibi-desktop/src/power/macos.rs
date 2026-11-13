//! `NSWorkspace` and distributed lock notifications on the main queue.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

use super::{PowerCallback, PowerEvent};

const WORKSPACE: [(&str, PowerEvent); 6] = [
    ("NSWorkspaceWillSleepNotification", PowerEvent::WillSleep),
    ("NSWorkspaceDidWakeNotification", PowerEvent::DidWake),
    ("NSWorkspaceScreensDidSleepNotification", PowerEvent::ScreensSlept),
    ("NSWorkspaceScreensDidWakeNotification", PowerEvent::ScreensWoke),
    ("NSWorkspaceSessionDidResignActiveNotification", PowerEvent::SessionResigned),
    ("NSWorkspaceSessionDidBecomeActiveNotification", PowerEvent::SessionActivated),
];

/// The screen lock (⌃⌘Q, hot corners, the lock screen) posts no workspace
/// notification, only these distributed ones.
const DISTRIBUTED: [(&str, PowerEvent); 2] = [
    ("com.apple.screenIsLocked", PowerEvent::SessionResigned),
    ("com.apple.screenIsUnlocked", PowerEvent::SessionActivated),
];

/// Debug builds only: `object` names one of the `PowerEvent` variants, so a
/// helper process can exercise sleep/wake handling without sleeping the Mac.
#[cfg(debug_assertions)]
const DEBUG_NAME: &str = "com.clidey.habibi.debug.power";

/// # Safety
/// `center` must be a live `NSNotificationCenter`; main thread only.
unsafe fn observe(center: &AnyObject, name: &str, handler: impl Fn(*mut AnyObject) + 'static) {
    let block = RcBlock::new(move |note: *mut AnyObject| handler(note));
    let name = NSString::from_str(name);
    unsafe {
        let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
        let token: Option<Retained<AnyObject>> = msg_send![
            center,
            addObserverForName: &*name,
            object: std::ptr::null_mut::<AnyObject>(),
            queue: queue,
            usingBlock: &*block
        ];
        // Observers live for the rest of the process.
        std::mem::forget(token);
    }
}

pub fn watch(callback: PowerCallback) {
    // SAFETY: called on the main thread (see `power::watch`); every receiver
    // below is a shared AppKit/Foundation singleton.
    unsafe {
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        let center: Retained<AnyObject> = msg_send![&*workspace, notificationCenter];
        for (name, event) in WORKSPACE {
            let callback = callback.clone();
            observe(&center, name, move |_| callback(event));
        }
        let distributed: Retained<AnyObject> = msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
        for (name, event) in DISTRIBUTED {
            let callback = callback.clone();
            observe(&distributed, name, move |_| callback(event));
        }
        #[cfg(debug_assertions)]
        {
            let callback = callback.clone();
            observe(&distributed, DEBUG_NAME, move |note| {
                if note.is_null() {
                    return;
                }
                // SAFETY: `note` is the NSNotification being delivered.
                let object: *mut AnyObject = msg_send![note, object];
                if object.is_null() {
                    return;
                }
                // SAFETY: distributed notifications carry an NSString object.
                let text = (*object.cast::<NSString>()).to_string();
                let event = match text.as_str() {
                    "WillSleep" => PowerEvent::WillSleep,
                    "DidWake" => PowerEvent::DidWake,
                    "ScreensSlept" => PowerEvent::ScreensSlept,
                    "ScreensWoke" => PowerEvent::ScreensWoke,
                    "SessionResigned" => PowerEvent::SessionResigned,
                    "SessionActivated" => PowerEvent::SessionActivated,
                    _ => return,
                };
                callback(event);
            });
        }
    }
}
