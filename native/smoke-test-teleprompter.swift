import AppKit

private final class TestTeleprompterListener: TeleprompterListening {
  var transcript: ((String, Bool) -> Void)?
  var failure: ((String) -> Void)?
  var active = false
  func start(onTranscript: @escaping (String, Bool) -> Void, onFailure: @escaping (String) -> Void) {
    active = true
    transcript = onTranscript
    failure = onFailure
  }
  func stop() { active = false }
}

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
    let listener = TestTeleprompterListener()
    let controller = TeleprompterController(listener: listener)
    precondition(!controller.hasActiveTimer)
    precondition(controller.overlayView == nil, "Idle launchers must not allocate an overlay")
    precondition(!controller.handle(["action": "unknown"]))
    precondition(!controller.handle(["action": "start", "script": "   "]))
    precondition(!controller.handle(["action": "start", "script": String(repeating: "x", count: 100_001)]))
    let script = String(repeating: "Stay present. Speak naturally. Let the next thought arrive.\n\n", count: 40)
    precondition(controller.handle(["action": "start", "script": script, "mode": "automatic", "pace": 140.0, "fontSize": 24.0]))
    precondition(!listener.active, "Automatic scrolling must never open the microphone")
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
      precondition(abs(frame.maxY - screen.frame.maxY) < 0.5, "The overlay must attach to the physical top edge without a gap")
      precondition(frame.minX >= screen.frame.minX && frame.maxX <= screen.frame.maxX)
      precondition(controller.overlayView?.window?.isMovableByWindowBackground == false, "The notch extension must stay attached")
      precondition(controller.overlayView?.layer?.borderWidth == 0, "The black notch extension must have no card outline")
      if let header = controller.overlayView?.subviews.first(where: { $0 is NSStackView }) {
        precondition(header.frame.maxY <= frame.height - screen.safeAreaInsets.top, "Controls must stay below the camera housing")
      } else { preconditionFailure("The overlay needs accessible playback controls") }
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
    precondition(controller.state == "running", "A script that fits must not end immediately on Play")
    precondition((controller.overlayFrame?.height ?? 1000) < 150 + (NSScreen.main?.safeAreaInsets.top ?? 0), "Short scripts should not leave an oversized empty panel")
    advance { controller.state == "finished" }
    precondition(controller.state == "finished" && !controller.hasActiveTimer)
    controller.stop()

    controller.handle(["action": "start", "script": "Done.", "mode": "voice"])
    RunLoop.main.run(until: Date().addingTimeInterval(0.15))
    precondition(controller.state == "running" && !controller.hasActiveTimer && listener.active, "Short scripts must wait for your voice")
    listener.transcript?("done", true)
    precondition(controller.state == "finished" && !listener.active)
    controller.stop()

    var matching = TeleprompterWordTracker("Hello, world! We’re ready for the next small step.")
    matching.consume("hello world", newSegment: true)
    precondition(matching.nextWord == 2)
    matching.consume("hello world")
    precondition(matching.nextWord == 2, "Repeated partial transcripts must not advance twice")
    matching.consume("hello world we're ready")
    precondition(matching.nextWord == 4, "Punctuation and apostrophes must normalize")
    matching.consume("unrelated conversation about the weather", newSegment: true)
    precondition(matching.nextWord == 4, "Off-script speech must not jump to incidental words")
    matching.consume("the next small step", newSegment: true)
    precondition(matching.finished, "Two consecutive words can recover after a skipped word")

    controller.handle(["action": "start", "script": "One small step.\nAnother calm thought.\nA clear ending.", "mode": "voice", "fontSize": 24.0, "pace": 260.0])
    precondition(listener.active && controller.state == "running" && !controller.hasActiveTimer)
    RunLoop.main.run(until: Date().addingTimeInterval(0.15))
    precondition(controller.scrollOffset == 0 && controller.matchedWords == 0, "Silence must hold the script still")
    listener.transcript?("one small step", true)
    precondition(controller.matchedWords == 3 && controller.state == "running")
    let staleTranscript = listener.transcript
    controller.pause()
    precondition(!listener.active && !controller.hasActiveTimer)
    staleTranscript?("another calm thought a clear ending", true)
    precondition(controller.matchedWords == 3, "Late speech callbacks must not advance paused scripts")
    controller.resume()
    listener.transcript?("another calm thought a clear ending", true)
    advance { controller.state == "finished" }
    precondition(!listener.active && !controller.hasActiveTimer, "Completion must release microphone and timer")
    controller.resume()
    precondition(controller.matchedWords == 0 && listener.active, "Play after completion must restart from the beginning")
    listener.failure?("Microphone unavailable")
    precondition(controller.state == "paused" && !listener.active && !controller.hasActiveTimer)
    controller.resume()
    controller.handle(["action": "reset"])
    precondition(controller.matchedWords == 0 && listener.active)
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
    precondition(!listener.active && !controller.hasActiveTimer)
    controller.stop()
    print("Teleprompter smoke test passed: voice matching, silence, partial results, stale callbacks, short scripts, scrolling, sleep, and close.")
  }
}
