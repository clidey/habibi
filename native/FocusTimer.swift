import AppKit
import WebKit

struct FocusSession {
  var duration: Double = 1500
  var remaining: Double = 1500
  var deadline: Date?
  var state = "idle"
  var label = "Focus"
  mutating func tick(now: Date = Date()) {
    guard state == "running", let end = deadline else { return }
    remaining = max(0, ceil(end.timeIntervalSince(now)))
    if remaining == 0 { state = "finished"; deadline = nil }
  }
  mutating func start(seconds: Double, label: String, now: Date = Date()) -> Bool {
    guard seconds.isFinite, seconds >= 60, seconds <= 14400, label.utf16.count <= 100 else { return false }
    duration = seconds; remaining = seconds; deadline = now.addingTimeInterval(seconds); state = "running"; self.label = label.isEmpty ? "Focus" : label; return true
  }
  mutating func pause(now: Date = Date()) { tick(now: now); if state == "running" { state = "paused"; deadline = nil } }
  mutating func resume(now: Date = Date()) { if state == "paused", remaining > 0 { state = "running"; deadline = now.addingTimeInterval(remaining) } }
  mutating func reset() { state = "idle"; deadline = nil; remaining = duration }
}

final class FocusTimerController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  private var session = FocusSession()
  private var timer: Timer?
  private var panel: NSPanel?
  private var webView: WKWebView?
  private var overlayURL: URL?
  private var ready = false
  private var visible = false
  private var screenObserver: NSObjectProtocol?
  var onChange: (([String: Any]) -> Void)?
  override init() {
    super.init()
    if let saved = UserDefaults.standard.dictionary(forKey: "focusSession") {
      session.duration = saved["duration"] as? Double ?? 1500
      session.remaining = saved["remaining"] as? Double ?? session.duration
      session.state = saved["state"] as? String ?? "idle"
      session.label = saved["label"] as? String ?? "Focus"
      if let epoch = saved["deadline"] as? Double { session.deadline = Date(timeIntervalSince1970: epoch) }
      session.tick()
    }
    configureTimer()
    screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.position(); self?.send() }
  }
  deinit { timer?.invalidate(); if let observer = screenObserver { NotificationCenter.default.removeObserver(observer) }; webView?.configuration.userContentController.removeScriptMessageHandler(forName: "focusOverlay") }
  var snapshot: [String: Any] { ["ok": true, "state": session.state, "remaining": session.remaining, "duration": session.duration, "label": session.label, "visible": visible] }
  func handle(_ value: [String: Any]) -> [String: Any] {
    let action = value["action"] as? String ?? "state"
    switch action {
    case "start":
      guard session.start(seconds: value["seconds"] as? Double ?? 1500, label: value["label"] as? String ?? "Focus") else { return ["ok": false, "error": "Choose a timer between 1 minute and 4 hours."] }
      show()
    case "pause": session.pause()
    case "resume": session.resume()
    case "reset": session.reset()
    case "show": show()
    case "hide": visible = false; panel?.orderOut(nil)
    case "state": session.tick()
    default: return ["ok": false, "error": "Unknown timer action."]
    }
    configureTimer(); save(); send(); return snapshot
  }
  private func save() {
    var value: [String: Any] = ["state": session.state, "duration": session.duration, "remaining": session.remaining, "label": session.label]
    if let deadline = session.deadline { value["deadline"] = deadline.timeIntervalSince1970 }
    UserDefaults.standard.set(value, forKey: "focusSession")
  }
  private func configureTimer() {
    timer?.invalidate(); timer = nil
    guard session.state == "running" else { return }
    let next = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      guard let self else { return }
      let wasRunning = self.session.state == "running"
      self.session.tick()
      if wasRunning && self.session.state == "finished" { self.timer?.invalidate(); self.timer = nil; self.save(); NSSound(named: "Glass")?.play(); self.show() }
      self.send()
    }
    next.tolerance = 0.1; RunLoop.main.add(next, forMode: .common); timer = next
  }
  private func position() {
    guard let screen = panel?.screen ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
    let width = min(370, screen.visibleFrame.width - 24)
    let height = screen.safeAreaInsets.top + 54
    panel?.setFrame(NSRect(x: screen.frame.midX - width / 2, y: screen.frame.maxY - height, width: width, height: height), display: true)
  }
  private func show() {
    if panel == nil {
      let next = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      next.level = .statusBar; next.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; next.isOpaque = false; next.backgroundColor = .clear; next.hasShadow = true; next.hidesOnDeactivate = false
      let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent(); configuration.userContentController.add(self, name: "focusOverlay")
      let view = WKWebView(frame: .zero, configuration: configuration); view.setValue(false, forKey: "drawsBackground"); view.navigationDelegate = self; next.contentView = view
      panel = next; webView = view
      let bundled = Bundle.main.resourceURL?.appendingPathComponent("service/assets/focus-overlay.html")
      let local = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets/focus-overlay.html")
      overlayURL = bundled.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil } ?? local
      if let url = overlayURL { view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
    }
    visible = true; position(); panel?.orderFrontRegardless(); send()
  }
  private func send() {
    onChange?(snapshot)
    guard visible, ready, let webView else { return }
    var value = snapshot; value["inset"] = panel?.screen?.safeAreaInsets.top ?? 0
    if let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) { webView.evaluateJavaScript("window.__habibiFocusState?.(\(json))") }
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; send() }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(navigationAction.request.url == overlayURL ? .allow : .cancel) }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, message.frameInfo.request.url == overlayURL, let value = message.body as? [String: Any], let action = value["action"] as? String else { return }
    if action == "ready" { ready = true; send() } else if ["pause", "resume", "reset", "hide"].contains(action) { _ = handle(value) }
  }
}
