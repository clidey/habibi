//! Network transports: implicit-TLS IMAP (993) and SMTP (465), both with
//! rustls and the OS certificate verifier. Tests swap in a [`Connector`] that
//! talks to a local mock server instead.

use std::fmt::Debug;
use std::net::Ipv4Addr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::extension::ClientId;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

pub trait ImapIo: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> ImapIo for T {}

pub type ImapStream = Box<dyn ImapIo>;

#[async_trait]
pub trait Connector: Send + Sync {
    /// A connected, encrypted stream to an IMAP server.
    async fn imap(&self, host: &str, port: u16) -> std::io::Result<ImapStream>;
    /// Submit `message` over SMTP, authenticated as `user`.
    async fn smtp(&self, host: &str, port: u16, user: &str, password: &str, message: Message) -> Result<(), ()>;
}

pub struct TlsConnector;

fn tls_config() -> Option<Arc<rustls::ClientConfig>> {
    static CONFIG: OnceLock<Option<Arc<rustls::ClientConfig>>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            // Name the provider explicitly: another crate in the app may enable a
            // second rustls backend, and then there is no process default.
            let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let verifier = rustls_platform_verifier::Verifier::new(Arc::clone(&provider)).ok()?;
            let config = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .ok()?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth();
            Some(Arc::new(config))
        })
        .clone()
}

#[async_trait]
impl Connector for TlsConnector {
    async fn imap(&self, host: &str, port: u16) -> std::io::Result<ImapStream> {
        let config = tls_config().ok_or_else(|| std::io::Error::other("TLS is unavailable"))?;
        let name = rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid host"))?;
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))??;
        let tls = tokio::time::timeout(CONNECT_TIMEOUT, tokio_rustls::TlsConnector::from(config).connect(name, tcp))
            .await
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))??;
        Ok(Box::new(tls))
    }

    async fn smtp(&self, host: &str, port: u16, user: &str, password: &str, message: Message) -> Result<(), ()> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .map_err(|_| ())?
            .port(port)
            .credentials(Credentials::new(user.into(), password.into()))
            // nodemailer greeted with `[127.0.0.1]` unless the hostname was a FQDN.
            .hello_name(ClientId::Ipv4(Ipv4Addr::LOCALHOST))
            .timeout(Some(Duration::from_secs(60)))
            .build();
        transport.send(message).await.map(|_| ()).map_err(|_| ())
    }
}
