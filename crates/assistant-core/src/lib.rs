//! UI-independent Codex and voice sessions. Credentials never cross the native boundary.
pub mod agent;
pub mod auth;
pub mod bridge;
pub mod codex;
pub mod interview;
mod interview_audio;
mod interview_session;
mod interview_speakers;
pub mod provider;
pub mod session;
pub mod speakers;
pub use session::{SessionConfig, SessionInput, run, status};

pub mod workspace;
