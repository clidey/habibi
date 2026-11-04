import AppKit
import WebKit
import UniformTypeIdentifiers

/** Notes clipboard/export requests are accepted only from the trusted launcher frame. */
func handleNotesMessage(_ settings: [String: Any], message: WKScriptMessage, window: NSWindow, webView: WKWebView) -> Bool {
  guard let type = settings["type"] as? String, ["copyNoteText", "exportNote"].contains(type) else { return false }
  guard message.frameInfo.isMainFrame, let origin = message.frameInfo.request.url,
        origin.scheme == "http", origin.host == "127.0.0.1", origin.port == 4173 else { return true }
  guard let text = settings["text"] as? String, text.utf16.count <= 300_000 else { return true }
  if type == "copyNoteText" {
    NSPasteboard.general.clearContents()
    let success = NSPasteboard.general.setString(text, forType: .string)
    webView.evaluateJavaScript("window.__habibiNotesCopyResult?.(\(success ? "true" : "false"))")
    return true
  }
  let save = NSSavePanel()
  save.title = "Export Markdown note"
  save.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
  save.canCreateDirectories = true
  let proposed = settings["filename"] as? String ?? "Note.md"
  save.nameFieldStringValue = String((proposed as NSString).lastPathComponent.prefix(160))
  save.beginSheetModal(for: window) { response in
    guard response == .OK, let url = save.url else {
      webView.evaluateJavaScript("window.__habibiNotesExportResult?.({ok:false,cancelled:true})")
      return
    }
    var success = false
    do { try text.write(to: url, atomically: true, encoding: .utf8); success = true } catch { }
    webView.evaluateJavaScript("window.__habibiNotesExportResult?.({ok:\(success ? "true" : "false")})")
  }
  return true
}
