import AppKit
import EventKit

/** Reads never prompt; saving/completing runs only after an explicit UI confirmation. */
final class ReminderService {
  private let store = EKEventStore()
  var onPermissionChange: ((Bool) -> Void)?
  private var authorized: Bool {
    let status = EKEventStore.authorizationStatus(for: .reminder)
    if #available(macOS 14.0, *) { return status == .fullAccess || status == .authorized }
    return status == .authorized
  }
  func access(_ completion: @escaping ([String: Any]) -> Void) {
    onPermissionChange?(true)
    let done: (Bool, Error?) -> Void = { [weak self] _, _ in DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self?.onPermissionChange?(false); self?.list(completion) } }
    if #available(macOS 14.0, *) { store.requestFullAccessToReminders(completion: done) }
    else { store.requestAccess(to: .reminder, completion: done) }
  }
  func list(_ completion: @escaping ([String: Any]) -> Void) {
    guard authorized else { completion(["ok": true, "access": false, "reason": EKEventStore.authorizationStatus(for: .reminder) == .notDetermined ? "notDetermined" : "denied", "items": [], "lists": []]); return }
    let calendars = store.calendars(for: .reminder).filter { $0.allowsContentModifications }
    let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
    store.fetchReminders(matching: predicate) { values in DispatchQueue.main.async {
      let items: [[String: Any]] = (values ?? []).sorted { ($0.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture) < ($1.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture) }.prefix(200).map { reminder in
        let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
        return ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? "Reminder", "due": due.map { ISO8601DateFormatter().string(from: $0) } ?? "", "list": reminder.calendar.title, "completed": reminder.isCompleted]
      }
      completion(["ok": true, "access": true, "items": items, "lists": calendars.map { ["id": $0.calendarIdentifier, "name": $0.title] }, "defaultList": self.store.defaultCalendarForNewReminders()?.calendarIdentifier ?? ""])
    } }
  }
  func create(_ value: [String: Any], completion: @escaping ([String: Any]) -> Void) {
    guard authorized, value["approved"] as? Bool == true, let title = value["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 500 else { completion(["ok": false, "error": "Review the reminder and allow Reminders access before saving."]); return }
    let reminder = EKReminder(eventStore: store)
    reminder.title = title
    let listID = value["listId"] as? String ?? ""
    reminder.calendar = listID.isEmpty ? store.defaultCalendarForNewReminders() : store.calendars(for: .reminder).first { $0.calendarIdentifier == listID && $0.allowsContentModifications }
    guard reminder.calendar?.allowsContentModifications == true else { completion(["ok": false, "error": "Choose a writable Reminders list."]); return }
    if let raw = value["due"] as? String, !raw.isEmpty {
      let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      guard let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { completion(["ok": false, "error": "Choose a valid reminder date."]); return }
      reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
      reminder.addAlarm(EKAlarm(absoluteDate: date))
    }
    if let notes = value["notes"] as? String { guard notes.utf16.count <= 10000 else { completion(["ok": false, "error": "The reminder note is too long."]); return }; reminder.notes = notes }
    do { try store.save(reminder, commit: true); list(completion) }
    catch { completion(["ok": false, "error": "Apple Reminders could not save this reminder."]) }
  }
  func complete(_ value: [String: Any], completion: @escaping ([String: Any]) -> Void) {
    guard authorized, value["approved"] as? Bool == true, let id = value["id"] as? String, id.utf16.count <= 2048, let reminder = store.calendarItem(withIdentifier: id) as? EKReminder, reminder.calendar.allowsContentModifications else { completion(["ok": false, "error": "This reminder could not be completed."]); return }
    reminder.isCompleted = true
    do { try store.save(reminder, commit: true); list(completion) } catch { completion(["ok": false, "error": "Apple Reminders could not update this reminder."]) }
  }
}
