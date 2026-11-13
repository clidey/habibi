//! `/api/calendar/accounts*`: list, connect Google (OAuth), connect CalDAV,
//! remove. Credentials go to the credential store; responses carry only
//! what [`Account::public_json`] allows.

use std::sync::Arc;
use std::time::Instant;

use habibi_core::ApiResponse;
use habibi_core::api::text;
use serde_json::{Value, json};

use crate::accounts::*;
use crate::caldav::{self, CalDav};
use crate::google::{self, Google, OAuthClient};
use crate::model::*;
use crate::oauth::{self, CallbackError};
use crate::service::{Flow, FlowState, Inner};

const FLOW_TTL_SECS: u64 = 15 * 60;

pub fn list(inner: &Inner) -> ApiResponse {
    let system = inner.options.system.as_ref().map(|system| {
        json!({
            "label": Inner::system_label(),
            "calendar": system.access(Entity::Event).as_str(),
            "reminders": system.access(Entity::Reminder).as_str(),
        })
    });
    let accounts: Vec<Value> = inner
        .accounts
        .list()
        .iter()
        .filter(|account| matches!(account.kind.as_str(), KIND_GOOGLE | KIND_CALDAV))
        .map(|account| account.public_json(inner.provider_for(account).is_some()))
        .collect();
    ApiResponse::json(&json!({
        "ok": true,
        "platform": habibi_platform::os(),
        "system": system,
        "accounts": accounts,
        "mailGoogleClient": inner.mail_client().is_some(),
    }))
}

fn now_label() -> String {
    crate::ids::iso(chrono::Utc::now())
}

fn valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

pub async fn start_google(inner: &Arc<Inner>, body: &Value) -> ApiResponse {
    let (client, source) = if body.get("useMailClient").and_then(Value::as_bool) == Some(true) {
        match inner.mail_client() {
            Some((id, secret)) => (
                OAuthClient {
                    id,
                    secret: Some(secret).filter(|secret| !secret.is_empty()),
                },
                CLIENT_MAIL,
            ),
            None => {
                return ApiResponse::error(
                    "Set up the Gmail OAuth client in Mail first, or enter a client ID.",
                );
            }
        }
    } else {
        let id = text(body.get("clientId")).trim().to_string();
        let secret = text(body.get("clientSecret")).trim().to_string();
        if !valid_client_id(&id) || secret.len() > 512 {
            return ApiResponse::error(
                "Enter the OAuth client ID (and secret) from Google Cloud Console.",
            );
        }
        (
            OAuthClient {
                id,
                secret: Some(secret).filter(|secret| !secret.is_empty()),
            },
            CLIENT_OWN,
        )
    };
    let Ok((listener, redirect_uri)) = oauth::bind().await else {
        return ApiResponse::error("Habibi could not start the Google sign-in. Try again.");
    };
    let (challenge, verifier) = oauth2::PkceCodeChallenge::new_random_sha256();
    let state = oauth2::CsrfToken::new_random().secret().clone();
    let url = google::authorization_url(
        &inner.options.google,
        &client.id,
        &redirect_uri,
        &state,
        challenge.as_str(),
    );
    let flow_id = uuid::Uuid::new_v4().to_string();

    let task_inner = inner.clone();
    let task_flow = flow_id.clone();
    let verifier = verifier.secret().clone();
    let timeout = inner.options.sign_in_timeout;
    let task = tokio::spawn(async move {
        let outcome = match oauth::wait_for_code(&listener, &state, timeout).await {
            Ok((code, page)) => {
                let result =
                    finish_google(&task_inner, client, source, &code, &verifier, &redirect_uri)
                        .await;
                page.done(result.is_ok()).await;
                match result {
                    Ok(account) => FlowState::Connected(account),
                    Err(message) => FlowState::Failed(message),
                }
            }
            Err(CallbackError::Denied) => FlowState::Failed("Google sign-in was cancelled."),
            Err(CallbackError::TimedOut) => {
                FlowState::Failed("Google sign-in timed out. Try again.")
            }
        };
        if let Some(flow) = task_inner
            .flows
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(&task_flow)
        {
            flow.state = outcome;
            flow.task = None;
        }
    });
    {
        let mut flows = inner
            .flows
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // One sign-in at a time: a new one replaces any still waiting.
        for flow in flows.values_mut() {
            if let Some(task) = flow.task.take() {
                task.abort();
                flow.state = FlowState::Failed("Google sign-in was replaced by a newer attempt.");
            }
        }
        flows.retain(|_, flow| flow.created.elapsed().as_secs() < FLOW_TTL_SECS);
        flows.insert(
            flow_id.clone(),
            Flow {
                state: FlowState::Pending,
                created: Instant::now(),
                task: Some(task.abort_handle()),
            },
        );
    }
    let opened = (inner.options.open_url)(&url);
    ApiResponse::json(&json!({ "ok": true, "flow": flow_id, "url": url, "opened": opened }))
}

