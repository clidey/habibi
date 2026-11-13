//! The loopback half of the OAuth installed-app flow (RFC 8252): listen on
//! an ephemeral `127.0.0.1` port, accept exactly one redirect carrying the
//! expected `state`, and show the browser a short fixed page.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const CALLBACK_PATH: &str = "/callback";
const MAX_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackError {
    /// The user declined consent (or the provider reported an error).
    Denied,
    /// Nothing arrived before the deadline.
    TimedOut,
}

/// Bind the loopback listener. Returns it with its redirect URI.
pub async fn bind() -> std::io::Result<(TcpListener, String)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    Ok((listener, format!("http://127.0.0.1:{port}{CALLBACK_PATH}")))
}

/// The query of a `GET /callback?...` request line, if that is what it is.
fn callback_query(head: &str) -> Option<Vec<(String, String)>> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    let (method, target) = (parts.next()?, parts.next()?);
    if method != "GET" {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    (path == CALLBACK_PATH).then(|| {
        form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect()
    })
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n")
            || buffer.len() >= MAX_REQUEST_BYTES
        {
            break;
        }
    }
    String::from_utf8(buffer).ok()
}

async fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Habibi Calendar</title><body style=\"font-family:system-ui,sans-serif;padding:40px\">{message}</body>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The browser-facing outcome of a finished exchange.
pub struct Finish {
    pub stream: TcpStream,
}

impl Finish {
    pub async fn done(mut self, connected: bool) {
        let message = if connected {
            "Calendar connected. You can close this tab and return to Habibi."
        } else {
            "Habibi could not connect this calendar. Return to Habibi and try again."
        };
        respond(
            &mut self.stream,
            if connected {
                "200 OK"
            } else {
                "400 Bad Request"
            },
            message,
        )
        .await;
    }
}

/// Wait for the redirect carrying `state`. Requests for other paths (a
/// favicon) or with a different state are answered and ignored, so a stray
/// or forged request cannot end the flow. Returns the code plus the open
/// connection, so the page can report the real result once the code has
/// been exchanged.
pub async fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    deadline: Duration,
) -> Result<(String, Finish), CallbackError> {
    let work = async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            };
            let Some(head) = read_head(&mut stream).await else {
                continue;
            };
            let Some(query) = callback_query(&head) else {
                respond(&mut stream, "404 Not Found", "Not found.").await;
                continue;
            };
            let value = |key: &str| {
                query
                    .iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value.clone())
            };
            if value("state").as_deref() != Some(state) {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "This sign-in link is not the one Habibi is waiting for.",
                )
                .await;
                continue;
            }
            if value("error").is_some() {
                respond(
                    &mut stream,
                    "200 OK",
                    "Sign-in was cancelled. You can close this tab.",
                )
                .await;
                return Err(CallbackError::Denied);
            }
            match value("code").filter(|code| !code.is_empty() && code.len() <= 4096) {
                Some(code) => return Ok((code, Finish { stream })),
                None => {
                    respond(
                        &mut stream,
                        "400 Bad Request",
                        "The sign-in response was incomplete.",
                    )
                    .await
                }
            }
        }
    };
    tokio::time::timeout(deadline, work)
        .await
        .unwrap_or(Err(CallbackError::TimedOut))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(redirect: &str, target: &str) -> String {
        let address = redirect
            .trim_start_matches("http://")
            .trim_end_matches(CALLBACK_PATH)
            .to_string();
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response).await;
        response
    }

    #[tokio::test]
    async fn accepts_only_the_matching_state_on_the_callback_path() {
        let (listener, redirect) = bind().await.unwrap();
        assert!(redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/callback"));
        let waiter = tokio::spawn(async move {
            let (code, finish) = wait_for_code(&listener, "good", Duration::from_secs(5))
                .await
                .unwrap();
            finish.done(true).await;
            code
        });
        assert!(
            get(&redirect, "/favicon.ico")
                .await
                .starts_with("HTTP/1.1 404")
        );
        assert!(
            get(&redirect, "/callback?state=forged&code=evil")
                .await
                .starts_with("HTTP/1.1 400")
        );
        let page = get(&redirect, "/callback?state=good&code=4%2Fabc&scope=x").await;
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("Calendar connected"));
        assert_eq!(waiter.await.unwrap(), "4/abc");
    }

    #[tokio::test]
    async fn reports_denial_and_timeouts() {
        let (listener, redirect) = bind().await.unwrap();
        let waiter = tokio::spawn(async move {
            wait_for_code(&listener, "s", Duration::from_secs(5))
                .await
                .map(|(code, _)| code)
        });
        get(&redirect, "/callback?state=s&error=access_denied").await;
        assert_eq!(waiter.await.unwrap(), Err(CallbackError::Denied));

        let (listener, _) = bind().await.unwrap();
        let result = wait_for_code(&listener, "s", Duration::from_millis(50))
            .await
            .map(|(code, _)| code);
        assert_eq!(result, Err(CallbackError::TimedOut));
    }
}
