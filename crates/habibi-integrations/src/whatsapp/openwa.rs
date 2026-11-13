//! HTTP client for the local OpenWA gateway (`src/connectors/openwa-client.ts`),
//! including its session self-healing.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::http::{HttpError, HttpFetch, HttpRequest};
use crate::util::{js_string, truthy};

pub const BASE_URL: &str = "http://127.0.0.1:2785";

const NOT_SET_UP: &str = "WhatsApp gateway is not set up. See the README for how to run OpenWA.";
const NOT_RUNNING: &str = "WhatsApp gateway is not running. See the README for how to start OpenWA.";
const UNREADABLE: &str = "WhatsApp gateway returned an unreadable response.";

/// History can carry base64 media; keep a generous but finite bound.
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

// Only pre-link failure states are eligible for auto-healing. 'disconnected'
// is deliberately excluded even though it is not "progressing": the session
// was already created with autoReconnect:true, so OpenWA's own reconnect
// logic owns recovering from that — force-killing a disconnected session
// would destroy a real linked WhatsApp device and force an unnecessary
// re-scan, which is strictly worse than staying disconnected a while longer.
const HEALABLE_STATUSES: &[&str] = &["created", "initializing", "failed"];

// A DISCONNECTED session with engineLoaded:false — a real, previously-linked
// WhatsApp account whose engine simply never reloaded — must never be force-
// killed (that would destroy the link), but it also never restarts on its
// own: the automatic UI flow only calls ensure_session() (which restarts the
// engine) when NO session exists yet. Throttled rather than attempted on
// every single poll (session_state() is hit every 1.5s by the setup UI):
// OpenWA's own start endpoint does real work (launches Chromium) when not
// already loaded, so hammering it would relaunch it needlessly often.
const RESTART_RETRY: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Healing {
    stuck: Option<(String, Instant)>,
    last_restart: Option<(String, Instant)>,
}

pub struct OpenwaClient {
    key_path: PathBuf,
    base_url: String,
    session_name: String,
    stale_after: Duration,
    http: Arc<dyn HttpFetch>,
    healing: Mutex<Healing>,
}

fn id_of(session: &Value) -> String {
    session.get("id").map(js_string).unwrap_or_else(|| "undefined".into())
}

fn status_of(session: &Value) -> String {
    session.get("status").map(js_string).unwrap_or_default()
}

impl OpenwaClient {
    /// `state_root` is the workspace OpenWA was started in; its bootstrap
    /// key lives at `<state_root>/.openwa/data/.api-key`.
    pub fn new(state_root: PathBuf, http: Arc<dyn HttpFetch>) -> Self {
        Self::with_options(state_root, http, BASE_URL, Duration::from_secs(45))
    }

    /// `stale_after` is how long a session may sit in a healable status
    /// before being force-killed and recreated (overridable for tests).
    pub fn with_options(state_root: PathBuf, http: Arc<dyn HttpFetch>, base_url: &str, stale_after: Duration) -> Self {
        Self {
            // OpenWA (github.com/rmyndharis/OpenWA) generates this key itself on first run
            // and writes it to BOOTSTRAP_KEY_FILE, which the supervisor points here.
            key_path: state_root.join(".openwa").join("data").join(".api-key"),
            base_url: base_url.to_string(),
            session_name: "habibi".into(),
            stale_after,
            http,
            healing: Mutex::new(Healing::default()),
        }
    }

