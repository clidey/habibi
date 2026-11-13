//! AppKit details the Swift app relied on that Tauri does not expose:
//! WKWebView rounded clipping, panel collection behaviour, the ⌘V image
//! paste capture, the screen's camera-housing inset, login items and sounds.
//!
//! Functions that take a window or view pointer must be called on the main
//! thread with a live `NSWindow *` / `NSView *` (Tauri's `ns_window()` /
//! `ns_view()`).

use std::ffi::c_void;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSString};

#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

/// `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary`.
const JOIN_ALL_SPACES_AUXILIARY: usize = (1 << 0) | (1 << 8);
/// `NSEventMaskKeyDown`.
const KEY_DOWN_MASK: u64 = 1 << 10;
const COMMAND: usize = 1 << 20;
const OPTION: usize = 1 << 19;
const CONTROL: usize = 1 << 18;
const KEY_V: u16 = 9;
/// `NSFloatingWindowLevel` and `NSStatusWindowLevel`.
pub const FLOATING_LEVEL: isize = 3;
pub const STATUS_LEVEL: isize = 25;

/// Clip a view's layer to rounded corners at the compositor, so the
/// transparent web surface has one deliberate silhouette in every theme.
/// `bottom_only` rounds only the lower corners (the teleprompter housing).
///
/// # Safety
/// `view` must be a live `NSView *` and this must run on the main thread.
pub unsafe fn round_view(view: *mut c_void, radius: f64, bottom_only: bool) {
    let view = view.cast::<AnyObject>();
    if view.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![view, setWantsLayer: true];
        let layer: Option<Retained<AnyObject>> = msg_send![view, layer];
        if let Some(layer) = layer {
            let _: () = msg_send![&*layer, setCornerRadius: radius];
            let _: () = msg_send![&*layer, setMasksToBounds: true];
            let continuous = NSString::from_str("continuous");
            let _: () = msg_send![&*layer, setCornerCurve: &*continuous];
            if bottom_only {
                // kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner in a
                // flipped-to-AppKit layer: the two bottom corners.
                let _: () = msg_send![&*layer, setMaskedCorners: 0b0011usize];
            }
        }
    }
}

/// Round the window's content view (which hosts the WKWebView).
///
/// # Safety
/// `window` must be a live `NSWindow *` and this must run on the main thread.
pub unsafe fn round_window(window: *mut c_void, radius: f64, bottom_only: bool) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    unsafe {
        let content: *mut AnyObject = msg_send![window, contentView];
        round_view(content.cast(), radius, bottom_only);
    }
}

/// Show `window` above others without activating Habibi or making it key,
/// as the Swift app's non-activating panels did.
///
/// # Safety
/// `window` must be a live `NSWindow *` and this must run on the main thread.
pub unsafe fn order_front(window: *mut c_void) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![window, orderFrontRegardless];
    }
}

/// Float above normal windows on every Space, including full-screen ones,
/// without the native shadow (the web surface draws its own depth).
///
/// # Safety
/// `window` must be a live `NSWindow *` and this must run on the main thread.
pub unsafe fn configure_panel(window: *mut c_void, level: isize) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    unsafe {
        let behavior: usize = msg_send![window, collectionBehavior];
        let _: () = msg_send![window, setCollectionBehavior: behavior | JOIN_ALL_SPACES_AUXILIARY];
        let _: () = msg_send![window, setLevel: level];
        let _: () = msg_send![window, setHasShadow: false];
        let _: () = msg_send![window, setMovableByWindowBackground: false];
    }
}

/// True when `window` is the key window.
///
/// # Safety
/// Must run on the main thread.
pub unsafe fn is_key_window(window: *mut c_void) -> bool {
    unsafe {
        let app: Option<Retained<AnyObject>> = msg_send![class!(NSApplication), sharedApplication];
        let Some(app) = app else { return false };
        let key: *mut AnyObject = msg_send![&*app, keyWindow];
        !key.is_null() && key == window.cast::<AnyObject>()
    }
}

