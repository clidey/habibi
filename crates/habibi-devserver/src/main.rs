//! `habibi-devserver`: the launcher UI and `/api/*` on
//! `http://127.0.0.1:$HABIBI_PORT` for development and docs tooling only.
//!
//! ```sh
//! HABIBI_DATA_ROOT=$(mktemp -d) cargo run -p habibi-devserver
//! ```

use std::process::ExitCode;

use habibi_devserver::{Config, DevServer, isolate_credentials, security, serve};

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env(|name| std::env::var_os(name)).and_then(Config::prepare) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("habibi-devserver: {message}");
            return ExitCode::from(2);
        }
    };
    isolate_credentials();
    // Loopback only, never 0.0.0.0: this is not a network service.
    let listener = match tokio::net::TcpListener::bind((security::HOST, config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "habibi-devserver: cannot listen on {}:{}: {error}. Another dev server is probably already running.",
                security::HOST,
                config.port
            );
            return ExitCode::FAILURE;
        }
    };
    let server = DevServer::new(&config);
    eprintln!(
        "habibi-devserver: http://{}:{} (state {}, home {}). Development only; credentials are in memory.",
        security::HOST,
        config.port,
        config.state_root.display(),
        config.home.display()
    );
    let result = tokio::select! {
        result = serve(listener, server.clone()) => result,
        () = shutdown_signal() => Ok(()),
    };
    server.shutdown().await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("habibi-devserver: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