    fn healing(&self) -> std::sync::MutexGuard<'_, Healing> {
        self.healing.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One gateway call. Errors are fixed, path-free messages.
    pub async fn request(&self, method: &'static str, route: &str, body: Option<Value>) -> Result<Value, String> {
        let key = std::fs::read_to_string(&self.key_path).map_err(|_| NOT_SET_UP.to_string())?;
        let mut request = HttpRequest::new(method, format!("{}{route}", self.base_url))
            .header("X-API-Key", key.trim())
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(8))
            .max_bytes(MAX_RESPONSE_BYTES);
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        // A closed connection means nothing is listening on the gateway port.
        let response = self.http.send(request).await.map_err(|error| match error {
            HttpError::Connect => NOT_RUNNING.to_string(),
            HttpError::TooLarge => UNREADABLE.to_string(),
        })?;
        if !response.ok() {
            return Err(format!("WhatsApp gateway request failed ({})", response.status));
        }
        if response.status == 204 {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&response.body).map_err(|_| UNREADABLE.to_string())
    }

    pub async fn get(&self, route: &str) -> Result<Value, String> {
        self.request("GET", route, None).await
    }

    async fn sessions(&self) -> Result<Option<Value>, String> {
        let sessions = self.get("/api/sessions").await?;
        let Value::Array(sessions) = sessions else { return Err(UNREADABLE.into()) };
        Ok(sessions
            .iter()
            .find(|item| item.get("name").and_then(Value::as_str) == Some(self.session_name.as_str()))
            .or(sessions.first())
            .cloned())
    }

    async fn start_session(&self, session: &Value) {
        if !truthy(session.get("engineLoaded")) {
            let _ = self.request("POST", &format!("/api/sessions/{}/start", id_of(session)), None).await;
        }
    }

    async fn maybe_restart_engine(&self, session: &Value) {
        if truthy(session.get("engineLoaded")) {
            return;
        }
        let id = id_of(session);
        {
            let mut healing = self.healing();
            if healing.last_restart.as_ref().is_some_and(|(last, at)| *last == id && at.elapsed() < RESTART_RETRY) {
                return;
            }
            healing.last_restart = Some((id, Instant::now()));
        }
        self.start_session(session).await;
    }

    async fn create_session(&self) -> Result<Value, String> {
        let body = json!({ "name": self.session_name, "config": { "autoReconnect": true } });
        let session = self.request("POST", "/api/sessions", Some(body)).await?;
        self.start_session(&session).await;
        Ok(session)
    }

    /// Force-kill and delete a session that has shown no progress for too
    /// long. Best-effort: a failure here just means the next check tries again.
    async fn heal_stuck_session(&self, id: &str) {
        let _ = self.request("POST", &format!("/api/sessions/{id}/force-kill"), None).await;
        let _ = self.request("DELETE", &format!("/api/sessions/{id}"), None).await;
    }

    // OpenWA's session record lives in its own SQLite DB under the state root,
    // entirely independent of the app or WhatsApp-component version — replacing
    // or upgrading the component does nothing to unstick a session whose engine
    // crashed or never finished launching (e.g. a Chromium launch failure).
    // session_state() is polled every 1.5s by the setup UI already, so tracking
    // staleness here — and force-healing past a threshold — makes recovery
    // transparent, and also covers a session left stuck from a previous run.
    /// The current named session, healed in place if stuck past the
    /// threshold. `None` only when there is none or a stuck one was just killed.
    async fn current_session(&self) -> Result<Option<Value>, String> {
        let Some(session) = self.sessions().await? else {
            self.healing().stuck = None;
            return Ok(None);
        };
        let id = id_of(&session);
        if !HEALABLE_STATUSES.contains(&status_of(&session).as_str()) {
            self.healing().stuck = None;
            self.maybe_restart_engine(&session).await;
            return Ok(Some(session));
        }
        let stale = {
            let mut healing = self.healing();
            match &healing.stuck {
                Some((stuck, since)) if *stuck == id => {
                    let stale = since.elapsed() > self.stale_after;
                    if stale {
                        healing.stuck = None;
                    }
                    stale
                }
                _ => {
                    healing.stuck = Some((id.clone(), Instant::now()));
                    false
                }
            }
        };
        if !stale {
            self.maybe_restart_engine(&session).await;
            return Ok(Some(session));
        }
        self.heal_stuck_session(&id).await;
        Ok(None)
    }

    /// `{ service: true, session, qrCode }`.
    pub async fn session_state(&self) -> Result<Value, String> {
        // A session just healed away is recreated immediately (not left null
        // for the caller to notice and retry): the setup UI's own poll loop
        // only keeps polling while it sees a truthy session.
        let session = match self.current_session().await? {
            Some(session) => session,
            None => self.create_session().await?,
        };
        let mut qr_code = Value::Null;
        if status_of(&session) == "qr_ready" {
            // QR rotates independently.
            if let Ok(qr) = self.get(&format!("/api/sessions/{}/qr", id_of(&session))).await
                && truthy(qr.get("qrCode")) {
                    qr_code = qr["qrCode"].clone();
                }
        }
        Ok(json!({ "service": true, "session": session, "qrCode": qr_code }))
    }

    pub async fn ensure_session(&self) -> Result<(), String> {
        // current_session() already attempts a throttled engine restart for
        // any session it returns, so no extra start here.
        if self.current_session().await?.is_none() {
            self.create_session().await?;
        }
        Ok(())
    }

    /// The "Refresh pairing" last resort, bypassing the staleness timer and
    /// the disconnected-session exclusion: it is only shown to a user who is
    /// already stuck, so force-killing even a disconnected session here is an
    /// acceptable, explicitly requested trade against re-scanning a QR code.
    pub async fn force_reset(&self) -> Result<(), String> {
        let session = self.sessions().await?;
        *self.healing() = Healing::default();
        if let Some(session) = session {
            self.heal_stuck_session(&id_of(&session)).await;
        }
        self.create_session().await?;
        Ok(())
    }

    /// Profile pictures for `ids` (`result.pictures || result`).
    pub async fn profile_pictures(&self, session_id: &str, ids: &[String]) -> Option<Value> {
        let route = format!(
            "/api/sessions/{}/contacts/profile-pictures?ids={}",
            crate::util::encode_component(session_id),
            crate::util::encode_component(&ids.join(","))
        );
        let result = self.get(&route).await.ok()?;
        let pictures = if truthy(result.get("pictures")) { result["pictures"].clone() } else { result };
        Some(pictures)
    }
}

#[cfg(test)]
mod tests;