async fn finish_google(
    inner: &Inner,
    client: OAuthClient,
    source: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Value, &'static str> {
    let transport = inner.options.transport.clone();
    let tokens = google::exchange_code(
        transport.as_ref(),
        &inner.options.google,
        &client,
        code,
        verifier,
        redirect_uri,
    )
    .await
    .map_err(|_| "Google did not accept the sign-in. Check the OAuth client ID and secret.")?;
    let refresh = tokens
        .refresh
        .clone()
        .ok_or("Google did not return a refresh token. Remove Habibi's access in your Google account, then try again.")?;
    let probe_id = uuid::Uuid::new_v4().to_string();
    inner
        .tokens
        .put(&probe_id, tokens.access.clone(), tokens.expires_in);
    let probe = Google::new(
        transport,
        inner.options.google.clone(),
        probe_id.clone(),
        client.clone(),
        refresh.clone(),
        inner.tokens.clone(),
    );
    let email = probe.primary_email().await;
    inner.tokens.forget(&probe_id);
    let email = email.map_err(|_| "Habibi could not read your Google calendars. Check that the Calendar API is enabled for this OAuth client.")?;

    let existing = inner.accounts.list().into_iter().find(|account| {
        account.kind == KIND_GOOGLE && account.username.eq_ignore_ascii_case(&email)
    });
    let account = Account {
        id: existing
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or(probe_id),
        kind: KIND_GOOGLE.into(),
        label: "Google".into(),
        username: email,
        client_id: (source == CLIENT_OWN).then(|| client.id.clone()),
        client_source: Some(source.into()),
        calendars: true,
        reminders: true,
        created_at: existing
            .as_ref()
            .map(|account| account.created_at.clone())
            .unwrap_or_else(now_label),
        ..Account::default()
    };
    let secrets = &inner.options.secrets;
    if !secrets.set(&account.secret_name("refresh"), &refresh) {
        return Err("Could not save the sign-in in the system credential store.");
    }
    match client.secret.as_deref().filter(|_| source == CLIENT_OWN) {
        Some(secret) => {
            if !secrets.set(&account.secret_name("client-secret"), secret) {
                return Err("Could not save the sign-in in the system credential store.");
            }
        }
        None => {
            secrets.delete(&account.secret_name("client-secret"));
        }
    }
    inner.tokens.forget(&account.id);
    inner
        .accounts
        .upsert(&account)
        .map_err(|_| "Could not save the account.")?;
    Ok(account.public_json(true))
}

pub fn google_status(inner: &Inner, flow: &str) -> ApiResponse {
    let flows = inner
        .flows
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    match flows.get(flow) {
        Some(Flow {
            state: FlowState::Pending,
            ..
        }) => ApiResponse::json(&json!({ "ok": true, "status": "pending" })),
        Some(Flow {
            state: FlowState::Connected(account),
            ..
        }) => ApiResponse::json(&json!({ "ok": true, "status": "connected", "account": account })),
        Some(Flow {
            state: FlowState::Failed(message),
            ..
        }) => ApiResponse::json(&json!({ "ok": true, "status": "failed", "error": message })),
        None => ApiResponse::error("This connection request expired."),
    }
}

