import AppKit

@main
private struct TeleprompterSmokeTest {
  static func main() {
    func advance(until condition: () -> Bool) {
      let deadline = Date().addingTimeInterval(3)
      while !condition() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
      precondition(condition(), "The native overlay did not reach its expected state")
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    let controller = TeleprompterController()
    precondition(!controller.hasActiveTimer)
    precondition(controller.overlayView == nil, "Idle launchers must not allocate an overlay")
    precondition(!controller.handle(["action": "unknown"]))
    precondition(!controller.handle(["action": "start", "script": "   "]))
    precondition(!controller.handle(["action": "start", "script": String(repeating: "x", count: 100_001)]))
    let script = String(repeating: "Stay present. Speak naturally. Let the next thought arrive.\n\n", count: 40)
    precondition(controller.handle(["action": "start", "script": script, "pace": 140.0, "fontSize": 24.0]))
    precondition(controller.hasActiveTimer)
    advance { controller.scrollOffset > 0 }
    precondition(controller.scrollOffset > 0, "The native text must actually scroll")
    controller.pause()
    precondition(!controller.hasActiveTimer)
    let pausedOffset = controller.scrollOffset
    RunLoop.main.run(until: Date().addingTimeInterval(0.15))
    precondition(controller.scrollOffset == pausedOffset, "Paused overlays must do no scrolling")
    if let window = controller.overlayView?.window,
       let space = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49) {
      precondition(window.performKeyEquivalent(with: space) && controller.hasActiveTimer)
      precondition(window.performKeyEquivalent(with: space) && !controller.hasActiveTimer)
    } else { preconditionFailure("The focused overlay must support Space to pause and resume") }
    if let view = controller.overlayView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
      view.cacheDisplay(in: view.bounds, to: bitmap)
      if let png = bitmap.representation(using: .png, properties: [:]) {
        try! png.write(to: URL(fileURLWithPath: "/private/tmp/habibi-teleprompter-overlay.png"))
      }
    }
    if let frame = controller.overlayFrame, let screen = NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: frame.midX, y: frame.midY)) }) {
      precondition(frame.maxY <= screen.frame.maxY - screen.safeAreaInsets.top)
      precondition(frame.minX >= screen.frame.minX && frame.maxX <= screen.frame.maxX)
    } else { preconditionFailure("The overlay must sit on a connected display") }
    controller.resume()
    NotificationCenter.default.post(name: NSApplication.didHideNotification, object: app)
    precondition(!controller.hasActiveTimer, "Hiding the app must invalidate the timer")
    controller.resume()
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
    precondition(!controller.hasActiveTimer, "Sleep must invalidate the timer")
    controller.handle(["action": "reset"])
    precondition(controller.scrollOffset == 0)
    controller.handle(["action": "configure", "fontSize": 900.0, "pace": -20.0])
    precondition(controller.snapshot["fontSize"] as? Double == 40)
    precondition(controller.snapshot["pace"] as? Double == 60)
    controller.handle(["action": "configure", "fontSize": Double.nan])
    precondition(controller.snapshot["fontSize"] as? Double == 40, "Invalid numbers must never reach text layout")
    controller.stop()
    precondition(controller.snapshot["visible"] as? Bool == false && !controller.hasActiveTimer)
    controller.handle(["action": "start", "script": "Done."])
    advance { controller.state == "finished" }
    precondition(controller.state == "finished" && !controller.hasActiveTimer)
    controller.stop()
    print("Teleprompter smoke test passed: scrolling, pause, restart, sleep, bounds, completion, and close.")
  }
}
