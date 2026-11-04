import AppKit
import QuartzCore
import WebKit

private final class PrompterPanel: NSPanel {
  var toggleReading: (() -> Void)?
  var stopReading: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  private func consumeReadingKey(_ event: NSEvent) -> Bool {
    guard event.modifierFlags.intersection([.command, .option, .control]).isEmpty else { return false }
    if event.keyCode == 49 { if !event.isARepeat { toggleReading?() }; return true }
    if event.keyCode == 53 { stopReading?(); return true }
    return false
  }
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    consumeReadingKey(event) || super.performKeyEquivalent(with: event)
  }
  override func keyDown(with event: NSEvent) {
    if !consumeReadingKey(event) { super.keyDown(with: event) }
  }
}

/** A local, plain-text overlay. There is no timer until reading actually starts. */
final class TeleprompterController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  var onStateChange: (([String: Any]) -> Void)?
  private var panel: PrompterPanel?
  private var overlayPresented = false
  private var presentationGeneration = UUID()
  private let scroll = NSScrollView()
  private let text = NSTextView()
  private let statusLabel = NSTextField(labelWithString: "Paused")
  private var overlayWebView: WKWebView?
  private var overlayURL: URL?
  private var overlayReady = false
  private var lastOverlayScript: String?
  private var overlayError: String?
  private var playButton: NSButton?
  private var headerTop: NSLayoutConstraint?
  private var timer: Timer?
  private var observers: [NSObjectProtocol] = []
  private var lastTick = 0.0
  private var pixelsPerSecond = 20.0
  private var script = ""
  private var pace = 140.0
  private var fontSize = 24.0
  private var overlayWidth = 620.0
  private var mode = "voice"
  private let listener: TeleprompterListening
  private var tracker = TeleprompterWordTracker("")
  private var targetOffset: CGFloat = 0
  private var readingSeconds = 0.0
  private var readDuration = 0.0
  private var voiceGeneration = UUID()
  private(set) var state = "stopped"
  var hasActiveTimer: Bool { timer != nil }
  var overlayFrame: NSRect? { panel?.frame }
  var overlayView: NSView? { panel?.contentView }
  var scrollOffset: CGFloat { scroll.contentView.bounds.minY }
  var snapshot: [String: Any] { ["state": state, "visible": overlayPresented, "pace": pace, "fontSize": fontSize, "mode": mode] }
  var matchedWords: Int { tracker.nextWord }

  init(listener: TeleprompterListening = OnDeviceTeleprompterListener()) {
    self.listener = listener
    super.init()
    let center = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.pause() })
    }
    observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didHideNotification, object: nil, queue: .main) { [weak self] _ in self?.pause() })
    observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, self.overlayPresented else { return }
      self.pause()
      self.position()
      self.layoutScript()
    })
    observers.append(center.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.updateReadingFade()
    })
  }

  deinit {
    timer?.invalidate()
    listener.stop()
    overlayWebView?.configuration.userContentController.removeScriptMessageHandler(forName: "teleprompterOverlay")
    for observer in observers {
      NSWorkspace.shared.notificationCenter.removeObserver(observer)
      NotificationCenter.default.removeObserver(observer)
    }
  }

  @discardableResult func handle(_ settings: [String: Any]) -> Bool {
    let action = settings["action"] as? String ?? "state"
    if action == "start" {
      guard let value = settings["script"] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.utf16.count <= 100_000 else { return false }
      pause(notify: false)
      script = value
      overlayError = nil
      tracker = TeleprompterWordTracker(value)
      readingSeconds = 0
      targetOffset = 0
      configure(settings)
      buildPanelIfNeeded()
      position(preferPointer: true)
      layoutScript()
      scroll.contentView.scroll(to: .zero)
      presentOverlay()
      resume()
    } else if action == "pause" { pause() }
    else if action == "resume" { resume() }
    else if action == "stop" { stop() }
    else if action == "reset" {
      let reading = state == "running"
      pause(notify: false)
      tracker = TeleprompterWordTracker(script)
      readingSeconds = 0
      targetOffset = 0
      layoutScript()
      scroll.contentView.scroll(to: .zero)
      if reading { resume() } else { setState(overlayPresented ? "paused" : "stopped") }
    }
    else if action == "configure" {
      let reading = state == "running"
      let oldWidth = overlayWidth
      let oldFontSize = fontSize
      let maximum = max(1, text.frame.height - scroll.contentView.bounds.height)
      let fraction = scrollOffset / maximum
      pause(notify: false)
      configure(settings)
      if overlayPresented {
        if oldWidth != overlayWidth || oldFontSize != fontSize { position() }
        layoutScript()
        let offset = fraction * max(0, text.frame.height - scroll.contentView.bounds.height)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: offset))
      }
      if reading { resume() } else { onStateChange?(snapshot) }
    } else if action == "state" { onStateChange?(snapshot) }
    else { return false }
    return true
  }

  private func configure(_ settings: [String: Any]) {
    func bounded(_ key: String, _ fallback: Double, _ range: ClosedRange<Double>) -> Double {
      guard let value = settings[key] as? Double, value.isFinite else { return fallback }
      return min(range.upperBound, max(range.lowerBound, value))
    }
    pace = bounded("pace", pace, 60...260)
    fontSize = bounded("fontSize", fontSize, 16...40)
    overlayWidth = bounded("width", overlayWidth, 380...900)
    if let value = settings["mode"] as? String, ["voice", "automatic"].contains(value) { mode = value }
  }

  private func buildPanelIfNeeded() {
    guard panel == nil else { return }
    let window = PrompterPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.title = "Habibi Teleprompter"
    window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.hidesOnDeactivate = false
    window.isMovableByWindowBackground = false
    window.isReleasedWhenClosed = false
    window.toggleReading = { [weak self] in self?.toggle() }
    window.stopReading = { [weak self] in self?.stop() }
    let content = NSView()
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor.black.cgColor
    content.layer?.cornerRadius = 22
    content.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    content.layer?.masksToBounds = true
    window.contentView = content
    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = NSColor(white: 0.7, alpha: 1)
    let reset = button("backward.end.fill", "Restart script", #selector(restart))
    let play = button("pause.fill", "Pause or resume · Space", #selector(toggle))
    let close = button("xmark", "Close teleprompter · Esc", #selector(closeOverlay))
    playButton = play
    let header = NSStackView(views: [NSView(), statusLabel, reset, play, close])
    header.orientation = .horizontal
    header.spacing = 6
    header.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(header)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = false
    scroll.borderType = .noBorder
    text.isEditable = false
    text.isSelectable = false
    text.isRichText = false
    text.drawsBackground = false
    text.textColor = .white
    text.textContainerInset = NSSize(width: 12, height: 12)
    text.isVerticallyResizable = true
    text.isHorizontallyResizable = false
    text.autoresizingMask = [.width]
    text.textContainer?.widthTracksTextView = true
    scroll.documentView = text
    content.addSubview(scroll)
    let top = header.topAnchor.constraint(equalTo: content.topAnchor, constant: 6)
    headerTop = top
    NSLayoutConstraint.activate([
      header.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
      header.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
      top,
      header.heightAnchor.constraint(equalToConstant: 24),
      scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 0),
      scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 10),
      scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -10),
      scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
    ])
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(self, name: "teleprompterOverlay")
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    webView.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.topAnchor.constraint(equalTo: content.topAnchor),
      webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
    ])
    header.alphaValue = 0
    scroll.alphaValue = 0
    overlayWebView = webView
    let bundled = Bundle.main.resourceURL?.appendingPathComponent("service/assets/teleprompter-overlay.html")
    let local = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets/teleprompter-overlay.html")
    let page = (bundled.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil } ?? local).absoluteURL.standardizedFileURL
    overlayURL = page
    webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    panel = window
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "teleprompterOverlay", message.frameInfo.isMainFrame,
          Self.allowsOverlayPage(message.frameInfo.request.url, expected: overlayURL),
          let body = message.body as? [String: String], let action = body["action"] else { return }
    if action == "ready" { overlayReady = true; syncOverlay(); return }
    guard ["pause", "resume", "reset", "stop"].contains(action) else { return }
    _ = handle(["action": action])
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let allowed = Self.allowsOverlayPage(navigationAction.request.url, expected: overlayURL)
    decisionHandler(allowed ? .allow : .cancel)
  }

  /// Bundle resource URLs can retain a base URL while WebKit sends an absolute URL.
  /// Normalize both representations without allowing any other file or origin.
  static func allowsOverlayPage(_ candidate: URL?, expected: URL?) -> Bool {
    guard let candidate, let expected, candidate.isFileURL, expected.isFileURL else { return false }
    return candidate.absoluteURL.standardizedFileURL == expected.absoluteURL.standardizedFileURL
  }

  private func syncOverlay() {
    guard overlayReady, let webView = overlayWebView else { return }
    let maximum = max(1, text.frame.height - scroll.contentView.bounds.height)
    var payload: [String: Any] = [
      "state": state, "mode": mode, "pace": pace,
      "fontSize": fontSize, "inset": panel?.screen?.safeAreaInsets.top ?? 0,
      "progress": min(1, max(0, scrollOffset / maximum)), "read": tracker.readRange.length,
      "error": overlayError ?? "",
    ]
    if lastOverlayScript != script { payload["script"] = script; lastOverlayScript = script }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    webView.evaluateJavaScript("window.__habibiTeleprompterOverlayState?.(\(json))")
  }

  private func button(_ symbol: String, _ label: String, _ action: Selector) -> NSButton {
    let control = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: label)!, target: self, action: action)
    control.bezelStyle = .texturedRounded
    control.isBordered = false
    control.image?.isTemplate = true
    control.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)
    control.contentTintColor = .white
    control.toolTip = label
    control.setAccessibilityLabel(label)
    control.widthAnchor.constraint(equalToConstant: 28).isActive = true
    return control
  }

  private func position(preferPointer: Bool = false) {
    let pointerScreen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
    guard let screen = (preferPointer ? pointerScreen : panel?.screen) ?? NSScreen.main else { return }
    let width = min(overlayWidth, screen.visibleFrame.width - 32)
    // Extend the camera housing's black surface to the physical top edge.
    // All controls and text remain below the hardware cutout.
    let inset = screen.safeAreaInsets.top
    headerTop?.constant = inset + 6
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = fontSize * 0.3
    let measured = (script as NSString).boundingRect(with: NSSize(width: max(1, width - 44), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: fontSize, weight: .medium), .paragraphStyle: paragraph]).height
    let readingHeight = min(max(fontSize * 1.3, ceil(measured)) + 24, fontSize * 3.9 + 24)
    let height = min(inset + 38 + readingHeight, screen.frame.height * 0.4)
    panel?.setFrame(NSRect(x: screen.frame.midX - width / 2, y: screen.frame.maxY - height, width: width, height: height), display: true)
    syncOverlay()
  }

  private func layoutScript() {
    panel?.contentView?.layoutSubtreeIfNeeded()
    updateReadingFade()
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = fontSize * 0.3
    text.textStorage?.setAttributedString(NSAttributedString(string: script, attributes: [.font: NSFont.systemFont(ofSize: fontSize, weight: .medium), .foregroundColor: NSColor.white, .paragraphStyle: paragraph]))
    let viewport = scroll.contentView.bounds.size
    text.setFrameSize(NSSize(width: viewport.width, height: max(1, viewport.height)))
    text.textContainer?.containerSize = NSSize(width: max(1, viewport.width - 24), height: .greatestFiniteMagnitude)
    if let container = text.textContainer, let manager = text.layoutManager {
      manager.ensureLayout(for: container)
      let height = manager.usedRect(for: container).height
      let documentHeight = height + 24 <= viewport.height ? viewport.height : height + viewport.height * 0.65 + 24
      text.setFrameSize(NSSize(width: viewport.width, height: documentHeight))
      let words = max(1, script.split(whereSeparator: { $0.isWhitespace }).count)
      pixelsPerSecond = max(4, height / Double(words) * pace / 60)
      readDuration = Double(words) / pace * 60
      if mode == "voice" { highlightSpokenWords() }
    }
    syncOverlay()
  }

  @objc private func toggle() { state == "running" ? pause() : resume() }
  @objc private func restart() { _ = handle(["action": "reset"]) }
  @objc private func closeOverlay() { stop() }
  private func setState(_ value: String) {
    state = value
    statusLabel.stringValue = value == "running" ? (mode == "voice" ? "Listening…" : "\(Int(pace)) wpm") : value == "finished" ? "End of script" : "Paused"
    statusLabel.toolTip = nil
    playButton?.image = NSImage(systemSymbolName: value == "running" ? "pause.fill" : "play.fill", accessibilityDescription: "Pause or resume")
    syncOverlay()
    onStateChange?(snapshot)
  }
  func pause(notify: Bool = true) {
    timer?.invalidate()
    timer = nil
    voiceGeneration = UUID()
    listener.stop()
    if state == "running" || overlayPresented { if notify { setState("paused") } else { state = "paused" } }
  }
  func resume() {
    guard overlayPresented, !script.isEmpty, state != "running" else { return }
    overlayError = nil
    if state == "finished" {
      tracker = TeleprompterWordTracker(script)
      readingSeconds = 0
      targetOffset = 0
      layoutScript()
      scroll.contentView.scroll(to: .zero)
    }
    setState("running")
    if mode == "voice" {
      let token = UUID()
      voiceGeneration = token
      listener.start(onTranscript: { [weak self] transcript, newSegment in
        guard let self, self.voiceGeneration == token, self.state == "running" else { return }
        let previous = self.tracker.nextWord
        self.tracker.consume(transcript, newSegment: newSegment)
        guard previous != self.tracker.nextWord else { return }
        self.highlightSpokenWords()
        if abs(self.targetOffset - self.scrollOffset) > 0.5 { self.startClock() }
        else if self.tracker.finished { self.finish() }
      }, onFailure: { [weak self] message in
        guard let self, self.voiceGeneration == token else { return }
        self.pause()
        self.statusLabel.stringValue = "Voice unavailable"
        self.statusLabel.toolTip = message
        self.overlayError = "Voice unavailable"
        self.syncOverlay()
        var value = self.snapshot
        value["error"] = message
        self.onStateChange?(value)
      })
      return
    }
    let maximum = max(0, text.frame.height - scroll.contentView.bounds.height)
    if maximum > 0 && scroll.contentView.bounds.minY >= maximum - 1 { scroll.contentView.scroll(to: .zero) }
    startClock()
  }
  private func startClock() {
    guard timer == nil else { return }
    lastTick = ProcessInfo.processInfo.systemUptime
    let clock = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.tick() }
    clock.tolerance = 0.008
    timer = clock
    RunLoop.main.add(clock, forMode: .common)
  }
  private func tick() {
    guard overlayPresented else { pause(notify: false); return }
    let now = ProcessInfo.processInfo.systemUptime
    let elapsed = min(0.1, max(0, now - lastTick))
    lastTick = now
    let maximum = max(0, text.frame.height - scroll.contentView.bounds.height)
    readingSeconds += elapsed
    let destination = mode == "voice" ? min(maximum, targetOffset) : maximum
    let offset = min(destination, scrollOffset + elapsed * pixelsPerSecond)
    scroll.contentView.scroll(to: NSPoint(x: 0, y: offset))
    scroll.reflectScrolledClipView(scroll.contentView)
    syncOverlay()
    if mode == "voice" && offset >= destination {
      timer?.invalidate()
      timer = nil
      if tracker.finished { finish() }
    } else if mode == "automatic" && readingSeconds >= readDuration && offset >= maximum { finish() }
  }
  private func finish() { pause(notify: false); setState("finished") }
  private func highlightSpokenWords() {
    guard let storage = text.textStorage else { return }
    storage.addAttribute(.foregroundColor, value: NSColor.white, range: NSRange(location: 0, length: storage.length))
    storage.addAttribute(.foregroundColor, value: NSColor(white: 0.5, alpha: 1), range: tracker.readRange)
    guard !tracker.ranges.isEmpty, let manager = text.layoutManager, let container = text.textContainer else { return }
    let range = tracker.ranges[min(tracker.nextWord, tracker.ranges.count - 1)]
    let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    let rect = manager.boundingRect(forGlyphRange: glyphs, in: container)
    targetOffset = max(0, rect.minY)
    syncOverlay()
  }
  func stop() {
    pause(notify: false)
    overlayPresented = false
    let generation = UUID()
    presentationGeneration = generation
    setState("stopped")
    guard let panel else { return }
    guard panel.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
      panel.orderOut(nil)
      panel.alphaValue = 1
      return
    }
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.12
      context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      panel.animator().alphaValue = 0
    }, completionHandler: { [weak self, weak panel] in
      guard let self, self.presentationGeneration == generation else { return }
      panel?.orderOut(nil)
      panel?.alphaValue = 1
    })
  }

  private func presentOverlay() {
    guard let panel else { return }
    let alreadyPresented = overlayPresented
    overlayPresented = true
    presentationGeneration = UUID()
    let animated = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    if !panel.isVisible { panel.alphaValue = animated ? 0 : 1 }
    panel.orderFrontRegardless()
    guard animated, !alreadyPresented else { panel.alphaValue = 1; return }
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.14
      context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      panel.animator().alphaValue = 1
    }
  }

  private func updateReadingFade() {
    guard panel != nil else { return }
    scroll.wantsLayer = true
    guard !NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency else { scroll.layer?.mask = nil; return }
    let fade = CAGradientLayer()
    fade.frame = scroll.bounds
    let edge = min(0.12, 10 / max(1, scroll.bounds.height))
    // Only the outer ten points soften; even edge text retains 75% opacity.
    fade.colors = [NSColor(white: 1, alpha: 0.75).cgColor, NSColor.white.cgColor, NSColor.white.cgColor, NSColor(white: 1, alpha: 0.75).cgColor]
    fade.locations = [0, NSNumber(value: Double(edge)), NSNumber(value: Double(1 - edge)), 1]
    fade.startPoint = CGPoint(x: 0.5, y: 0)
    fade.endPoint = CGPoint(x: 0.5, y: 1)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    scroll.layer?.mask = fade
    CATransaction.commit()
  }
}
