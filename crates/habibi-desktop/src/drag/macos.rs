//! The AppKit file drag. Everything here runs on the main thread.
//!
//! The page posts `prepareNativeFileDrag` on pointerdown; the shell validates
//! the path and calls [`prepare`]. A local monitor then sees the press's
//! first `leftMouseDragged` past a small threshold, begins an
//! `NSDraggingSession` from the webview with that very event and swallows it,
//! so WebKit never starts its own URL drag. `leftMouseUp` or a new press
//! discards an unused preparation.

use std::cell::RefCell;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, ClassBuilder, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

use super::DragEvent;

const LEFT_MOUSE_DOWN: usize = 1;
const LEFT_MOUSE_UP: usize = 2;
const LEFT_MOUSE_DRAGGED: usize = 6;
const MASK: u64 = (1 << LEFT_MOUSE_DOWN) | (1 << LEFT_MOUSE_UP) | (1 << LEFT_MOUSE_DRAGGED);
/// Points the pointer must travel before a press becomes a drag, so a
/// slightly shaky click still opens the result.
const THRESHOLD: f64 = 3.0;
const ICON: f64 = 38.0;
/// `NSDragOperationCopy`.
const COPY: usize = 1;

struct State {
    window: *mut AnyObject,
    view: *mut AnyObject,
    source: Retained<AnyObject>,
    callback: Rc<dyn Fn(DragEvent)>,
    pressed_at: Option<NSPoint>,
    prepared: Option<PathBuf>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn notify(event: DragEvent) {
    // Clone out first: the callback may evaluate script in the webview.
    let callback = STATE.with(|state| state.borrow().as_ref().map(|state| state.callback.clone()));
    if let Some(callback) = callback {
        callback(event);
    }
}

extern "C-unwind" fn operation_mask(_this: &AnyObject, _cmd: Sel, _session: *mut AnyObject, _context: isize) -> usize {
    COPY
}

extern "C-unwind" fn ended(_this: &AnyObject, _cmd: Sel, _session: *mut AnyObject, _point: NSPoint, _operation: usize) {
    notify(DragEvent::Ended);
}

/// An `NSObject` that conforms to `NSDraggingSource` and allows copying.
fn source_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let name = c"HabibiFileDragSource";
        if let Some(existing) = AnyClass::get(name) {
            return Some(existing);
        }
        let mut builder = ClassBuilder::new(name, class!(NSObject))?;
        if let Some(protocol) = AnyProtocol::get(c"NSDraggingSource") {
            builder.add_protocol(protocol);
        }
        // SAFETY: the signatures match the NSDraggingSource methods
        // (NSDragOperation is NSUInteger, NSDraggingContext is NSInteger).
        unsafe {
            builder.add_method(
                sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                operation_mask as extern "C-unwind" fn(_, _, _, _) -> _,
            );
            builder.add_method(sel!(draggingSession:endedAtPoint:operation:), ended as extern "C-unwind" fn(_, _, _, _, _));
        }
        Some(builder.register())
    })
}

/// Begin the session for `path` with the drag event that crossed the threshold.
///
/// # Safety
/// Main thread; `view` is the live webview and `event` the current NSEvent.
unsafe fn begin(view: *mut AnyObject, source: &AnyObject, event: *mut AnyObject, path: &Path) -> bool {
    let Some(text) = path.to_str() else { return false };
    unsafe {
        let path = NSString::from_str(text);
        // Give AppKit the NSURL itself, as Finder does: hand-built
        // file-url pasteboard entries look like links to some targets.
        let url: Option<Retained<AnyObject>> = msg_send![class!(NSURL), fileURLWithPath: &*path];
        let Some(url) = url else { return false };
        let allocated: Allocated<AnyObject> = msg_send![class!(NSDraggingItem), alloc];
        let item: Option<Retained<AnyObject>> = msg_send![allocated, initWithPasteboardWriter: &*url];
        let Some(item) = item else { return false };
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        let icon: Option<Retained<AnyObject>> = msg_send![&*workspace, iconForFile: &*path];
        let location: NSPoint = msg_send![event, locationInWindow];
        let point: NSPoint = msg_send![view, convertPoint: location, fromView: std::ptr::null_mut::<AnyObject>()];
        let frame = NSRect::new(NSPoint::new(point.x - ICON / 2.0, point.y - ICON / 2.0), NSSize::new(ICON, ICON));
        match icon {
            Some(icon) => {
                let _: () = msg_send![&*icon, setSize: NSSize::new(ICON, ICON)];
                let _: () = msg_send![&*item, setDraggingFrame: frame, contents: &*icon];
            }
            None => {
                let _: () = msg_send![&*item, setDraggingFrame: frame, contents: std::ptr::null_mut::<AnyObject>()];
            }
        }
        let items: Retained<AnyObject> = msg_send![class!(NSArray), arrayWithObject: &*item];
        let session: Option<Retained<AnyObject>> =
            msg_send![view, beginDraggingSessionWithItems: &*items, event: event, source: source];
        session.is_some()
    }
}