pub fn google_cancel(inner: &Inner, flow: &str) -> ApiResponse {
    let mut flows = inner
        .flows
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(entry) = flows.get_mut(flow)
        && let Some(task) = entry.task.take()
    {
        task.abort();
        entry.state = FlowState::Failed("Google sign-in was cancelled.");
    }
    ApiResponse::json(&json!({ "ok": true }))
}

fn caldav_label(base: &reqwest::Url) -> String {
    let host = base.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.ends_with("icloud.com") {
        "iCloud".into()
    } else if host.ends_with("fastmail.com") {
        "Fastmail".into()
    } else {
        host
    }
}

pub async fn connect_caldav(inner: &Inner, body: &Value) -> ApiResponse {
    let Some(base) = caldav::validate_server_url(&text(body.get("serverUrl"))) else {
        return ApiResponse::error("Enter an https:// CalDAV server address.");
    };
    let username = text(body.get("username")).trim().to_string();
    // App passwords are often shown in groups; spaces are never part of one.
    let password: String = text(body.get("password"))
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if username.is_empty() || username.len() > 320 || password.is_empty() || password.len() > 1024 {
        return ApiResponse::error("Enter your user name and app password.");
    }
    let dav = CalDav::new(
        inner.options.transport.clone(),
        base.clone(),
        None,
        &username,
        &password,
    );
    let home = match dav.discover().await {
        Ok(home) => home,
        Err(ProviderError::Auth) => {
            return ApiResponse::error("The server rejected that user name or app password.");
        }
        Err(ProviderError::NotFound) => {
            return ApiResponse::error("No CalDAV calendars were found at that address.");
        }
        Err(_) => return ApiResponse::error("Could not reach that CalDAV server."),
    };
    let dav = CalDav::new(
        inner.options.transport.clone(),
        base.clone(),
        Some(home.clone()),
        &username,
        &password,
    );
    let collections = match dav.collections().await {
        Ok(collections) if !collections.is_empty() => collections,
        Ok(_) => return ApiResponse::error("No CalDAV calendars were found at that address."),
        Err(ProviderError::Auth) => {
            return ApiResponse::error("The server rejected that user name or app password.");
        }
        Err(_) => return ApiResponse::error("Could not reach that CalDAV server."),
    };
    let label = text(body.get("label"))
        .trim()
        .chars()
        .take(60)
        .collect::<String>();
    let existing = inner.accounts.list().into_iter().find(|account| {
        account.kind == KIND_CALDAV
            && account.username == username
            && account.server_url.as_deref() == Some(base.as_str())
    });
    let account = Account {
        id: existing
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        kind: KIND_CALDAV.into(),
        label: if label.is_empty() {
            caldav_label(&base)
        } else {
            label
        },
        username,
        server_url: Some(base.to_string()),
        home_url: Some(home.to_string()),
        calendars: true,
        reminders: true,
        created_at: existing
            .map(|account| account.created_at)
            .unwrap_or_else(now_label),
        ..Account::default()
    };
    if !inner
        .options
        .secrets
        .set(&account.secret_name("password"), &password)
    {
        return ApiResponse::error("Could not save the password in the system credential store.");
    }
    if inner.accounts.upsert(&account).is_err() {
        return ApiResponse::error("Could not save the account.");
    }
    ApiResponse::json(&json!({
        "ok": true,
        "account": account.public_json(true),
        "calendars": collections.iter().filter(|collection| collection.events).count(),
        "lists": collections.iter().filter(|collection| collection.todos).count(),
    }))
}

pub fn remove(inner: &Inner, body: &Value) -> ApiResponse {
    let id = text(body.get("id"));
    let Some(account) = inner.accounts.get(&id) else {
        return ApiResponse::error("That account is not connected.");
    };
    for purpose in ["refresh", "client-secret", "password"] {
        inner.options.secrets.delete(&account.secret_name(purpose));
    }
    inner.tokens.forget(&account.id);
    match inner.accounts.remove(&account.id) {
        Ok(_) => ApiResponse::json(&json!({ "ok": true })),
        Err(_) => ApiResponse::error("Could not remove the account."),
    }
}
