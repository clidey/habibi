import Foundation
import EventKit

struct CalendarEvent: Encodable {
  let id: String
  let title: String
  let start: String
  let end: String
  let calendar: String
}

let store = EKEventStore()
let permission = DispatchGroup()
var granted = false

permission.enter()
if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { allowed, _ in
    granted = allowed
    permission.leave()
  }
} else {
  store.requestAccess(to: .event) { allowed, _ in
    granted = allowed
    permission.leave()
  }
}
permission.wait()

guard granted else {
  FileHandle.standardError.write(Data("Calendar permission was not granted\n".utf8))
  exit(1)
}

let now = Date()
let end = Calendar.current.date(byAdding: .day, value: 14, to: now)!
let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
let formatter = ISO8601DateFormatter()
let events = store.events(matching: predicate)
  .sorted { $0.startDate < $1.startDate }
  .prefix(30)
  .map { event in
    CalendarEvent(
      id: event.eventIdentifier,
      title: event.title ?? "Untitled event",
      start: formatter.string(from: event.startDate),
      end: formatter.string(from: event.endDate),
      calendar: event.calendar.title
    )
  }

let data = try JSONEncoder().encode(events)
FileHandle.standardOutput.write(data)
