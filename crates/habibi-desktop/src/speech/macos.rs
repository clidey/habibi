//! `SFSpeechRecognizer` (on-device only) + `AVAudioEngine`, through the
//! Objective-C runtime. Everything here runs on the main thread, which is
//! where Speech delivers results by default; state lives in a thread-local.

use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use objc2::rc::{Allocated, Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSBundle, NSString};

use super::{SpeechCallback, SpeechEvent};

#[link(name = "Speech", kind = "framework")]
unsafe extern "C" {}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVMediaTypeAudio: &'static NSString;
}

#[link(name = "AVFAudio", kind = "framework")]
unsafe extern "C" {
    static AVAudioEngineConfigurationChangeNotification: &'static NSString;
}

/// `SFSpeechRecognizerAuthorizationStatusAuthorized`.
const AUTHORIZED: isize = 3;
/// `SFSpeechRecognitionTaskHintDictation`.
const DICTATION: isize = 1;

const NEEDS_SPEECH: &str = "Allow Speech Recognition in System Settings → Privacy & Security, or choose Automatic scrolling.";
const NEEDS_MICROPHONE: &str = "Allow Microphone access in System Settings → Privacy & Security, or choose Automatic scrolling.";
const NO_ON_DEVICE: &str = "On-device speech recognition is unavailable for this Mac’s language. Choose Automatic scrolling instead.";
const NO_MICROPHONE: &str = "No microphone is available. Connect one or choose Automatic scrolling.";
const MICROPHONE_CHANGED: &str = "The microphone changed. Press Play to reconnect.";
const COULD_NOT_START: &str = "Could not start the microphone. Check its permissions and press Play to retry.";
const STOPPED: &str = "Voice following stopped. Press Play to retry, or choose Automatic scrolling.";
const NOT_BUNDLED: &str = "Voice following needs the installed Habibi app. Choose Automatic scrolling instead.";

/// The live recognition request, shared with the audio tap's thread.
struct SharedRequest(Option<Retained<AnyObject>>);
// SAFETY: `-[SFSpeechAudioBufferRecognitionRequest appendAudioPCMBuffer:]`
// is documented as callable from the audio thread; the object is only ever
// replaced under the mutex.
unsafe impl Send for SharedRequest {}

#[derive(Default)]
struct State {
    generation: u64,
    callback: Option<SpeechCallback>,
    engine: Option<Retained<AnyObject>>,
    recognizer: Option<Retained<AnyObject>>,
    request: Option<Retained<AnyObject>>,
    task: Option<Retained<AnyObject>>,
    observer: Option<Retained<AnyObject>>,
    tapped: bool,
    audio: Option<Arc<Mutex<SharedRequest>>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    STATE.with(|state| f(&mut state.borrow_mut()))
}

/// Run `f` on the main thread via the main operation queue.
fn on_main(f: impl FnOnce() + 'static) {
    let pending = Cell::new(Some(f));
    let block = RcBlock::new(move || {
        if let Some(f) = pending.take() {
            f();
        }
    });
    // SAFETY: `+[NSOperationQueue mainQueue]` and `-addOperationWithBlock:`
    // take no other arguments; the block is copied by the queue.
    unsafe {
        let queue: Retained<AnyObject> = msg_send![class!(NSOperationQueue), mainQueue];
        let _: () = msg_send![&*queue, addOperationWithBlock: &*block];
    }
}

fn has_usage_descriptions() -> bool {
    let bundle = NSBundle::mainBundle();
    ["NSSpeechRecognitionUsageDescription", "NSMicrophoneUsageDescription"]
        .iter()
        .all(|key| bundle.objectForInfoDictionaryKey(&NSString::from_str(key)).is_some())
}

fn current(token: u64) -> bool {
    with_state(|state| state.generation == token)
}

fn fail(token: u64, message: &str) {
    if !current(token) {
        return;
    }
    let callback = with_state(|state| state.callback.clone());
    stop();
    if let Some(callback) = callback {
        callback(SpeechEvent::Failure(message.into()));
    }
}

