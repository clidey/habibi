//! `Windows.Media.SpeechRecognition` with a list constraint of the script's
//! words. List constraints are compiled and matched on the device, so audio
//! never leaves the PC (the dictation/topic grammars would use the cloud).

use std::sync::Mutex;

use windows::Foundation::TypedEventHandler;
use windows_collections::IIterable;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionListConstraint,
    SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows::core::HSTRING;

use super::{SpeechCallback, SpeechEvent};

const NEEDS_PERMISSION: &str =
    "Allow microphone and speech access in Windows Settings → Privacy & security, or choose Automatic scrolling.";
const STOPPED: &str = "Voice following stopped. Press Play to retry, or choose Automatic scrolling.";

struct Active {
    generation: u64,
    recognizer: SpeechRecognizer,
    session: SpeechContinuousRecognitionSession,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static GENERATION: Mutex<u64> = Mutex::new(0);

fn current() -> u64 {
    *GENERATION.lock().unwrap_or_else(|e| e.into_inner())
}

fn listen(generation: u64, vocabulary: Vec<String>, callback: SpeechCallback) -> windows::core::Result<()> {
    let recognizer = SpeechRecognizer::new()?;
    let words: Vec<HSTRING> = vocabulary.iter().map(HSTRING::from).collect();
    let constraint = SpeechRecognitionListConstraint::Create(&IIterable::<HSTRING>::from(words))?;
    recognizer.Constraints()?.Append(&constraint)?;
    let compiled = recognizer.CompileConstraintsAsync()?.join()?;
    if compiled.Status()? != SpeechRecognitionResultStatus::Success {
        return Err(windows::core::Error::empty());
    }
    let new_segment = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let hypothesis_callback = callback.clone();
    let hypothesis_segment = new_segment.clone();
    recognizer.HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(
        move |_, args| {
            if current() != generation {
                return Ok(());
            }
            let text = args.ok()?.Hypothesis()?.Text()?.to_string_lossy();
            let first = hypothesis_segment.swap(false, std::sync::atomic::Ordering::SeqCst);
            hypothesis_callback(SpeechEvent::Transcript { text, new_segment: first });
            Ok(())
        },
    ))?;
    let session = recognizer.ContinuousRecognitionSession()?;
    let result_callback = callback.clone();
    let result_segment = new_segment.clone();
    session.ResultGenerated(&TypedEventHandler::<
        SpeechContinuousRecognitionSession,
        SpeechContinuousRecognitionResultGeneratedEventArgs,
    >::new(move |_, args| {
        if current() != generation {
            return Ok(());
        }
        let text = args.ok()?.Result()?.Text()?.to_string_lossy();
        let first = result_segment.swap(true, std::sync::atomic::Ordering::SeqCst);
        if !text.is_empty() {
            result_callback(SpeechEvent::Transcript { text, new_segment: first });
        }
        Ok(())
    }))?;
    let completed_callback = callback;
    session.Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(
        move |_, _| {
            if current() == generation {
                completed_callback(SpeechEvent::Failure(STOPPED.into()));
            }
            Ok(())
        },
    ))?;
    session.StartAsync()?.join()?;
    let mut active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if current() == generation {
        *active = Some(Active { generation, recognizer, session });
    } else {
        let _ = session.CancelAsync();
    }
    Ok(())
}

pub fn start(vocabulary: Vec<String>, callback: SpeechCallback) {
    stop();
    let generation = current();
    std::thread::spawn(move || {
        if listen(generation, vocabulary, callback.clone()).is_err() && current() == generation {
            callback(SpeechEvent::Failure(NEEDS_PERMISSION.into()));
        }
    });
}

pub fn stop() {
    *GENERATION.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    if let Some(active) = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = active.generation;
        let _ = active.session.CancelAsync();
        let _ = active.recognizer.Close();
    }
}
