//! The contract every Habibi service is written against.
//!
//! The browser UI still speaks the `/api/*` JSON routes it always has. In the
//! Tauri shell those requests never touch a network socket: the webview hands
//! them to Rust over IPC (or the app's custom URI scheme) and they are routed
//! through [`Routes`] implementations. Services therefore stay free of Tauri
//! and are unit-testable on their own.

pub mod api;
pub mod approvals;
pub mod paths;
pub mod services;

pub use api::{ApiRequest, ApiResponse, Method, Routes, Router};
pub use approvals::{Approval, ApprovalService};
pub use paths::Paths;