pub fn start(callback: SpeechCallback) {
    stop();
    let token = with_state(|state| {
        state.callback = Some(callback);
        state.generation
    });
    // Without the usage strings macOS terminates the process on the first
    // privacy request, so an unbundled development build reports instead.
    if !has_usage_descriptions() {
        fail(token, NOT_BUNDLED);
        return;
    }
    let Some(recognizer_class) = AnyClass::get(c"SFSpeechRecognizer") else {
        fail(token, NO_ON_DEVICE);
        return;
    };
    let block = RcBlock::new(move |status: isize| {
        on_main(move || {
            if !current(token) {
                return;
            }
            if status != AUTHORIZED {
                fail(token, NEEDS_SPEECH);
                return;
            }
            request_microphone(token);
        });
    });
    // SAFETY: `+requestAuthorization:` takes a `void (^)(NSInteger)` block.
    unsafe {
        let _: () = msg_send![recognizer_class, requestAuthorization: &*block];
    }
}

fn request_microphone(token: u64) {
    let Some(device) = AnyClass::get(c"AVCaptureDevice") else {
        fail(token, NO_MICROPHONE);
        return;
    };
    let block = RcBlock::new(move |allowed: Bool| {
        let allowed = allowed.as_bool();
        on_main(move || {
            if !current(token) {
                return;
            }
            if !allowed {
                fail(token, NEEDS_MICROPHONE);
                return;
            }
            autoreleasepool(|_| begin(token));
        });
    });
    // SAFETY: `+requestAccessForMediaType:completionHandler:` takes an
    // AVMediaType and a `void (^)(BOOL)` block.
    unsafe {
        let _: () = msg_send![device, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*block];
    }
}

fn begin(token: u64) {
    let (Some(recognizer_class), Some(engine_class)) = (AnyClass::get(c"SFSpeechRecognizer"), AnyClass::get(c"AVAudioEngine"))
    else {
        fail(token, NO_ON_DEVICE);
        return;
    };
    // SAFETY: standard alloc/init and property getters on Speech/AVFAudio
    // classes, with argument types matching their headers.
    unsafe {
        let locale: Retained<AnyObject> = msg_send![class!(NSLocale), currentLocale];
        let allocated: Allocated<AnyObject> = msg_send![recognizer_class, alloc];
        let recognizer: Option<Retained<AnyObject>> = msg_send![allocated, initWithLocale: &*locale];
        let Some(recognizer) = recognizer else {
            fail(token, NO_ON_DEVICE);
            return;
        };
        let available: bool = msg_send![&*recognizer, isAvailable];
        let on_device: bool = msg_send![&*recognizer, supportsOnDeviceRecognition];
        if !available || !on_device {
            fail(token, NO_ON_DEVICE);
            return;
        }
        let engine: Retained<AnyObject> = msg_send![engine_class, new];
        let input: Retained<AnyObject> = msg_send![&*engine, inputNode];
        let format: Retained<AnyObject> = msg_send![&*input, outputFormatForBus: 0usize];
        let sample_rate: f64 = msg_send![&*format, sampleRate];
        let channels: u32 = msg_send![&*format, channelCount];
        if sample_rate <= 0.0 || channels == 0 {
            fail(token, NO_MICROPHONE);
            return;
        }
        let audio = Arc::new(Mutex::new(SharedRequest(None)));
        with_state(|state| {
            state.recognizer = Some(recognizer);
            state.engine = Some(engine.clone());
            state.audio = Some(audio.clone());
        });
        start_recognition(token);
        if with_state(|state| state.request.is_none()) {
            return;
        }
        let tap_audio = audio.clone();
        let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
            if buffer.is_null() {
                return;
            }
            let guard = tap_audio.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(request) = &guard.0 {
                // SAFETY: `buffer` is the AVAudioPCMBuffer the tap received.
                let _: () = msg_send![&**request, appendAudioPCMBuffer: buffer];
            }
        });
        let _: () = msg_send![&*input, installTapOnBus: 0usize, bufferSize: 1024u32, format: &*format, block: &*tap];
        with_state(|state| state.tapped = true);
        let changed = RcBlock::new(move |_notification: *mut AnyObject| {
            fail(token, MICROPHONE_CHANGED);
        });
        let center: Retained<AnyObject> = msg_send![class!(NSNotificationCenter), defaultCenter];
        let queue: Retained<AnyObject> = msg_send![class!(NSOperationQueue), mainQueue];
        let observer: Option<Retained<AnyObject>> = msg_send![
            &*center,
            addObserverForName: AVAudioEngineConfigurationChangeNotification,
            object: &*engine,
            queue: &*queue,
            usingBlock: &*changed
        ];
        with_state(|state| state.observer = observer);
        let _: () = msg_send![&*engine, prepare];
        let started: bool = msg_send![&*engine, startAndReturnError: std::ptr::null_mut::<*mut AnyObject>()];
        if !started {
            fail(token, COULD_NOT_START);
        }
    }
}

