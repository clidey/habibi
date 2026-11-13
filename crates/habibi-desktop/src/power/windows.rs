//! A hidden top-level window on its own thread. Message-only windows
//! (`HWND_MESSAGE`) never receive broadcasts such as `WM_POWERBROADCAST`, so
//! this is an ordinary window that is never shown.

use std::sync::OnceLock;

use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{POWERBROADCAST_SETTING, RegisterPowerSettingNotification};
use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DEVICE_NOTIFY_WINDOW_HANDLE, DispatchMessageW, GetMessageW, MSG, PBT_APMRESUMEAUTOMATIC,
    PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, PBT_POWERSETTINGCHANGE, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE,
    WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED,
};
use windows::core::{GUID, w};

use super::{PowerCallback, PowerEvent};

static CALLBACK: OnceLock<PowerCallback> = OnceLock::new();

/// `GUID_CONSOLE_DISPLAY_STATE`: 0 off, 1 on, 2 dimmed.
const CONSOLE_DISPLAY_STATE: GUID = GUID::from_u128(0x6fe69556_704a_47a0_8f24_c28d936fda47);
const NOTIFY_FOR_THIS_SESSION: u32 = 0;
const WTS_CONSOLE_CONNECT: usize = 1;
const WTS_CONSOLE_DISCONNECT: usize = 2;
const WTS_SESSION_LOCK: usize = 7;
const WTS_SESSION_UNLOCK: usize = 8;

fn emit(event: PowerEvent) {
    if let Some(callback) = CALLBACK.get() {
        callback(event);
    }
}

/// The power-broadcast event a `WM_POWERBROADCAST` carries, if any.
fn power_event(wparam: usize, lparam: isize) -> Option<PowerEvent> {
    match wparam as u32 {
        PBT_APMSUSPEND => Some(PowerEvent::WillSleep),
        PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => Some(PowerEvent::DidWake),
        PBT_POWERSETTINGCHANGE if lparam != 0 => {
            // SAFETY: for PBT_POWERSETTINGCHANGE, lParam points at a
            // POWERBROADCAST_SETTING valid for the duration of the message.
            let setting = unsafe { &*(lparam as *const POWERBROADCAST_SETTING) };
            if setting.PowerSetting != CONSOLE_DISPLAY_STATE || setting.DataLength < 1 {
                return None;
            }
            Some(if setting.Data[0] == 0 { PowerEvent::ScreensSlept } else { PowerEvent::ScreensWoke })
        }
        _ => None,
    }
}

fn session_event(wparam: usize) -> Option<PowerEvent> {
    match wparam {
        WTS_SESSION_LOCK | WTS_CONSOLE_DISCONNECT => Some(PowerEvent::SessionResigned),
        WTS_SESSION_UNLOCK | WTS_CONSOLE_CONNECT => Some(PowerEvent::SessionActivated),
        _ => None,
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let event = match message {
        WM_POWERBROADCAST => power_event(wparam.0, lparam.0),
        WM_WTSSESSION_CHANGE => session_event(wparam.0),
        _ => None,
    };
    if let Some(event) = event {
        emit(event);
        if message == WM_POWERBROADCAST {
            return LRESULT(1);
        }
    }
    // SAFETY: forwarding the message we were given.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

pub fn watch(callback: PowerCallback) {
    if CALLBACK.set(callback).is_err() {
        return;
    }
    std::thread::spawn(|| {
        // SAFETY: plain Win32 window creation and a message loop on this
        // thread; the window and its registrations live until the process exits.
        unsafe {
            let Ok(instance) = GetModuleHandleW(None) else { return };
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: w!("HabibiPowerWatcher"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return;
            }
            let Ok(hwnd) = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("HabibiPowerWatcher"),
                w!("Habibi"),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                None,
            ) else {
                return;
            };
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            let _ = RegisterPowerSettingNotification(HANDLE(hwnd.0), &CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE);
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_power_and_session_messages() {
        assert_eq!(power_event(PBT_APMSUSPEND as usize, 0), Some(PowerEvent::WillSleep));
        assert_eq!(power_event(PBT_APMRESUMEAUTOMATIC as usize, 0), Some(PowerEvent::DidWake));
        assert_eq!(power_event(PBT_POWERSETTINGCHANGE as usize, 0), None);
        assert_eq!(session_event(WTS_SESSION_LOCK), Some(PowerEvent::SessionResigned));
        assert_eq!(session_event(WTS_SESSION_UNLOCK), Some(PowerEvent::SessionActivated));
        assert_eq!(session_event(5), None);
    }
}
