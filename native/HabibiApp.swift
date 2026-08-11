import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Contacts
import EventKit
import WebKit

private let launcherShortcutID: UInt32 = 0x48414249 // "HABI"
private var applicationDelegate: HabibiAppDelegate?

private func hotKeyHandler(_: EventHandlerCallRef?, _: EventRef?, _: UnsafeMutableRawPointer?) -> OSStatus {
  DispatchQueue.main.async { applicationDelegate?.toggleLauncher() }
  return noErr
}

final class LauncherPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class LauncherWebView: WKWebView {
  private func shouldHandleNativeImagePaste(_ event: NSEvent) -> Bool {
    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    return modifiers.contains(.command)
      && !modifiers.contains(.option)
      && !modifiers.contains(.control)
      && event.charactersIgnoringModifiers?.lowercased() == "v"
      && hasPasteboardImage
  }

  private var hasPasteboardImage: Bool {
    let pasteboard = NSPasteboard.general
    let containsImageType = (pasteboard.types ?? []).contains { type in
      let value = type.rawValue.lowercased()
      return value.contains("image") || value.contains("png") || value.contains("jpeg") || value.contains("tiff")
    }
    return containsImageType
      || pasteboard.data(forType: .png) != nil
      || pasteboard.data(forType: NSPasteboard.PasteboardType("public.png")) != nil
      || NSImage(pasteboard: pasteboard) != nil
  }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    // WebKit can beep before dispatching a paste event for a native macOS
    // screenshot. Consume only image paste here; normal text Cmd-V still uses
    // WebKit's normal editing path.
    if shouldHandleNativeImagePaste(event) {
      evaluateJavaScript("window.__habibiNativePasteImage?.()")
      return true
    }
    return super.performKeyEquivalent(with: event)
  }

  override func keyDown(with event: NSEvent) {
    // Some WKWebView editing surfaces bypass performKeyEquivalent. Catch the
    // same image-only chord here as a second route, so a paste never beeps or
    // disappears before the native bridge has a chance to attach it.
    if shouldHandleNativeImagePaste(event) {
      evaluateJavaScript("window.__habibiNativePasteImage?.()")
      return
    }
    super.keyDown(with: event)
  }

}

final class PanelDragZone: NSView {
  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }
}