fn start_recognition(token: u64) {
    let Some(request_class) = AnyClass::get(c"SFSpeechAudioBufferRecognitionRequest") else {
        fail(token, NO_ON_DEVICE);
        return;
    };
    let Some(recognizer) = with_state(|state| state.recognizer.clone()) else { return };
    // SAFETY: property setters and `-recognitionTaskWithRequest:resultHandler:`
    // with a `void (^)(SFSpeechRecognitionResult *, NSError *)` block.
    unsafe {
        let request: Retained<AnyObject> = msg_send![request_class, new];
        let _: () = msg_send![&*request, setRequiresOnDeviceRecognition: true];
        let _: () = msg_send![&*request, setShouldReportPartialResults: true];
        let _: () = msg_send![&*request, setTaskHint: DICTATION];
        with_state(|state| {
            state.request = Some(request.clone());
            if let Some(audio) = &state.audio {
                audio.lock().unwrap_or_else(|e| e.into_inner()).0 = Some(request.clone());
            }
        });
        let first = Cell::new(true);
        let expected = Retained::as_ptr(&request) as usize;
        let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            let live = with_state(|state| {
                state.generation == token
                    && state.request.as_ref().map(|r| Retained::as_ptr(r) as usize) == Some(expected)
            });
            if !live {
                return;
            }
            if !result.is_null() {
                let new_segment = first.replace(false);
                let transcription: Option<Retained<AnyObject>> = msg_send![result, bestTranscription];
                let text: Option<Retained<NSString>> =
                    transcription.as_ref().and_then(|t| msg_send![&**t, formattedString]);
                let is_final: bool = msg_send![result, isFinal];
                let callback = with_state(|state| state.callback.clone());
                if let (Some(callback), Some(text)) = (callback, text) {
                    callback(SpeechEvent::Transcript { text: text.to_string(), new_segment });
                }
                if !current(token) {
                    return;
                }
                if is_final {
                    with_state(|state| state.task = None);
                    start_recognition(token);
                    return;
                }
            }
            if !error.is_null() {
                fail(token, STOPPED);
            }
        });
        let task: Option<Retained<AnyObject>> =
            msg_send![&*recognizer, recognitionTaskWithRequest: &*request, resultHandler: &*handler];
        with_state(|state| state.task = task);
    }
}

pub fn stop() {
    let state = with_state(|state| {
        state.generation += 1;
        let callback = state.callback.take();
        let old = std::mem::take(state);
        state.generation = old.generation;
        state.callback = callback;
        old
    });
    // SAFETY: tearing down objects created in `begin`/`start_recognition`.
    unsafe {
        if let Some(engine) = &state.engine {
            let _: () = msg_send![&**engine, stop];
            if state.tapped {
                let input: Retained<AnyObject> = msg_send![&**engine, inputNode];
                let _: () = msg_send![&*input, removeTapOnBus: 0usize];
            }
        }
        if let Some(audio) = &state.audio {
            audio.lock().unwrap_or_else(|e| e.into_inner()).0 = None;
        }
        if let Some(request) = &state.request {
            let _: () = msg_send![&**request, endAudio];
        }
        if let Some(task) = &state.task {
            let _: () = msg_send![&**task, cancel];
        }
        if let Some(observer) = &state.observer {
            let center: Retained<AnyObject> = msg_send![class!(NSNotificationCenter), defaultCenter];
            let _: () = msg_send![&*center, removeObserver: &**observer];
        }
    }
}
