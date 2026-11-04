import AppKit
import WebKit

/** Only the trusted launcher main frame may access utility data or approve a Reminder write. */
final class DailyUtilities {
  let clipboard: ClipboardHistory
  let reminders = ReminderService()
  let focus = FocusTimerController()
  var onChanged: ((String) -> Void)?
  init() {
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Habibi", isDirectory: true)
    clipboard = ClipboardHistory(root: root)
    clipboard.onChange = { [weak self] in self?.onChanged?("clipboard") }
  }
  func handle(_ value: [String: Any], message: WKScriptMessage, webView: WKWebView) -> Bool {
    guard value["type"] as? String == "dailyUtility" else { return false }
    guard message.frameInfo.isMainFrame, let origin = message.frameInfo.request.url, origin.scheme == "http", origin.host == "127.0.0.1", origin.port == 4173, let requestID = value["requestId"] as? String, requestID.utf16.count <= 100, let action = value["action"] as? String else { return true }
    let reply: ([String: Any]) -> Void = { result in
      var result = result; result["requestId"] = requestID
      guard let data = try? JSONSerialization.data(withJSONObject: result), let json = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async { webView.evaluateJavaScript("window.__habibiDailyResult?.(\(json))") }
    }
    switch action {
    case "clipboard.state": reply(clipboard.snapshot())
    case "clipboard.enable": clipboard.setEnabled(value["enabled"] as? Bool == true); reply(clipboard.snapshot())
    case "clipboard.copy": reply(["ok": clipboard.copy(value["id"] as? String ?? "")])
    case "clipboard.remove": clipboard.remove(value["id"] as? String); reply(clipboard.snapshot())
    case "clipboard.pin": let ok = clipboard.pin(value["id"] as? String ?? "", value: value["pinned"] as? Bool == true); reply(ok ? clipboard.snapshot() : ["ok": false, "error": "You can pin up to 20 clipboard items."])
    case "reminders.state": reminders.list(reply)
    case "reminders.settings": NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders")!); reply(["ok": true])
    case "reminders.access": reminders.access(reply)
    case "reminders.create": reminders.create(value, completion: reply)
    case "reminders.complete": reminders.complete(value, completion: reply)
    case "focus": reply(focus.handle(value["value"] as? [String: Any] ?? [:]))
    default: reply(["ok": false, "error": "This utility action is unavailable."])
    }
    return true
  }
}
