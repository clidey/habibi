//! logind on the system bus: `Manager.PrepareForSleep(bool)` and the current
//! session's `Lock` / `Unlock` signals. Without logind (or a system bus)
//! nothing is delivered and capture simply never pauses.

use zbus::blocking::{Connection, Proxy};

use super::{PowerCallback, PowerEvent};

const DESTINATION: &str = "org.freedesktop.login1";

fn sleep_events(connection: &Connection, callback: &PowerCallback) -> zbus::Result<()> {
    let proxy = Proxy::new(connection, DESTINATION, "/org/freedesktop/login1", "org.freedesktop.login1.Manager")?;
    for message in proxy.receive_signal("PrepareForSleep")? {
        if let Ok(starting) = message.body().deserialize::<bool>() {
            callback(if starting { PowerEvent::WillSleep } else { PowerEvent::DidWake });
        }
    }
    Ok(())
}

fn lock_events(connection: &Connection, callback: &PowerCallback, signal: &'static str) -> zbus::Result<()> {
    let proxy =
        Proxy::new(connection, DESTINATION, "/org/freedesktop/login1/session/auto", "org.freedesktop.login1.Session")?;
    let event = if signal == "Lock" { PowerEvent::SessionResigned } else { PowerEvent::SessionActivated };
    for _ in proxy.receive_signal(signal)? {
        callback(event);
    }
    Ok(())
}

pub fn watch(callback: PowerCallback) {
    std::thread::spawn(move || {
        let Ok(connection) = Connection::system() else {
            tracing::debug!("no system bus; sleep and lock events are unavailable");
            return;
        };
        for signal in ["Lock", "Unlock"] {
            let connection = connection.clone();
            let callback = callback.clone();
            std::thread::spawn(move || {
                let _ = lock_events(&connection, &callback, signal);
            });
        }
        let _ = sleep_events(&connection, &callback);
    });
}