/// Capture ⌘V before WKWebView sees it. WKWebView can consume an image
/// paste — and play the failure sound — without emitting a DOM paste event.
/// A local monitor sits above that responder chain and is deterministic.
/// `on_paste` runs on the main thread for every plain ⌘V and returns true
/// when it handled the paste (the event is then swallowed).
///
/// # Safety
/// Must run on the main thread. The monitor lives for the rest of the process.
pub unsafe fn install_paste_monitor(on_paste: impl Fn() -> bool + 'static) {
    let handler = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() {
            return event;
        }
        // SAFETY: `event` is the NSEvent the monitor received.
        let (flags, key): (usize, u16) = unsafe { (msg_send![event, modifierFlags], msg_send![event, keyCode]) };
        let plain_command = flags & COMMAND != 0 && flags & (OPTION | CONTROL) == 0;
        if plain_command && key == KEY_V && on_paste() {
            return std::ptr::null_mut();
        }
        event
    });
    unsafe {
        let monitor: Option<Retained<AnyObject>> =
            msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: KEY_DOWN_MASK, handler: &*handler];
        // Keep the monitor for the life of the app.
        std::mem::forget(monitor);
    }
}

/// Geometry of the screen under the mouse pointer, in AppKit points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenInfo {
    /// Full frame: x, y (bottom-left origin), width, height.
    pub frame: (f64, f64, f64, f64),
    pub visible_width: f64,
    /// `safeAreaInsets.top` — the camera housing on notched displays.
    pub top_inset: f64,
}

/// The screen under the pointer (or the main screen).
///
/// # Safety
/// Must run on the main thread.
pub unsafe fn pointer_screen() -> Option<ScreenInfo> {
    unsafe {
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let screens: Option<Retained<AnyObject>> = msg_send![class!(NSScreen), screens];
        let screens = screens?;
        let count: usize = msg_send![&*screens, count];
        let mut chosen: Option<Retained<AnyObject>> = None;
        for index in 0..count {
            let screen: Retained<AnyObject> = msg_send![&*screens, objectAtIndex: index];
            let frame: NSRect = msg_send![&*screen, frame];
            let inside = mouse.x >= frame.origin.x
                && mouse.x <= frame.origin.x + frame.size.width
                && mouse.y >= frame.origin.y
                && mouse.y <= frame.origin.y + frame.size.height;
            if inside {
                chosen = Some(screen);
                break;
            }
        }
        let screen = match chosen {
            Some(screen) => screen,
            None => {
                let main: Option<Retained<AnyObject>> = msg_send![class!(NSScreen), mainScreen];
                main?
            }
        };
        let frame: NSRect = msg_send![&*screen, frame];
        let visible: NSRect = msg_send![&*screen, visibleFrame];
        let responds: bool = msg_send![&*screen, respondsToSelector: objc2::sel!(safeAreaInsets)];
        let top_inset = if responds {
            let insets: EdgeInsets = msg_send![&*screen, safeAreaInsets];
            insets.top
        } else {
            0.0
        };
        Some(ScreenInfo {
            frame: (frame.origin.x, frame.origin.y, frame.size.width, frame.size.height),
            visible_width: visible.size.width,
            top_inset,
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct EdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

// SAFETY: matches `NSEdgeInsets` ({top,left,bottom,right} of CGFloat).
unsafe impl objc2::Encode for EdgeInsets {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "NSEdgeInsets",
        &[objc2::Encoding::Double, objc2::Encoding::Double, objc2::Encoding::Double, objc2::Encoding::Double],
    );
}

/// Play a named system sound (e.g. "Glass").
pub fn play_sound(name: &str) {
    // SAFETY: `+[NSSound soundNamed:]` and `-play` take no other arguments.
    unsafe {
        let name = NSString::from_str(name);
        let sound: Option<Retained<AnyObject>> = msg_send![class!(NSSound), soundNamed: &*name];
        if let Some(sound) = sound {
            let _: bool = msg_send![&*sound, play];
        }
    }
}

fn main_app_service() -> Option<Retained<AnyObject>> {
    let service = AnyClass::get(c"SMAppService")?;
    // SAFETY: `+[SMAppService mainAppService]` (macOS 13+) takes no arguments.
    unsafe { msg_send![service, mainAppService] }
}

/// True when Habibi is registered to open at login (`SMAppService.mainApp`).
pub fn login_item_enabled() -> bool {
    let Some(service) = main_app_service() else { return false };
    // SAFETY: `status` is an NSInteger property; 1 == SMAppServiceStatusEnabled.
    let status: isize = unsafe { msg_send![&*service, status] };
    status == 1
}

/// Register or unregister the app as a login item. Only meaningful for the
/// installed, signed bundle.
pub fn set_login_item(enabled: bool) -> bool {
    let Some(service) = main_app_service() else { return false };
    let error = std::ptr::null_mut::<*mut AnyObject>();
    // SAFETY: both methods take an optional `NSError **` (NULL here).
    unsafe {
        if enabled {
            msg_send![&*service, registerAndReturnError: error]
        } else {
            msg_send![&*service, unregisterAndReturnError: error]
        }
    }
}