final class HabibiAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
  private var panel: LauncherPanel!
  private var webView: WKWebView!
  private var statusItem: NSStatusItem!
  private var server: Process?
  private var serviceLogURL: URL?
  // EventKit permissions and cached calendar sources are tied to the event
  // store lifetime. Keep one store for the whole app instead of requesting on
  // one temporary instance and reading from a different one immediately after.
  private let eventStore = EKEventStore()
  private let contactStore = CNContactStore()
  private var openwaProcess: Process?
  private var openwaLogURL: URL?
  private var whatsappComponentDownload: URLSessionDownloadTask?
  private var whatsappComponentProgressObservation: NSKeyValueObservation?
  private var whatsappComponentLastProgress = -1
  private var hotKey: EventHotKeyRef?
  private var announcedShortcutFailure = false
  private var connectionTimer: Timer?
  private var localPasteMonitor: Any?
  private var topDragZone: PanelDragZone?

  private struct LauncherShortcut: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
  }

  private func launcherShortcut() -> LauncherShortcut {
    if UserDefaults.standard.object(forKey: "launcherShortcutKeyCode") != nil {
      return LauncherShortcut(keyCode: UInt32(UserDefaults.standard.integer(forKey: "launcherShortcutKeyCode")), modifiers: UInt32(UserDefaults.standard.integer(forKey: "launcherShortcutModifiers")))
    }
    // Migrate the two original friendly choices without making existing users
    // reconfigure their launcher.
    let legacy = UserDefaults.standard.string(forKey: "launcherShortcut") ?? "optionSpace"
    return LauncherShortcut(keyCode: UInt32(kVK_Space), modifiers: legacy == "controlSpace" ? UInt32(controlKey) : UInt32(optionKey))
  }

  private func shortcutLabel(_ shortcut: LauncherShortcut) -> String {
    if let stored = UserDefaults.standard.string(forKey: "launcherShortcutLabel"), !stored.isEmpty { return stored }
    var value = ""
    if shortcut.modifiers & UInt32(cmdKey) != 0 { value += "⌘ " }
    if shortcut.modifiers & UInt32(optionKey) != 0 { value += "⌥ " }
    if shortcut.modifiers & UInt32(controlKey) != 0 { value += "⌃ " }
    if shortcut.modifiers & UInt32(shiftKey) != 0 { value += "⇧ " }
    let keyNames: [UInt32: String] = [UInt32(kVK_Space):"Space", UInt32(kVK_Return):"Enter", UInt32(kVK_Tab):"Tab", UInt32(kVK_Escape):"Esc"]
    return value + (keyNames[shortcut.keyCode] ?? "Shortcut")
  }

  func applicationDidFinishLaunching(_: Notification) {
    NSApp.setActivationPolicy(.accessory)
    installStandardEditMenu()
    buildStatusItem()
    buildLauncher()
    registerLauncherShortcut()
    ensureLocalService()
    presentFirstRunIfNeeded()
  }

  /// Habibi is an LSUIElement agent: no dock icon, no window until its shortcut
  /// is pressed. If another launcher already owns that combination — Alfred and
  /// Raycast both default to ⌥ Space — the first launch is indistinguishable
  /// from an app that failed to start. RegisterEventHotKey still reports success
  /// in that case, so the conflict cannot be detected; open the panel once
  /// instead, which also shows where the shortcut lives.
  private func presentFirstRunIfNeeded() {
    let seenKey = "hasCompletedFirstRun"
    guard !UserDefaults.standard.bool(forKey: seenKey) else { return }
    UserDefaults.standard.set(true, forKey: seenKey)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self, !self.panel.isVisible else { return }
      self.toggleLauncher()
    }
  }

  func applicationWillTerminate(_: Notification) {
    connectionTimer?.invalidate()
    if let localPasteMonitor { NSEvent.removeMonitor(localPasteMonitor) }
    if let server, server.isRunning { server.terminate() }
    if let openwaProcess, openwaProcess.isRunning { openwaProcess.terminate() }
    if let hotKey { UnregisterEventHotKey(hotKey) }
  }

  private func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let logoURL = Bundle.main.resourceURL?.appendingPathComponent("service/assets/logo.png")
    if let logoURL, let logo = NSImage(contentsOf: logoURL) {
      logo.size = NSSize(width: 18, height: 18)
      logo.isTemplate = false
      statusItem.button?.image = logo
    } else {
      statusItem.button?.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Habibi")
    }
    let label = shortcutLabel(launcherShortcut())
    statusItem.button?.toolTip = "Habibi — \(label)"
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Habibi", action: #selector(toggleLauncher), keyEquivalent: "")
    menu.addItem(withTitle: "Preferences…", action: #selector(openPreferences), keyEquivalent: ",")
    // Naming the shortcut here is the recovery path when another app has claimed
    // it: macOS reports the registration as successful either way.
    let hint = NSMenuItem(title: "Shortcut: \(label)", action: nil, keyEquivalent: "")
    hint.isEnabled = false
    menu.addItem(hint)
    menu.addItem(NSMenuItem.separator())
    menu.addItem(withTitle: "Quit Habibi", action: #selector(quit), keyEquivalent: "q")
    statusItem.menu = menu
  }

  private func installStandardEditMenu() {
    // NSPanel/WKWebView still relies on the AppKit responder chain for the
    // normal Command-V command. Without this standard targetless item, macOS
    // plays the rejected-shortcut sound before WebKit sees a text paste.
    let mainMenu = NSMenu()
    let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let editMenu = NSMenu(title: "Edit")
    let commands: [(String, Selector, String)] = [
      ("Cut", #selector(NSText.cut(_:)), "x"),
      ("Copy", #selector(NSText.copy(_:)), "c"),
      ("Paste", #selector(NSText.paste(_:)), "v"),
      ("Select All", #selector(NSText.selectAll(_:)), "a")
    ]
    for (title, action, shortcut) in commands {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: shortcut)
      item.keyEquivalentModifierMask = [.command]
      item.target = nil
      editMenu.addItem(item)
    }
    editItem.submenu = editMenu
    mainMenu.addItem(editItem)
    NSApp.mainMenu = mainMenu
  }

  private func buildLauncher() {
    let rect = NSRect(x: 0, y: 0, width: 820, height: 640)
    panel = LauncherPanel(contentRect: rect,
                          styleMask: [.titled, .fullSizeContentView, .utilityWindow],
                          backing: .buffered,
                          defer: false)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isMovableByWindowBackground = false
    // Behave like a launcher: moving focus to another app or clicking away
    // dismisses the panel. Escape/global shortcut use the same reset path.
    panel.hidesOnDeactivate = true
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    restorePanelPosition()
    panel.delegate = self

    let configuration = WKWebViewConfiguration()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.websiteDataStore = .default()
    configuration.userContentController.add(self, name: "habibiNative")
    webView = LauncherWebView(frame: rect, configuration: configuration)
    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    // Without this, Safari's Develop menu never lists Habibi at all — there is
    // no other way to see a real JS error, since every client-side catch in
    // this codebase intentionally swallows its error rather than surfacing
    // internals to the UI. Gated on an env var (not a compile-time flag: every
    // build, local or release, goes through the same `swiftc -O` invocation
    // today, so #if DEBUG would silently never fire) so it must be
    // deliberately opted into per-launch, never on by default for a released
    // build a real user is running.
    if #available(macOS 13.3, *), ProcessInfo.processInfo.environment["HABIBI_INSPECTABLE"] == "1" {
      webView.isInspectable = true
    }
    let container = NSView(frame: rect)
    let material = NSVisualEffectView(frame: rect)
    material.material = .hudWindow
    material.blendingMode = .behindWindow
    material.state = .active
    material.autoresizingMask = [.width, .height]
    webView.autoresizingMask = [.width, .height]
    container.addSubview(material)
    container.addSubview(webView)
    // Dragging is handled by two native overlay zones, not by WKWebView. This
    // means every pixel from the search row through the results remains a
    // normal selectable/clickable web surface.
    let topDragZone = PanelDragZone(frame: NSRect(x: 0, y: rect.height - 61, width: rect.width - 48, height: 61))
    topDragZone.autoresizingMask = [.width, .minYMargin]
    let bottomDragZone = PanelDragZone(frame: NSRect(x: 0, y: 0, width: rect.width, height: 53))
    bottomDragZone.autoresizingMask = [.width, .maxYMargin]
    container.addSubview(topDragZone)
    container.addSubview(bottomDragZone)
    self.topDragZone = topDragZone
    panel.contentView = container
    installNativePasteMonitor()
  }

  private func pasteboardContainsImage() -> Bool {
    let pasteboard = NSPasteboard.general
    let imageTypes: Set<NSPasteboard.PasteboardType> = [
      .png,
      .tiff,
      NSPasteboard.PasteboardType("public.png"),
      NSPasteboard.PasteboardType("public.jpeg"),
      NSPasteboard.PasteboardType("public.heic")
    ]
    return pasteboard.types?.contains(where: { type in
      imageTypes.contains(type) || type.rawValue.lowercased().contains("image")
    }) == true || NSImage(pasteboard: pasteboard) != nil
  }

  private func installNativePasteMonitor() {
    // Capture ⌘V before WKWebView sees it. WKWebView can consume an image
    // paste—and play the failure sound—without emitting a DOM paste event.
    // A local monitor sits above that responder chain and is deterministic.
    localPasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self,
            self.panel.isKeyWindow,
            event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command),
            !event.modifierFlags.contains(.option),
            !event.modifierFlags.contains(.control),
            event.keyCode == 9,
            self.pasteboardContainsImage() else { return event }
      NSLog("[Habibi Paste] native command-V captured")
      self.webView.evaluateJavaScript("window.__habibiBeginNativeClipboardImage?.()")
      self.sendClipboardImage()
      return nil
    }
  }

  private func registerLauncherShortcut() {
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetEventDispatcherTarget(), hotKeyHandler, 1, &eventType, nil, nil)
    if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
    let id = EventHotKeyID(signature: launcherShortcutID, id: 1)
    let shortcut = launcherShortcut()
    let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, id, GetEventDispatcherTarget(), 0, &hotKey)
    // Another app may already own this combination — Alfred and Raycast both
    // commonly claim ⌥ Space. RegisterEventHotKey fails quietly, which used to
    // leave the launcher with no way in and no explanation, so say so and point
    // at the menu bar item that still works.
    guard status == noErr else {
      hotKey = nil
      let label = shortcutLabel(shortcut)
      statusItem.button?.toolTip = "Habibi — \(label) is unavailable; click to open"
      NSLog("[Habibi] could not register \(label): another app owns it (status \(status))")
      presentShortcutUnavailable(label)
      return
    }
    statusItem.button?.toolTip = "Habibi — \(shortcutLabel(shortcut))"
  }

  /// Shown once per launch: a background agent with no working hotkey is
  /// otherwise indistinguishable from an app that failed to start. Deferred off
  /// the launch path so the modal cannot delay the local service starting.
  private func presentShortcutUnavailable(_ label: String) {
    guard !announcedShortcutFailure else { return }
    announcedShortcutFailure = true
    DispatchQueue.main.async { [weak self] in
      let alert = NSAlert()
      alert.messageText = "\(label) is already used by another app"
      alert.informativeText = "Habibi is running in your menu bar. Open it from the Habibi menu bar icon, then pick a different shortcut in Settings."
      alert.addButton(withTitle: "Open Habibi")
      alert.addButton(withTitle: "Later")
      if alert.runModal() == .alertFirstButtonReturn { self?.toggleLauncher() }
    }
  }

  private func shortcutAvailability(_ shortcut: LauncherShortcut) -> (Bool, String) {
    guard shortcut.modifiers != 0 else { return (false, "Add ⌘, ⌥, or ⌃ to the shortcut.") }
    if shortcut.keyCode == UInt32(kVK_Tab) && shortcut.modifiers & UInt32(cmdKey) != 0 { return (false, "Command-Tab belongs to macOS app switching.") }
    if shortcut == launcherShortcut() { return (true, "Already your Habibi shortcut.") }
    var test: EventHotKeyRef?
    let id = EventHotKeyID(signature: launcherShortcutID, id: 2)
    let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, id, GetEventDispatcherTarget(), 0, &test)
    if let test { UnregisterEventHotKey(test) }
    return status == noErr ? (true, "Available on this Mac.") : (false, "Already claimed by another shortcut.")
  }

  private func sendShortcutResult(_ result: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: result), let json = String(data: data, encoding: .utf8) else { return }
    webView.evaluateJavaScript("window.__habibiShortcutValidation?.(\(json))")
  }

  private func sendClipboardImage() {
    // WKWebView does not consistently expose macOS screenshot bytes through
    // DataTransfer or navigator.clipboard. Read the system pasteboard natively
    // and return a PNG data URL only to this local WebView.
    // PNG conversion sometimes takes several seconds. Do it outside the UI
    // responder loop; otherwise WebKit times out its own paste event before
    // the attachment can be delivered.
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let pasteboard = NSPasteboard.general
      let scriptPNG = self?.clipboardPNGUsingAppleScript()
      let directPNG = pasteboard.data(forType: .png) ?? pasteboard.data(forType: NSPasteboard.PasteboardType("public.png"))
      let renderedPNG: Data? = {
          guard let image = NSImage(pasteboard: pasteboard),
                let tiff = image.tiffRepresentation,
                let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
          return bitmap.representation(using: .png, properties: [:])
        }()
      let filePNG = self?.clipboardImageFileUsingAppleScript()
      let png = scriptPNG ?? directPNG ?? renderedPNG ?? filePNG
      let source = scriptPNG != nil ? "pngf" : directPNG != nil ? "pasteboard" : renderedPNG != nil ? "nsimage" : filePNG != nil ? "file-url" : "none"
      NSLog("[Habibi Paste] native extraction source=\(source) bytes=\(png?.count ?? 0)")
      let payload: [String: Any] = png.map { ["ok": true, "dataUrl": "data:image/png;base64,\($0.base64EncodedString())"] } ?? ["ok": false]
      let json = (try? JSONSerialization.data(withJSONObject: payload)).flatMap { String(data: $0, encoding: .utf8) } ?? "{ok:false}"
      DispatchQueue.main.async {
        NSLog("[Habibi Paste] delivering image to WebView source=\(source)")
        self?.webView.evaluateJavaScript("window.__habibiReceiveNativeClipboardImage?.(\(json))")
      }
    }
  }

  private func lockScreen() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
      webView.evaluateJavaScript("window.__habibiNativeLockResult?.({ok:false, permission:true})")
      return
    }
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_Q), keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_Q), keyDown: false)
    down?.flags = [.maskCommand, .maskControl]
    up?.flags = [.maskCommand, .maskControl]
    down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
    webView.evaluateJavaScript("window.__habibiNativeLockResult?.({ok:true})")
  }

  private func requestCalendarAccess() {
    // Ask through EventKit, not AppleScript. This is the macOS Calendar
    // privacy permission users expect and grants access without opening
    // Calendar itself.
    let complete: (Bool, Error?) -> Void = { [weak self] granted, error in
      guard let self else { return }
      // EventKit can invoke this completion before authorizationStatus has
      // propagated to a newly created client. The retained store plus a short
      // main-runloop hop makes the result match what the next read will see.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        let status = EKEventStore.authorizationStatus(for: .event)
        let canRead: Bool
        // Some macOS releases retain the legacy `.authorized` value after a
        // full grant. Both values mean Habibi can read events.
        if #available(macOS 14.0, *) { canRead = status == .fullAccess || status == .authorized }
        else { canRead = status == .authorized }
        let reason = status == .notDetermined ? "notDetermined" : status == .denied || status == .restricted ? "denied" : "writeOnly"
        let payload: [String: Any] = [
          "ok": canRead,
          "reason": reason,
          "message": error?.localizedDescription ?? (canRead ? "" : (granted ? "Habibi needs Full Access to read upcoming events." : "Calendar access was not granted."))
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        self.webView.evaluateJavaScript("window.__habibiNativeCalendarAccess?.(\(json))")
      }
    }
    if #available(macOS 14.0, *) {
      eventStore.requestFullAccessToEvents(completion: complete)
    } else {
      eventStore.requestAccess(to: .event, completion: complete)
    }
  }

  private func sendLocalContacts() {
    let status = CNContactStore.authorizationStatus(for: .contacts)
    let send: () -> Void = { [weak self] in
      guard let self else { return }
      let current = CNContactStore.authorizationStatus(for: .contacts)
      guard current == .authorized else {
        let reason = current == .notDetermined ? "notDetermined" : "denied"
        self.webView.evaluateJavaScript("window.__habibiNativeContacts?.({ok:false, contacts:[], reason:'" + reason + "'})")
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        let keys: [CNKeyDescriptor] = [CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor, CNContactNicknameKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor]
        let request = CNContactFetchRequest(keysToFetch: keys)
        var contacts: [[String: String]] = []
        do {
          try self.contactStore.enumerateContacts(with: request) { contact, _ in
            let name = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            let label = !name.isEmpty ? name : contact.nickname
            guard !label.isEmpty else { return }
            for phone in contact.phoneNumbers {
              let digits = phone.value.stringValue.filter { $0.isNumber }
              if digits.count >= 7 { contacts.append(["phone": digits, "name": label]) }
            }
          }
        } catch { }
        guard let data = try? JSONSerialization.data(withJSONObject: ["ok": true, "contacts": contacts]),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.webView.evaluateJavaScript("window.__habibiNativeContacts?.(" + json + ")") }
      }
    }
    if status == .notDetermined {
      contactStore.requestAccess(for: .contacts) { _, _ in send() }
    } else {
      send()
    }
  }

  private func sendCalendarEvents() {
    let status = EKEventStore.authorizationStatus(for: .event)
    let canRead: Bool
    if #available(macOS 14.0, *) {
      // See requestCalendarAccess: EventKit can report a legacy authorized
      // value for an otherwise full calendar grant.
      canRead = status == .fullAccess || status == .authorized
    } else {
      canRead = status == .authorized
    }
    // Distinguish "no events" from "cannot read events". A write-only grant lets
    // Habibi create events but never list them, so reporting an empty agenda
    // here made a permission problem look like a free afternoon.
    guard canRead else {
      let reason = status == .notDetermined ? "notDetermined" : status == .denied || status == .restricted ? "denied" : "writeOnly"
      webView.evaluateJavaScript("window.__habibiNativeCalendarEvents?.({ok:false, events:[], reason:'\(reason)'})")
      return
    }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let now = Date()
      let end = Calendar.current.date(byAdding: .day, value: 14, to: now) ?? now
      let formatter = ISO8601DateFormatter()
      let predicate = self.eventStore.predicateForEvents(withStart: now, end: end, calendars: nil)
      let events: [[String: String]] = self.eventStore.events(matching: predicate)
        .sorted { $0.startDate < $1.startDate }
        .prefix(30)
        .map { event in
          [
            "id": event.eventIdentifier,
            "title": event.title ?? "Untitled event",
            "start": formatter.string(from: event.startDate),
            "end": formatter.string(from: event.endDate),
            "calendar": event.calendar.title
          ]
        }
      let payload: [String: Any] = ["ok": true, "events": events]
      guard let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async {
        self.webView.evaluateJavaScript("window.__habibiNativeCalendarEvents?.(\(json))")
      }
    }
  }

  private func clipboardPNGUsingAppleScript() -> Data? {
    // Some macOS apps place a screenshot on the pasteboard in a representation
    // WebKit and NSImage do not advertise. This is the same PNGf coercion used
    // by native developer tools: ask the pasteboard service for a real PNG,
    // then keep the temporary file entirely local to this process.
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("habibi-paste-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: output) }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    // Keep this byte-for-byte equivalent to the working Code implementation.
    task.arguments = [
      "-e", "set d to the clipboard as «class PNGf»",
      "-e", "set f to open for access POSIX file \"\(output.path)\" with write permission",
      "-e", "write d to f",
      "-e", "close access f"
    ]
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    do {
      try task.run()
      task.waitUntilExit()
      guard task.terminationStatus == 0 else { return nil }
      let data = try Data(contentsOf: output)
      return data.isEmpty ? nil : data
    } catch { return nil }
  }

  private func clipboardImageFileUsingAppleScript() -> Data? {
    let output = Pipe()
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = ["-e", "POSIX path of (the clipboard as «class furl»)"]
    task.standardOutput = output
    task.standardError = FileHandle.nullDevice
    do {
      try task.run()
      task.waitUntilExit()
      guard task.terminationStatus == 0,
            let path = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
              .trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
      let url = URL(fileURLWithPath: path)
      let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "tiff", "heic"]
      guard imageExtensions.contains(url.pathExtension.lowercased()) else { return nil }
      return try Data(contentsOf: url)
    } catch { return nil }
  }

  private func saveLauncherShortcut(_ shortcut: LauncherShortcut, label: String) {
    let checked = shortcutAvailability(shortcut)
    guard checked.0 else { sendShortcutResult(["available":false, "message":checked.1]); return }
    let previous = launcherShortcut()
    if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
    let id = EventHotKeyID(signature: launcherShortcutID, id: 1)
    let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, id, GetEventDispatcherTarget(), 0, &hotKey)
    guard status == noErr else {
      RegisterEventHotKey(previous.keyCode, previous.modifiers, id, GetEventDispatcherTarget(), 0, &hotKey)
      sendShortcutResult(["available":false, "message":"macOS could not claim that shortcut."])
      return
    }
    UserDefaults.standard.set(Int(shortcut.keyCode), forKey: "launcherShortcutKeyCode")
    UserDefaults.standard.set(Int(shortcut.modifiers), forKey: "launcherShortcutModifiers")
    UserDefaults.standard.set(label, forKey: "launcherShortcutLabel")
    statusItem.button?.toolTip = "Habibi — \(label)"
    sendShortcutResult(["available":true, "saved":true, "message":"Saved — Habibi will use this globally."])
  }

  @objc func toggleLauncher() {
    if panel.isVisible {
      hideLauncherAndReset()
      return
    }
    positionPanelForCurrentDisplay()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    focusCommandField()
  }

  @objc private func openPreferences() {
    if !panel.isVisible { toggleLauncher() }
    // Wait until the persistent WebKit view is frontmost before asking its
    // client-side router to render Preferences.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
      self?.webView.evaluateJavaScript("window.__habibiOpenPreferences?.()")
    }
  }

  @objc private func quit() { NSApp.terminate(nil) }

  private func hideLauncherAndReset() {
    // Keep the panel and local service warm for instant reopening, but clear
    // its transient route/search state before it leaves the screen.
    webView.evaluateJavaScript("window.__habibiResetLauncher?.()") { [weak self] _, _ in
      self?.panel.orderOut(nil)
    }
  }

  private func focusCommandField() {
    webView.evaluateJavaScript("document.getElementById('command-input')?.focus()")
  }

  private func serviceRoot() -> URL? {
    if let configured = Bundle.main.object(forInfoDictionaryKey: "HabibiServiceRoot") as? String, !configured.isEmpty {
      return URL(fileURLWithPath: configured, isDirectory: true)
    }
    return Bundle.main.resourceURL?.appendingPathComponent("service", isDirectory: true)
  }

  private func ensureLocalService() {
    pollService(remainingAttempts: 2) { [weak self] available in
      guard let self else { return }
      if !available { self.startLocalService() }
      self.pollUntilAvailable()
    }
  }

  private func startLocalService() {
    guard let root = serviceRoot(), FileManager.default.fileExists(atPath: root.appendingPathComponent("dist/server.js").path) else {
      presentServiceError("Habibi’s local service was not bundled correctly.")
      return
    }
    let bundledNode = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path
    let nodeCandidates = [bundledNode, "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    let node = nodeCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    let process = Process()
    if let node {
      process.executableURL = URL(fileURLWithPath: node)
      process.arguments = ["dist/server.js"]
    } else {
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["node", "dist/server.js"]
    }
    process.currentDirectoryURL = root
    let stateRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Habibi", isDirectory: true)
    try? FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
    process.environment = ProcessInfo.processInfo.environment.merging(["HABIBI_ROOT": root.path, "HABIBI_DATA_ROOT": stateRoot.path, "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"], uniquingKeysWith: { _, new in new })
    // Discarding the service's output made startup failures invisible — a port
    // conflict looked identical to a launcher that simply never opened. Keep a
    // small log beside the app's own state so the reason is recoverable.
    let logURL = stateRoot.appendingPathComponent("service.log")
    try? FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    if let log = try? FileHandle(forWritingTo: logURL) {
      log.truncateFile(atOffset: 0)
      process.standardOutput = log
      process.standardError = log
    } else {
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
    }
    serviceLogURL = logURL
    do { try process.run(); server = process }
    catch { presentServiceError("Habibi could not start its local service. Install Node.js, then reopen Habibi.") }
  }

  /// The tail of the service log, used to explain a startup failure in place of
  /// a generic "did not become ready" message.
  private func serviceFailureDetail() -> String {
    guard let serviceLogURL, let contents = try? String(contentsOf: serviceLogURL, encoding: .utf8) else { return "" }
    let lines = contents.split(separator: "\n").filter { !$0.isEmpty }
    guard let last = lines.last(where: { $0.contains("[Habibi]") }) ?? lines.last else { return "" }
    return String(last)
  }

  private func pollUntilAvailable() {
    connectionTimer?.invalidate()
    var attempts = 0
    connectionTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
      attempts += 1
      self?.pollService(remainingAttempts: 1) { available in
        if available {
          timer.invalidate()
          self?.loadLauncher()
        } else if attempts >= 40 {
          timer.invalidate()
          let detail = self?.serviceFailureDetail() ?? ""
          self?.presentServiceError(detail.isEmpty
            ? "Habibi’s local service did not become ready."
            : "Habibi’s local service did not become ready.\n\n\(detail)")
        }
      }
    }
  }

  private func pollService(remainingAttempts: Int, completion: @escaping (Bool) -> Void) {
    guard let url = URL(string: "http://127.0.0.1:4173/") else { completion(false); return }
    URLSession.shared.dataTask(with: url) { _, response, _ in
      DispatchQueue.main.async { completion((response as? HTTPURLResponse)?.statusCode == 200) }
    }.resume()
  }

  // Development builds may still bundle OpenWA directly. Releases keep it in a
  // separately signed/notarized, architecture-specific component under
  // Application Support so the universal app download does not carry Chromium.
  private let whatsappComponentName = "Habibi WhatsApp Runtime.app"
  private let whatsappComponentIdentifier = "com.clidey.habibi.whatsapp-runtime"

  private func appVersion() -> String? {
    guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
          version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil else { return nil }
    return version
  }

  private func installedWhatsAppComponentURL() -> URL? {
    guard let version = appVersion() else { return nil }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Habibi/components/whatsapp", isDirectory: true)
      .appendingPathComponent(version, isDirectory: true)
      .appendingPathComponent(whatsappComponentName, isDirectory: true)
  }

  private func openwaServiceRoot() -> URL? {
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("openwa", isDirectory: true),
       FileManager.default.fileExists(atPath: bundled.appendingPathComponent("dist/main.js").path) {
      return bundled
    }
    guard let component = installedWhatsAppComponentURL() else { return nil }
    let root = component.appendingPathComponent("Contents/Resources/openwa", isDirectory: true)
    return FileManager.default.fileExists(atPath: root.appendingPathComponent("dist/main.js").path) ? root : nil
  }

  private func runSystem(_ executable: String, _ arguments: [String]) -> (Int32, String) {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = output
    do {
      try process.run()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    } catch { return (-1, error.localizedDescription) }
  }

  private func signatureValue(_ key: String, at url: URL) -> String? {
    let result = runSystem("/usr/bin/codesign", ["-d", "--verbose=4", url.path])
    guard result.0 == 0 else { return nil }
    return result.1.split(separator: "\n").first { $0.hasPrefix("\(key)=") }
      .map { String($0.dropFirst(key.count + 1)) }
  }

  private func verifyWhatsAppComponent(_ component: URL, requireGatekeeper: Bool) -> String? {
    guard let version = appVersion(),
          let info = Bundle(url: component),
          info.bundleIdentifier == whatsappComponentIdentifier,
          info.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version else {
      return "The WhatsApp component does not match this Habibi version."
    }
    let signature = runSystem("/usr/bin/codesign", ["--verify", "--deep", "--strict", component.path])
    guard signature.0 == 0 else { return "macOS rejected the WhatsApp component signature." }
    guard let appTeam = signatureValue("TeamIdentifier", at: Bundle.main.bundleURL), !appTeam.isEmpty,
          signatureValue("TeamIdentifier", at: component) == appTeam,
          signatureValue("Identifier", at: component) == whatsappComponentIdentifier else {
      return "The WhatsApp component was not signed by the same developer as Habibi."
    }
    if requireGatekeeper {
      let gatekeeper = runSystem("/usr/sbin/spctl", ["-a", "-t", "exec", "-vv", component.path])
      guard gatekeeper.0 == 0 else { return "macOS could not verify the notarized WhatsApp component." }
    }
    return nil
  }

  private func sendWhatsAppComponentStatus(_ state: String, ok: Bool? = nil, error: String? = nil, progress: Int? = nil) {
    var payload: [String: Any] = ["state": state]
    if let ok { payload["ok"] = ok }
    if let error { payload["error"] = error }
    if let progress { payload["progress"] = progress }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    DispatchQueue.main.async { [weak self] in
      self?.webView.evaluateJavaScript("window.__habibiWhatsAppComponent?.(\(json))")
    }
  }

  private func clearWhatsAppComponentDownload() {
    whatsappComponentProgressObservation?.invalidate()
    whatsappComponentProgressObservation = nil
    whatsappComponentDownload = nil
    whatsappComponentLastProgress = -1
  }

  private func prepareWhatsAppComponent() {
    // A bundled tree is retained strictly for local development and testing.
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("openwa", isDirectory: true),
       FileManager.default.fileExists(atPath: bundled.appendingPathComponent("dist/main.js").path) {
      startWhatsAppComponentAndNotify()
      return
    }
    guard whatsappComponentDownload == nil else {
      sendWhatsAppComponentStatus("downloading")
      return
    }
    if let installed = installedWhatsAppComponentURL(), FileManager.default.fileExists(atPath: installed.path) {
      sendWhatsAppComponentStatus("verifying")
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let self else { return }
        if let verificationError = self.verifyWhatsAppComponent(installed, requireGatekeeper: false) {
          let versionDirectory = installed.deletingLastPathComponent()
          let quarantine = versionDirectory.deletingLastPathComponent().appendingPathComponent(".invalid-\(UUID().uuidString)")
          do {
            try FileManager.default.moveItem(at: versionDirectory, to: quarantine)
            DispatchQueue.main.async { self.prepareWhatsAppComponent() }
          } catch {
            self.sendWhatsAppComponentStatus("failed", ok: false, error: verificationError)
          }
        } else {
          DispatchQueue.main.async { self.startWhatsAppComponentAndNotify() }
        }
      }
      return
    }
    guard let version = appVersion() else {
      sendWhatsAppComponentStatus("failed", ok: false, error: "This Habibi build has no valid release version.")
      return
    }
