import Cocoa
import ApplicationServices

func text(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
  return value as? String
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else { return [] }
  return value as? [AXUIElement] ?? []
}

func snapshot(_ element: AXUIElement, depth: Int) -> [String: Any] {
  var node: [String: Any] = [:]
  for (key, attribute) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("value", kAXValueAttribute)] {
    if let value = text(element, attribute as CFString), !value.isEmpty { node[key] = value }
  }
  if depth > 0 {
    let descendants = children(element).prefix(120).map { snapshot($0, depth: depth - 1) }
    if !descendants.isEmpty { node["children"] = descendants }
  }
  return node
}

guard AXIsProcessTrusted() else {
  print("{\"ok\":false,\"reason\":\"accessibility_not_allowed\"}")
  exit(0)
}

let apps = NSWorkspace.shared.runningApplications.filter { app in
  let bundle = app.bundleIdentifier?.lowercased() ?? ""
  let name = app.localizedName?.lowercased() ?? ""
  return bundle.contains("whatsapp") || name == "whatsapp"
}
guard let app = apps.first else {
  print("{\"ok\":false,\"reason\":\"whatsapp_not_running\"}")
  exit(0)
}

let application = AXUIElementCreateApplication(app.processIdentifier)
var windowsValue: CFTypeRef?
let windowsStatus = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windowsValue)
let windows = windowsStatus == .success ? (windowsValue as? [AXUIElement] ?? []) : []
let payload: [String: Any] = ["ok": true, "pid": app.processIdentifier, "windows": windows.prefix(1).map { snapshot($0, depth: 9) }]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
print(String(data: data, encoding: .utf8)!)
