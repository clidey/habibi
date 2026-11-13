//! Reads the WhatsApp Desktop window through the macOS Accessibility API
//! (`native/whatsapp-accessibility.swift`). Elsewhere it reports
//! `{ ok: false, reason: "unsupported_platform" }`, alongside the existing
//! `accessibility_not_allowed` and `whatsapp_not_running` reasons.

use serde_json::{Value, json};

/// `{ ok: true, pid, windows: [tree] }` or `{ ok: false, reason }`.
pub async fn snapshot() -> Value {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(ax::snapshot)
            .await
            .unwrap_or_else(|_| json!({ "ok": false, "reason": "whatsapp_not_running" }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        json!({ "ok": false, "reason": "unsupported_platform" })
    }
}

#[cfg(target_os = "macos")]
mod ax {
    use std::ffi::{c_char, c_void};

    use serde_json::{Map, Value, json};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;
    type CFIndex = isize;

    const UTF8: u32 = 0x0800_0100;
    const AX_SUCCESS: i32 = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: CFIndex,
            encoding: u32,
            external: u8,
        ) -> CFStringRef;
        fn CFRelease(value: CFTypeRef);
        fn CFGetTypeID(value: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetCount(array: CFTypeRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: CFIndex) -> *const c_void;
        fn CFStringGetLength(string: CFStringRef) -> CFIndex;
        fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
        fn CFStringGetCString(string: CFStringRef, buffer: *mut c_char, size: CFIndex, encoding: u32) -> u8;
    }

    /// An owned (+1) Core Foundation reference, released on drop.
    struct Owned(CFTypeRef);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: we own exactly one reference to a valid CF object.
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn cf_string(text: &str) -> Owned {
        // SAFETY: the bytes are valid UTF-8 for the given length.
        Owned(unsafe { CFStringCreateWithBytes(std::ptr::null(), text.as_ptr(), text.len() as CFIndex, UTF8, 0) })
    }

    /// SAFETY: `value` must be a valid CFString.
    unsafe fn rust_string(value: CFStringRef) -> Option<String> {
        unsafe {
            let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) + 1;
            let mut buffer = vec![0u8; usize::try_from(size).ok()?];
            if CFStringGetCString(value, buffer.as_mut_ptr().cast(), size, UTF8) == 0 {
                return None;
            }
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
            buffer.truncate(end);
            String::from_utf8(buffer).ok()
        }
    }

    fn attribute(element: AXUIElementRef, name: &str) -> Option<Owned> {
        let name = cf_string(name);
        if name.0.is_null() {
            return None;
        }
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: element is a live AXUIElement; on success `value` is +1.
        let status = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut value) };
        (status == AX_SUCCESS && !value.is_null()).then_some(Owned(value))
    }

    fn text(element: AXUIElementRef, name: &str) -> Option<String> {
        let value = attribute(element, name)?;
        // SAFETY: the type is checked before treating it as a CFString.
        unsafe { (CFGetTypeID(value.0) == CFStringGetTypeID()).then(|| rust_string(value.0)).flatten() }
    }

    fn elements(element: AXUIElementRef, name: &str, limit: usize, visit: &mut dyn FnMut(AXUIElementRef)) {
        let Some(array) = attribute(element, name) else { return };
        // SAFETY: the type is checked; items are borrowed from the array,
        // which stays alive for the duration of the loop.
        unsafe {
            if CFGetTypeID(array.0) != CFArrayGetTypeID() {
                return;
            }
            let count = usize::try_from(CFArrayGetCount(array.0)).unwrap_or(0).min(limit);
            for index in 0..count {
                let item = CFArrayGetValueAtIndex(array.0, index as CFIndex);
                if !item.is_null() {
                    visit(item);
                }
            }
        }
    }

    fn node(element: AXUIElementRef, depth: usize) -> Value {
        let mut node = Map::new();
        for (key, attribute) in [("role", "AXRole"), ("title", "AXTitle"), ("description", "AXDescription"), ("value", "AXValue")] {
            if let Some(value) = text(element, attribute).filter(|value| !value.is_empty()) {
                node.insert(key.into(), Value::from(value));
            }
        }
        if depth > 0 {
            let mut children = Vec::new();
            elements(element, "AXChildren", 120, &mut |child| children.push(self::node(child, depth - 1)));
            if !children.is_empty() {
                node.insert("children".into(), Value::Array(children));
            }
        }
        Value::Object(node)
    }

    fn whatsapp_pid() -> Option<u32> {
        let mut system = sysinfo::System::new().ok()?;
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let mut candidates: Vec<u32> = system
            .processes()
            .iter()
            .filter(|(_, process)| {
                let name = process.name().to_string_lossy().to_lowercase();
                // The app's own executable (`WhatsApp.app/Contents/MacOS/WhatsApp`),
                // not its helpers.
                let bundled = process.exe().is_some_and(|exe| {
                    let parent = exe.parent();
                    let app = parent.and_then(|dir| dir.parent()).and_then(|contents| contents.parent());
                    parent.is_some_and(|dir| dir.ends_with("Contents/MacOS"))
                        && app.and_then(|app| app.file_name()).is_some_and(|app| {
                            let app = app.to_string_lossy().to_lowercase();
                            app.ends_with(".app") && app.contains("whatsapp")
                        })
                });
                name == "whatsapp" || bundled
            })
            .map(|(pid, _)| pid.as_u32())
            .collect();
        candidates.sort_unstable();
        candidates.first().copied()
    }

    pub fn snapshot() -> Value {
        // SAFETY: no preconditions.
        if unsafe { AXIsProcessTrusted() } == 0 {
            return json!({ "ok": false, "reason": "accessibility_not_allowed" });
        }
        let Some(pid) = whatsapp_pid() else {
            return json!({ "ok": false, "reason": "whatsapp_not_running" });
        };
        let Ok(raw_pid) = i32::try_from(pid) else {
            return json!({ "ok": false, "reason": "whatsapp_not_running" });
        };
        // SAFETY: returns a +1 AXUIElement for the process.
        let application = Owned(unsafe { AXUIElementCreateApplication(raw_pid) });
        let mut windows = Vec::new();
        if !application.0.is_null() {
            elements(application.0, "AXWindows", 1, &mut |window| windows.push(node(window, 9)));
        }
        json!({ "ok": true, "pid": pid, "windows": windows })
    }
}