#if arch(arm64)
    let architecture = "arm64"
#else
    let architecture = "x64"
#endif
    let asset = "Habibi-WhatsApp-\(architecture)-\(version).zip"
    guard let url = URL(string: "https://github.com/clidey/habibi/releases/download/v\(version)/\(asset)") else { return }
    sendWhatsAppComponentStatus("downloading")
    let task = URLSession.shared.downloadTask(with: url) { [weak self] temporaryURL, _, downloadError in
      guard let self else { return }
      guard downloadError == nil, let temporaryURL else {
        DispatchQueue.main.async { self.clearWhatsAppComponentDownload() }
        self.sendWhatsAppComponentStatus("failed", ok: false, error: "Could not download the WhatsApp component.")
        return
      }
      let retained = FileManager.default.temporaryDirectory.appendingPathComponent("habibi-whatsapp-\(UUID().uuidString).zip")
      do { try FileManager.default.moveItem(at: temporaryURL, to: retained) }
      catch {
        DispatchQueue.main.async { self.clearWhatsAppComponentDownload() }
        self.sendWhatsAppComponentStatus("failed", ok: false, error: "Could not prepare the WhatsApp download.")
        return
      }
      self.sendWhatsAppComponentStatus("verifying")
      DispatchQueue.global(qos: .userInitiated).async {
        let result = self.installWhatsAppComponent(from: retained)
        try? FileManager.default.removeItem(at: retained)
        DispatchQueue.main.async {
          self.clearWhatsAppComponentDownload()
          switch result {
          case .success:
            self.startWhatsAppComponentAndNotify()
          case .failure(let failure):
            self.sendWhatsAppComponentStatus("failed", ok: false, error: failure.localizedDescription)
          }
        }
      }
    }
    whatsappComponentDownload = task
    whatsappComponentLastProgress = 0
    whatsappComponentProgressObservation = task.progress.observe(\.fractionCompleted, options: [.new]) { [weak self] progress, _ in
      let percentage = min(100, max(0, Int(progress.fractionCompleted * 100)))
      DispatchQueue.main.async {
        guard let self, percentage != self.whatsappComponentLastProgress else { return }
        self.whatsappComponentLastProgress = percentage
        self.sendWhatsAppComponentStatus("downloading", progress: percentage)
      }
    }
    task.resume()
  }

  private enum WhatsAppInstallFailure: LocalizedError {
    case message(String)
    var errorDescription: String? {
      if case .message(let message) = self { return message }
      return "Could not install the WhatsApp component."
    }
  }

  private func installWhatsAppComponent(from archive: URL) -> Result<URL, WhatsAppInstallFailure> {
    let attributes = try? FileManager.default.attributesOfItem(atPath: archive.path)
    let fileSize = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
    guard fileSize > 0, fileSize <= 1_073_741_824 else { return .failure(.message("The WhatsApp download had an unexpected size.")) }
    let listing = runSystem("/usr/bin/zipinfo", ["-1", archive.path])
    guard listing.0 == 0 else { return .failure(.message("The WhatsApp download was not a valid archive.")) }
    let expectedPrefix = whatsappComponentName + "/"
    let entries = listing.1.split(separator: "\n").map(String.init)
    guard !entries.isEmpty, entries.allSatisfy({ entry in
      let parts = entry.split(separator: "/", omittingEmptySubsequences: false)
      return (entry == whatsappComponentName || entry.hasPrefix(expectedPrefix))
        && !entry.hasPrefix("/") && !entry.contains("\\") && !parts.contains("..")
    }) else { return .failure(.message("The WhatsApp archive contained unexpected files.")) }

    let extraction = FileManager.default.temporaryDirectory.appendingPathComponent("habibi-whatsapp-install-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: extraction) }
    do { try FileManager.default.createDirectory(at: extraction, withIntermediateDirectories: true) }
    catch { return .failure(.message("Could not create a temporary install directory.")) }
    let unpack = runSystem("/usr/bin/ditto", ["-x", "-k", archive.path, extraction.path])
    guard unpack.0 == 0 else { return .failure(.message("Could not unpack the WhatsApp component.")) }
    let extracted = extraction.appendingPathComponent(whatsappComponentName, isDirectory: true)
    guard FileManager.default.fileExists(atPath: extracted.path) else { return .failure(.message("The WhatsApp component was missing from its archive.")) }
    if let error = verifyWhatsAppComponent(extracted, requireGatekeeper: true) { return .failure(.message(error)) }

    guard let finalComponent = installedWhatsAppComponentURL() else { return .failure(.message("Could not resolve the component install location.")) }
    let finalDirectory = finalComponent.deletingLastPathComponent()
    let parent = finalDirectory.deletingLastPathComponent()
    let staging = parent.appendingPathComponent(".install-\(UUID().uuidString)", isDirectory: true)
    var displaced: URL?
    do {
      try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
      try FileManager.default.moveItem(at: extracted, to: staging.appendingPathComponent(whatsappComponentName))
      if FileManager.default.fileExists(atPath: finalDirectory.path) {
        let backup = parent.appendingPathComponent(".replaced-\(UUID().uuidString)")
        try FileManager.default.moveItem(at: finalDirectory, to: backup)
        displaced = backup
      }
      try FileManager.default.moveItem(at: staging, to: finalDirectory)
      // Component versions are immutable release assets. Once the replacement
      // is safely installed, remove older caches so Chromium is not duplicated
      // on disk after every Habibi update.
      if let entries = try? FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil) {
        for entry in entries where entry != finalDirectory { try? FileManager.default.removeItem(at: entry) }
      }
      return .success(finalComponent)
    } catch {
      try? FileManager.default.removeItem(at: staging)
      if !FileManager.default.fileExists(atPath: finalDirectory.path), let displaced {
        try? FileManager.default.moveItem(at: displaced, to: finalDirectory)
      }
      return .failure(.message("Could not install the verified WhatsApp component."))
    }
  }

  private func startWhatsAppComponentAndNotify() {
    sendWhatsAppComponentStatus("starting")
    ensureOpenwaService()
    waitForOpenwaComponent(remainingAttempts: 80)
  }

  private func waitForOpenwaComponent(remainingAttempts: Int) {
    pollOpenwaService(remainingAttempts: 1) { [weak self] available in
      guard let self else { return }
      if available {
        self.sendWhatsAppComponentStatus("ready", ok: true)
      } else if remainingAttempts > 1 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForOpenwaComponent(remainingAttempts: remainingAttempts - 1) }
      } else {
        self.sendWhatsAppComponentStatus("failed", ok: false, error: "The WhatsApp service did not become ready.")
      }
    }
  }

  private func ensureOpenwaService() {
    pollOpenwaService(remainingAttempts: 2) { [weak self] available in
      guard let self else { return }
      if !available { self.startOpenwaService() }
      self.pollOpenwaUntilAvailable()
    }
  }

  /// Kill whatever is bound to OpenWA's port before spawning a fresh instance.
  ///
  /// A force-quit (Activity Monitor, `kill -9`, a crash) skips
  /// `applicationWillTerminate` entirely, so a previous run's `openwaProcess`
  /// is orphaned but still holds port 2785 — the exact scenario that produced
  /// a real `EADDRINUSE` failure after an app update in testing: the old
  /// process never exited, health checks against it raced and lost, and
  /// `startOpenwaService` then tried to bind a port that was still occupied.
  /// Reaching for `lsof` rather than tracking child PIDs across launches
  /// because the orphan is not our child by the time this runs — we have no
  /// handle to it at all, only its effect (the bound port). Restrict the query
  /// to LISTEN sockets: an unqualified port query also returns Habibi's own
  /// health-check connection and previously made the app SIGKILL itself here.
  private func killStaleOpenwaProcess() {
    let lsof = Process()
    lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    lsof.arguments = ["-t", "-iTCP:2785", "-sTCP:LISTEN"]
    let pipe = Pipe()
    lsof.standardOutput = pipe
    lsof.standardError = FileHandle.nullDevice
    do {
      try lsof.run()
      lsof.waitUntilExit()
      let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      for pidString in output.split(separator: "\n") {
        guard let pid = Int32(pidString), pid != ProcessInfo.processInfo.processIdentifier else { continue }
        kill(pid, SIGKILL)
      }
    } catch {
      // lsof missing or unreadable: nothing to clean up, and the subsequent
      // spawn attempt will surface the same EADDRINUSE if the port is truly
      // still held, which lands in openwa.log for diagnosis either way.
    }
  }

  private func startOpenwaService() {
    guard let root = openwaServiceRoot(), FileManager.default.fileExists(atPath: root.appendingPathComponent("dist/main.js").path) else {
      // Not fatal: WhatsApp is one feature among many, and older builds (or a
      // build that skipped Phase E's Chromium download) legitimately have no
      // bundled gateway. Silently skip rather than alarming every user.
      return
    }
    // Reaching this point means ensureOpenwaService's own health check just
    // failed, so nothing at this port answered as OUR service — but a stale,
    // orphaned instance can still be bound to it without answering (e.g. mid-
    // crash, or simply not yet listening). Free the port unconditionally
    // before spawning rather than letting a fresh EADDRINUSE happen silently.
    killStaleOpenwaProcess()
    let bundledNode = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path
    guard let supervisor = Bundle.main.resourceURL?.appendingPathComponent("openwa-supervisor.js"),
          FileManager.default.isExecutableFile(atPath: bundledNode),
          FileManager.default.fileExists(atPath: supervisor.path) else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: bundledNode)
    // dist/main.js must be an ABSOLUTE path: OpenWA's own bootstrap
    // (load-env.ts) resolves its config/API-key file at `path.resolve(cwd,
    // 'data', ...)` — a relative script path would tie that resolution to
    // whatever cwd happens to default to, but cwd is deliberately set below to
    // the WRITABLE state directory, not the read-only bundle main.js lives in.
    process.arguments = [supervisor.path, root.appendingPathComponent("dist/main.js").path]
    let stateRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Habibi", isDirectory: true)
    let openwaState = stateRoot.appendingPathComponent(".openwa", isDirectory: true)
    try? FileManager.default.createDirectory(at: openwaState, withIntermediateDirectories: true)
    // cwd = openwaState, NOT root (the app bundle). OpenWA writes data/.env.generated
    // and (absent BOOTSTRAP_KEY_FILE's own directory) data/.api-key relative to
    // cwd with no env-var override for that base path — pointing cwd at the
    // read-only bundle either fails outright or, worse, succeeds by writing
    // into Habibi.app itself, which breaks the moment the bundle is properly
    // read-only (confirmed: v0.2.0 shipped exactly this bug, with .env.generated
    // landing in /Applications/Habibi.app/Contents/Resources/openwa/data/ and
    // the API key never reaching disk at all — "ENOENT ... .openwa/data/.api-key").
    // This also happens to make BOOTSTRAP_KEY_FILE's own parent directory exist:
    // it resolves to openwaState/data/.api-key below, the SAME data/ OpenWA's
    // own bootstrap creates relative to this cwd.
    process.currentDirectoryURL = openwaState
    // Find the bundled Chrome-for-Testing .app by globbing rather than a fixed
    // name/symlink: a stable-named symlink here broke Puppeteer's own launch
    // once already, since Chromium resolves the Framework it dlopen's via a
    // relative `../Frameworks/...` walk from the executable path it's given —
    // that walk resolves against the SYMLINK's own directory, not the real
    // bundle's Contents/MacOS/, landing on a nonexistent path. Globbing for the
    // real .app and pointing straight at its real Contents/MacOS/ executable
    // sidesteps the whole class of bug: no indirection for the relative walk
    // to go wrong through.
    let chromeRoot = root.appendingPathComponent("chrome", isDirectory: true)
    let chromeAppName = try? FileManager.default.contentsOfDirectory(atPath: chromeRoot.path).first { $0.hasSuffix(".app") }
    // Read Contents/MacOS/'s own single entry rather than derive the
    // executable's name from the .app bundle's name — Chrome for Testing's
    // naming happens to match (confirmed against a real download), but
    // reading it directly needs no such assumption to hold across versions.
    let chromePath = chromeAppName.flatMap { appName -> String? in
      let macosDir = chromeRoot.appendingPathComponent(appName).appendingPathComponent("Contents/MacOS", isDirectory: true)
      guard let executableName = try? FileManager.default.contentsOfDirectory(atPath: macosDir.path).first else { return nil }
      return macosDir.appendingPathComponent(executableName).path
    } ?? ""
    var env = ProcessInfo.processInfo.environment.merging([
      "PORT": "2785",
      "BOOTSTRAP_KEY_FILE": openwaState.appendingPathComponent("data/.api-key").path,
      "SESSION_DATA_PATH": openwaState.appendingPathComponent("sessions").path,
      "DATABASE_NAME": openwaState.appendingPathComponent("openwa.sqlite").path,
      "MAIN_DATABASE_NAME": openwaState.appendingPathComponent("main.sqlite").path,
      "STORAGE_LOCAL_PATH": openwaState.appendingPathComponent("media").path,
      "HABIBI_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
      "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ], uniquingKeysWith: { _, new in new })
    if FileManager.default.isExecutableFile(atPath: chromePath) {
      env["PUPPETEER_EXECUTABLE_PATH"] = chromePath
    }
    process.environment = env
    let logURL = openwaState.appendingPathComponent("openwa.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    if let log = try? FileHandle(forWritingTo: logURL) {
      log.truncateFile(atOffset: 0)
      process.standardOutput = log
      process.standardError = log
    } else {
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
    }
    openwaLogURL = logURL
    // Best-effort: a failed launch here should never block the main service or
    // surface a modal, since WhatsApp is optional. serviceFailureDetail-style
    // diagnosis is available via the log for anyone who goes looking.
    try? process.run()
    openwaProcess = process
  }

  private func pollOpenwaUntilAvailable() {
    var attempts = 0
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
      attempts += 1
      self?.pollOpenwaService(remainingAttempts: 1) { available in
        if available || attempts >= 40 { timer.invalidate() }
      }
    }
  }

  private func pollOpenwaService(remainingAttempts: Int, completion: @escaping (Bool) -> Void) {
    guard let url = URL(string: "http://127.0.0.1:2785/infra/health") else { completion(false); return }
    URLSession.shared.dataTask(with: url) { _, response, _ in
      DispatchQueue.main.async { completion((response as? HTTPURLResponse)?.statusCode == 200) }
    }.resume()
  }

  private func loadLauncher() {
    guard let url = URL(string: "http://127.0.0.1:4173/") else { return }
    webView.load(URLRequest(url: url))
  }

  private func presentServiceError(_ message: String) {
    DispatchQueue.main.async {
      let alert = NSAlert()
      alert.messageText = "Habibi needs its local service"
      alert.informativeText = message
      alert.addButton(withTitle: "OK")
      alert.runModal()
    }
  }

  func webView(_: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
    if url.host == "127.0.0.1" || url.host == "localhost" || navigationAction.navigationType != .linkActivated {
      decisionHandler(.allow)
    } else {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
    let shortcut = launcherShortcut()
    let payload = ["keyCode":shortcut.keyCode, "modifiers":shortcut.modifiers, "label":shortcutLabel(shortcut)] as [String: Any]
    let data = try? JSONSerialization.data(withJSONObject: payload)
    let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    webView.evaluateJavaScript("document.body.classList.add('native-host'); window.__habibiNativeShortcut=\(json); document.body.dataset.nativeShortcutLabel=window.__habibiNativeShortcut.label || '⌥ Space'")
    focusCommandField()
  }

  func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "habibiNative" else { return }
    if String(describing: message.body) == "dismiss" { hideLauncherAndReset(); return }
    guard let settings = message.body as? [String: Any], let type = settings["type"] as? String else { return }
    if type == "clipboardImage" { sendClipboardImage(); return }
    if type == "lockScreen" { lockScreen(); return }
    if type == "calendarAccess" { requestCalendarAccess(); return }
    if type == "calendarEvents" { sendCalendarEvents(); return }
    if type == "contacts" { sendLocalContacts(); return }
    if type == "whatsappComponent" { prepareWhatsAppComponent(); return }
    if type == "dragZones" {
      topDragZone?.isHidden = settings["headerVisible"] as? Bool == false
      return
    }
    // Keep the old bridge message valid during upgrades from an already-open UI.
    if type == "settings", let shortcut = settings["shortcut"] as? String {
      UserDefaults.standard.set(shortcut, forKey: "launcherShortcut")
      UserDefaults.standard.removeObject(forKey: "launcherShortcutKeyCode")
      UserDefaults.standard.removeObject(forKey: "launcherShortcutModifiers")
      UserDefaults.standard.removeObject(forKey: "launcherShortcutLabel")
      registerLauncherShortcut()
      return
    }
    guard let keyCode = settings["keyCode"] as? Int, let modifiers = settings["modifiers"] as? Int else { return }
    let shortcut = LauncherShortcut(keyCode: UInt32(keyCode), modifiers: UInt32(modifiers))
    if type == "shortcutCheck" {
      let result = shortcutAvailability(shortcut)
      sendShortcutResult(["available":result.0, "message":result.1])
    } else if type == "shortcutSave" { saveLauncherShortcut(shortcut, label: settings["label"] as? String ?? shortcutLabel(shortcut)) }
  }

  func windowDidMove(_: Notification) {
    guard panel?.isVisible == true else { return }
    UserDefaults.standard.set([panel.frame.origin.x, panel.frame.origin.y], forKey: "launcherOrigin")
    if let screen = panel.screen { UserDefaults.standard.set(screenIdentifier(screen), forKey: "launcherScreen") }
  }

  func windowDidResignKey(_: Notification) {
    // `hidesOnDeactivate` handles the visual dismissal when a user clicks
    // away; reset the persistent web surface as well for the next invocation.
    guard panel?.isVisible == true else { return }
    hideLauncherAndReset()
  }

  private func restorePanelPosition() {
    guard let origin = UserDefaults.standard.array(forKey: "launcherOrigin") as? [CGFloat], origin.count == 2 else { panel.center(); return }
    let candidate = NSRect(origin: NSPoint(x: origin[0], y: origin[1]), size: panel.frame.size)
    guard NSScreen.screens.contains(where: { $0.visibleFrame.intersects(candidate) }) else { panel.center(); return }
    panel.setFrameOrigin(candidate.origin)
  }

  private func screenIdentifier(_ screen: NSScreen) -> String {
    if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
      return number.stringValue
    }
    return screen.localizedName
  }

  private func currentPointerScreen() -> NSScreen {
    let pointer = NSEvent.mouseLocation
    return NSScreen.screens.first(where: { $0.frame.contains(pointer) }) ?? NSScreen.main ?? NSScreen.screens[0]
  }

  private func positionPanelForCurrentDisplay() {
    let target = currentPointerScreen()
    let storedScreen = UserDefaults.standard.string(forKey: "launcherScreen")
    if storedScreen == screenIdentifier(target),
       let origin = UserDefaults.standard.array(forKey: "launcherOrigin") as? [CGFloat], origin.count == 2 {
      let candidate = NSRect(origin: NSPoint(x: origin[0], y: origin[1]), size: panel.frame.size)
      if target.visibleFrame.intersects(candidate) {
        panel.setFrameOrigin(candidate.origin)
        return
      }
    }
    let visible = target.visibleFrame
    panel.setFrameOrigin(NSPoint(
      x: visible.midX - panel.frame.width / 2,
      y: visible.midY - panel.frame.height / 2
    ))
  }
}

let app = NSApplication.shared
let delegate = HabibiAppDelegate()
applicationDelegate = delegate
app.delegate = delegate
app.run()
