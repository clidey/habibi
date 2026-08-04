import AppKit
import ApplicationServices
import Carbon.HIToolbox
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
  private var hotKey: EventHotKeyRef?
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
  }

  func applicationWillTerminate(_: Notification) {
    connectionTimer?.invalidate()
    if let localPasteMonitor { NSEvent.removeMonitor(localPasteMonitor) }
    if let server, server.isRunning { server.terminate() }
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
    statusItem.button?.toolTip = "Habibi — Option Space"
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Habibi", action: #selector(toggleLauncher), keyEquivalent: "")
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
    RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, id, GetEventDispatcherTarget(), 0, &hotKey)
  }

  private func shortcutAvailability(_ shortcut: LauncherShortcut) -> (Bool, String) {
    guard shortcut.modifiers != 0 else { return (false, "Add ⌘, ⌥, or ⌃ to the shortcut.") }
    if shortcut.keyCode == UInt32(kVK_Space) && shortcut.modifiers & UInt32(cmdKey) != 0 { return (false, "Command-Space belongs to Spotlight.") }
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
    let store = EKEventStore()
    let complete: (Bool, Error?) -> Void = { [weak self] granted, error in
      let payload: [String: Any] = [
        "ok": granted,
        "message": error?.localizedDescription ?? (granted ? "" : "Calendar access was not granted.")
      ]
      guard let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async {
        self?.webView.evaluateJavaScript("window.__habibiNativeCalendarAccess?.(\(json))")
      }
    }
    if #available(macOS 14.0, *) {
      store.requestFullAccessToEvents(completion: complete)
    } else {
      store.requestAccess(to: .event, completion: complete)
    }
  }

  private func sendCalendarEvents() {
    let store = EKEventStore()
    let status = EKEventStore.authorizationStatus(for: .event)
    let canRead: Bool
    if #available(macOS 14.0, *) {
      canRead = status == .fullAccess
    } else {
      canRead = status == .authorized
    }
    guard canRead else {
      webView.evaluateJavaScript("window.__habibiNativeCalendarEvents?.({ok:false, events:[]})")
      return
    }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let now = Date()
      let end = Calendar.current.date(byAdding: .day, value: 14, to: now) ?? now
      let formatter = ISO8601DateFormatter()
      let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
      let events: [[String: String]] = store.events(matching: predicate)
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
        self?.webView.evaluateJavaScript("window.__habibiNativeCalendarEvents?.(\(json))")
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
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do { try process.run(); server = process }
    catch { presentServiceError("Habibi could not start its local service. Install Node.js, then reopen Habibi.") }
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
          self?.presentServiceError("Habibi’s local service did not become ready.")
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
