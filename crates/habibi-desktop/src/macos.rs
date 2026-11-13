//! AppKit details the Swift app relied on that Tauri does not expose:
//! WKWebView rounded clipping, non-activating panels on every Space, the ⌘V image
//! paste capture, the screen's camera-housing inset, login items and sounds.
//!
//! Functions that take a window or view pointer must be called on the main
//! thread with a live `NSWindow *` / `NSView *` (Tauri's `ns_window()` /
//! `ns_view()`).

use std::ffi::c_void;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSString};

#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

/// `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary`.
const JOIN_ALL_SPACES_AUXILIARY: usize = (1 << 0) | (1 << 8);
/// `NSWindowCollectionBehaviorIgnoresCycle`.
const IGNORES_CYCLE: usize = 1 << 6;
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

/// Which of the Swift app's panels a window stands in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelKind {
    /// The launcher: becomes key (and main) so the webview gets the keyboard.
    Launcher,
    /// The teleprompter: becomes key when clicked (Space / Esc), never main.
    Reading,
    /// The focus-timer pill: never key; its buttons still click.
    Pill,
}

impl PanelKind {
    /// `NSWindow.Level`: `.floating`, `.statusBar + 1`, `.statusBar`.
    pub fn level(self) -> isize {
        match self {
            Self::Launcher => FLOATING_LEVEL,
            Self::Reading => STATUS_LEVEL + 1,
            Self::Pill => STATUS_LEVEL,
        }
    }

    fn collection_behavior(self) -> usize {
        match self {
            Self::Reading => JOIN_ALL_SPACES_AUXILIARY | IGNORES_CYCLE,
            Self::Launcher | Self::Pill => JOIN_ALL_SPACES_AUXILIARY,
        }
    }

    fn has_shadow(self) -> bool {
        self == Self::Pill
    }
}

/// Give a Tauri (tao) window the Swift panels' behaviour: on every Space
/// including full-screen apps' (`canJoinAllSpaces | fullScreenAuxiliary`,
/// plus `ignoresCycle` for the teleprompter), at the Swift window level,
/// never hidden on deactivation, without the native shadow except for the
/// focus pill, and non-activating: clicking or keying it never activates
/// Habibi, so the user's app (full-screen or not) stays frontmost.
///
/// The launcher is converted to a real `NSPanel` with the
/// `.nonactivatingPanel` style by the shell (tauri-nspanel) before this runs;
/// a plain `NSWindow` cannot become key while Habibi is inactive. For the
/// overlays, which stay `NSWindow`s, this also sets the window-server flag
/// `NSPanel` sets for that style (`-[NSWindow _setPreventsActivation:]`) when
/// AppKit still has it. Returns whether that flag was available.
///
/// # Safety
/// `window` must be a live `NSWindow *` and this must run on the main thread.
pub unsafe fn configure_panel(window: *mut c_void, kind: PanelKind) -> bool {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return false;
    }
    unsafe {
        let _: () = msg_send![window, setHidesOnDeactivate: false];
        let _: () = msg_send![window, setCollectionBehavior: kind.collection_behavior()];
        let _: () = msg_send![window, setLevel: kind.level()];
        let _: () = msg_send![window, setHasShadow: kind.has_shadow()];
        let _: () = msg_send![window, setMovableByWindowBackground: false];
        let prevents = sel!(_setPreventsActivation:);
        let available: bool = msg_send![window, respondsToSelector: prevents];
        if available {
            let _: () = msg_send![window, _setPreventsActivation: true];
        }
        available
    }
}

/// Make `window` key and bring it forward without activating Habibi (the
/// non-activating panel keeps the user's app frontmost).
///
/// # Safety
/// `window` must be a live `NSWindow *` and this must run on the main thread.
pub unsafe fn make_key(window: *mut c_void) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Development diagnostics for a panel: class, style, Spaces behaviour,
/// level, key state, and whether Habibi became the active app.
///
/// # Safety
/// `window` must be a live `NSWindow *` and this must run on the main thread.
#[cfg(debug_assertions)]
pub unsafe fn describe_window(window: *mut c_void) -> String {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return "no window".into();
    }
    unsafe {
        let class = (*window).class().name().to_string_lossy().into_owned();
        let mask: usize = msg_send![window, styleMask];
        let behavior: usize = msg_send![window, collectionBehavior];
        let level: isize = msg_send![window, level];
        let key: bool = msg_send![window, isKeyWindow];
        let visible: bool = msg_send![window, isVisible];
        let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let active: bool = msg_send![&*app, isActive];
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        let front: Option<Retained<AnyObject>> = msg_send![&*workspace, frontmostApplication];
        let front_pid: i32 = front.map(|app| msg_send![&*app, processIdentifier]).unwrap_or(-1);
        format!(
            "class={class} styleMask={mask:#x} collectionBehavior={behavior:#x} level={level} visible={visible} key={key} appActive={active} frontmostPid={front_pid} ownPid={}",
            std::process::id()
        )
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