/// Watch launcher mouse events for prepared drags. `callback` hears when a
/// drag starts, ends, or could not start.
///
/// # Safety
/// Main thread; `window` is the launcher's live `NSWindow *` and `view` its
/// webview (`WKWebView *`), both alive for the rest of the process.
pub unsafe fn install(window: *mut c_void, view: *mut c_void, callback: impl Fn(DragEvent) + 'static) {
    let Some(class) = source_class() else { return };
    // SAFETY: `new` on an NSObject subclass.
    let source: Option<Retained<AnyObject>> = unsafe { msg_send![class, new] };
    let Some(source) = source else { return };
    let installed = STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.is_some() {
            return false;
        }
        *state = Some(State {
            window: window.cast(),
            view: view.cast(),
            source,
            callback: Rc::new(callback),
            pressed_at: None,
            prepared: None,
        });
        true
    });
    if !installed {
        return;
    }
    let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() {
            return event;
        }
        // SAFETY: `event` is the NSEvent the monitor received, on the main thread.
        let (kind, window, location): (usize, *mut AnyObject, NSPoint) =
            unsafe { (msg_send![event, type], msg_send![event, window], msg_send![event, locationInWindow]) };
        let start = STATE.with(|state| {
            let mut state = state.borrow_mut();
            let state = state.as_mut()?;
            if window != state.window {
                return None;
            }
            match kind {
                LEFT_MOUSE_DOWN => {
                    state.pressed_at = Some(location);
                    state.prepared = None;
                    None
                }
                LEFT_MOUSE_UP => {
                    state.pressed_at = None;
                    state.prepared = None;
                    None
                }
                LEFT_MOUSE_DRAGGED => {
                    let origin = state.pressed_at?;
                    state.prepared.as_ref()?;
                    let moved = (location.x - origin.x).hypot(location.y - origin.y);
                    if moved < THRESHOLD {
                        return None;
                    }
                    let path = state.prepared.take()?;
                    Some((state.view, state.source.clone(), path))
                }
                _ => None,
            }
        });
        let Some((view, source, path)) = start else { return event };
        // SAFETY: main thread, live webview, the current drag event.
        if unsafe { begin(view, &source, event, &path) } {
            notify(DragEvent::Started);
            std::ptr::null_mut()
        } else {
            notify(DragEvent::Failed);
            event
        }
    });
    // SAFETY: main thread; the monitor lives for the rest of the process.
    unsafe {
        let monitor: Option<Retained<AnyObject>> =
            msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: MASK, handler: &*handler];
        std::mem::forget(monitor);
    }
}

/// Arm a drag for the press in progress. Ignored once that press has ended
/// (a quick click whose message arrived late must not arm the next drag).
pub fn prepare(path: PathBuf) {
    STATE.with(|state| {
        if let Some(state) = state.borrow_mut().as_mut() {
            state.prepared = state.pressed_at.is_some().then_some(path);
        }
    });
}

/// Forget an armed drag (the page asked for a path that may not be dragged).
pub fn cancel() {
    STATE.with(|state| {
        if let Some(state) = state.borrow_mut().as_mut() {
            state.prepared = None;
        }
    });
}
