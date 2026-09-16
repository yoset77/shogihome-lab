//! Typed errors for the launcher backend.
//!
//! Every fallible `shogihome-launcher` API returns [`LauncherError`] instead
//! of a bare `String`. Messages stay byte-identical to the legacy strings so
//! the UI and tests observe no change, while `Io`/`Json` variants preserve
//! the source chain (`#[source]`) that `map_err(|e| e.to_string())` used to
//! discard. The Tauri IPC boundary still speaks `String` via
//! `impl From<LauncherError> for String`, so only this crate changes.

use std::io;

/// Fallible launcher-backend result.
pub type Result<T> = std::result::Result<T, LauncherError>;

/// Typed launcher-backend error.
#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    /// Plain message (legacy `String` errors map here verbatim).
    #[error("{0}")]
    Message(String),
    /// Filesystem failure with the operation being attempted.
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    /// JSON failure with the file or payload being parsed.
    #[error("{context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },
    /// Engine registry validation failure (including duplicate ids).
    #[error("invalid engines.json: {0}")]
    Engines(String),
    /// Settings validation failure; payload is the legacy
    /// `"Invalid settings: a, b"` text.
    #[error("{0}")]
    InvalidSettings(String),
}

impl LauncherError {
    /// Plain message error, preserving a legacy string verbatim.
    pub fn msg(s: impl Into<String>) -> Self {
        Self::Message(s.into())
    }

    /// Filesystem failure while doing `context` (e.g. `"reading .env"`).
    pub fn io(context: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    /// JSON failure while parsing `context` (e.g. a file path).
    pub fn json(context: impl Into<String>, source: serde_json::Error) -> Self {
        Self::Json {
            context: context.into(),
            source,
        }
    }
}

impl From<String> for LauncherError {
    fn from(s: String) -> Self {
        Self::Message(s)
    }
}

impl From<&str> for LauncherError {
    fn from(s: &str) -> Self {
        Self::Message(s.to_string())
    }
}

// `#[from]` cannot be used on struct-variant fields, so these are manual.
// Bare `?` on `io::Result`/`serde_json::Result` keeps working; call sites
// with a path at hand should prefer `LauncherError::io/json` for context.
impl From<io::Error> for LauncherError {
    fn from(source: io::Error) -> Self {
        Self::Io {
            context: "I/O error".to_string(),
            source,
        }
    }
}

impl From<serde_json::Error> for LauncherError {
    fn from(source: serde_json::Error) -> Self {
        Self::Json {
            context: "JSON error".to_string(),
            source,
        }
    }
}

impl From<LauncherError> for String {
    fn from(e: LauncherError) -> Self {
        e.to_string()
    }
}

impl From<crate::editor::ProbeError> for LauncherError {
    fn from(e: crate::editor::ProbeError) -> Self {
        Self::Message(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_survive_round_trip_to_ipc_strings() {
        let err: LauncherError = "launcher is quitting".into();
        assert_eq!(String::from(err), "launcher is quitting");
        let err = LauncherError::msg(format!("duplicate engine id '{id}'", id = "a"));
        assert_eq!(err.to_string(), "duplicate engine id 'a'");
        // Source chains are preserved instead of flattened.
        let io_err = LauncherError::io(
            "reading .env",
            io::Error::new(io::ErrorKind::NotFound, "missing"),
        );
        assert_eq!(format!("{io_err}"), "reading .env: missing");
        assert!(std::error::Error::source(&io_err).is_some());
    }

    #[test]
    fn question_mark_converts_io_and_json() {
        fn read(path: &std::path::Path) -> Result<String> {
            Ok(std::fs::read_to_string(path)?)
        }
        fn parse(s: &str) -> Result<serde_json::Value> {
            Ok(serde_json::from_str(s)?)
        }
        assert!(read(std::path::Path::new("/nonexistent-shogihome-test")).is_err());
        assert!(parse("not json").is_err());
    }
}
