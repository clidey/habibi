// Prints the window number of the main window owned by a pid, for
// `screencapture -l` in CI: the largest on-screen window, else the largest of
// any. Usage: swift scripts/ci/window-id.swift <pid>
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else { exit(2) }
let windows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? [])
  .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
func area(_ window: [String: Any]) -> Double {
  let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
  return (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
}
let onScreen = windows.filter { ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
let pick = (onScreen.isEmpty ? windows : onScreen).filter { area($0) > 10_000 }.max { area($0) < area($1) }
if let number = pick?[kCGWindowNumber as String] as? Int { print(number); exit(0) }
FileHandle.standardError.write("no window for pid \(pid) among \(windows.count)\n".data(using: .utf8)!)
exit(1)
