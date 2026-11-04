import Foundation
@main struct DailySmokeTest {
  static func main() {
    let now = Date(timeIntervalSince1970: 1000)
    var value = FocusSession()
    assert(!value.start(seconds: 0, label: "bad", now: now))
    assert(value.start(seconds: 120, label: "Test", now: now))
    value.tick(now: now.addingTimeInterval(30)); assert(value.remaining == 90)
    value.pause(now: now.addingTimeInterval(40)); assert(value.remaining == 80 && value.state == "paused")
    value.resume(now: now.addingTimeInterval(200)); value.tick(now: now.addingTimeInterval(279)); assert(value.remaining == 1)
    value.tick(now: now.addingTimeInterval(400)); assert(value.remaining == 0 && value.state == "finished")
    value.reset(); assert(value.state == "idle" && value.remaining == 120)
    assert(!ClipboardHistory.permits(types: ["org.nspasteboard.ConcealedType"], bundle: "com.example.editor"))
    assert(!ClipboardHistory.permits(types: ["public.utf8-plain-text"], bundle: "com.apple.Passwords"))
    assert(ClipboardHistory.permits(types: ["public.utf8-plain-text"], bundle: "com.example.editor"))
    print("Daily utilities smoke checks passed: wall-clock focus timing and sensitive clipboard exclusions.")
  }
}
