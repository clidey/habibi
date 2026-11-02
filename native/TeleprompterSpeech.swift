import AppKit
import AVFoundation
import Speech

protocol TeleprompterListening: AnyObject {
  func start(onTranscript: @escaping (String, Bool) -> Void, onFailure: @escaping (String) -> Void)
  func stop()
}

/** Matches only new speech near the reading position, never arbitrary distant keywords. */
struct TeleprompterWordTracker {
  private(set) var words: [String] = []
  private(set) var ranges: [NSRange] = []
  private(set) var nextWord = 0
  private var previous: [String] = []
  var finished: Bool { !words.isEmpty && nextWord == words.count }
  var readRange: NSRange { NSRange(location: 0, length: nextWord == 0 ? 0 : NSMaxRange(ranges[nextWord - 1])) }
  init(_ script: String) {
    let expression = try! NSRegularExpression(pattern: "[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*")
    let source = script as NSString
    ranges = expression.matches(in: script, range: NSRange(location: 0, length: source.length)).map(\.range)
    words = ranges.map { Self.normalize(source.substring(with: $0)) }
  }
  private static func normalize(_ word: String) -> String {
    word.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale.current).replacingOccurrences(of: "’", with: "").replacingOccurrences(of: "'", with: "")
  }
  mutating func consume(_ transcript: String, newSegment: Bool = false) {
    let spoken = TeleprompterWordTracker(transcript).words
    var common = 0
    if !newSegment {
      while common < min(previous.count, spoken.count) && previous[common] == spoken[common] { common += 1 }
    }
    previous = spoken
    var index = common
    while index < spoken.count && nextWord < words.count {
      if spoken[index] == words[nextWord] { nextWord += 1 }
      else if index + 1 < spoken.count, nextWord + 1 < words.count {
        // Skipped words need two consecutive matches, avoiding jumps on incidental speech.
        let limit = min(words.count - 1, nextWord + 12)
        if let match = (nextWord..<limit).first(where: { words[$0] == spoken[index] && words[$0 + 1] == spoken[index + 1] }) {
          nextWord = match + 2
          index += 1
        }
      }
      index += 1
    }
  }
}

/** No recording files, network fallback, or microphone activity while paused. */
final class OnDeviceTeleprompterListener: TeleprompterListening {
  private var engine: AVAudioEngine?
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private let audioLock = NSLock()
  private var audioRequest: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var generation = UUID()
  private var tapped = false
  private var observer: NSObjectProtocol?
  deinit { stop() }

  func start(onTranscript: @escaping (String, Bool) -> Void, onFailure: @escaping (String) -> Void) {
    stop()
    let token = generation
    SFSpeechRecognizer.requestAuthorization { [weak self] permission in
      DispatchQueue.main.async {
        guard let self, self.generation == token else { return }
        guard permission == .authorized else {
          self.fail("Allow Speech Recognition in System Settings → Privacy & Security, or choose Automatic scrolling.", onFailure)
          return
        }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
          DispatchQueue.main.async {
            guard let self, self.generation == token else { return }
            guard allowed else {
              self.fail("Allow Microphone access in System Settings → Privacy & Security, or choose Automatic scrolling.", onFailure)
              return
            }
            self.begin(token, onTranscript, onFailure)
          }
        }
      }
    }
  }

  private func begin(_ token: UUID, _ transcript: @escaping (String, Bool) -> Void, _ failure: @escaping (String) -> Void) {
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
      fail("On-device speech recognition is unavailable for this Mac’s language. Choose Automatic scrolling instead.", failure)
      return
    }
    self.recognizer = recognizer
    let audio = AVAudioEngine()
    let input = audio.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { fail("No microphone is available. Connect one or choose Automatic scrolling.", failure); return }
    engine = audio
    startRecognition(token, transcript, failure)
    guard request != nil else { return }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let self else { return }
      self.audioLock.lock()
      let active = self.audioRequest
      self.audioLock.unlock()
      active?.append(buffer)
    }
    tapped = true
    observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: audio, queue: .main) { [weak self] _ in
      guard let self, self.generation == token else { return }
      self.fail("The microphone changed. Press Play to reconnect.", failure)
    }
    do { audio.prepare(); try audio.start() }
    catch { fail("Could not start the microphone. Check its permissions and press Play to retry.", failure) }
  }

  private func startRecognition(_ token: UUID, _ transcript: @escaping (String, Bool) -> Void, _ failure: @escaping (String) -> Void) {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    self.request = request
    audioLock.lock()
    audioRequest = request
    audioLock.unlock()
    var first = true
    task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.generation == token, self.request === request else { return }
        if let result {
          let newSegment = first
          first = false
          transcript(result.bestTranscription.formattedString, newSegment)
          guard self.generation == token else { return }
          if result.isFinal {
            self.task = nil
            self.startRecognition(token, transcript, failure)
            return
          }
        }
        if error != nil { self.fail("Voice following stopped. Press Play to retry, or choose Automatic scrolling.", failure) }
      }
    }
  }

  private func fail(_ message: String, _ callback: (String) -> Void) { stop(); callback(message) }
  func stop() {
    generation = UUID()
    if let engine {
      engine.stop()
      if tapped { engine.inputNode.removeTap(onBus: 0) }
    }
    tapped = false
    audioLock.lock()
    audioRequest = nil
    audioLock.unlock()
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    engine = nil
    recognizer = nil
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
  }
}
