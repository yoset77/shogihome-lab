//! Engine configuration loading.
//!
//! `engines.json` is reloaded for every discovery/selection request (not
//! cached at startup), matching both previous implementations. Entries are
//! kept as `serde_json::Value` so unknown fields, entry order, and legacy
//! `type` forms survive the `list` round-trip untouched; the server (not the
//! wrapper) strips private fields.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Resolve the configuration root: explicit `--config-dir` wins, otherwise
/// the directory containing the executable (portable ZIP layout). The process
/// CWD is never used implicitly.
pub fn resolve_config_dir(exe_path: &Path, override_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = override_dir {
        return std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    }
    exe_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Load the raw engine array. Returns an empty vec when the file is missing
/// or unparsable (and logs the reason via the returned error string).
pub fn load_engines(config_dir: &Path) -> Vec<Value> {
    match load_engines_result(config_dir) {
        Ok(engines) => engines,
        Err(err) => {
            log::warn_compat(&err);
            Vec::new()
        }
    }
}

fn load_engines_result(config_dir: &Path) -> Result<Vec<Value>, String> {
    let path = config_dir.join("engines.json");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("engines.json not available at {}: {e}", path.display()))?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("failed to parse engines.json: {e}"))?;
    match value {
        Value::Array(entries) => Ok(entries),
        _ => Err("engines.json root must be an array".to_string()),
    }
}

/// Find an engine entry by id. Entries without a string id never match.
pub fn find_engine<'a>(engines: &'a [Value], id: &str) -> Option<&'a Value> {
    engines
        .iter()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
}

/// Resolve the engine executable path: absolute paths unchanged, relative
/// paths resolved against the config dir. Returns the path and its parent
/// directory (used as the engine working directory).
pub fn resolve_engine_path(config_dir: &Path, path_str: &str) -> Option<(PathBuf, PathBuf)> {
    if path_str.is_empty() {
        return None;
    }
    let path = PathBuf::from(path_str);
    let abs = if path.is_absolute() {
        path
    } else {
        config_dir.join(path)
    };
    let parent = abs
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| config_dir.to_path_buf());
    Some((abs, parent))
}

/// Serialize one configured option to a USI command line (without trailing
/// newline). Booleans become `true`/`false`. Numbers and strings pass
/// through. Null and composite values are skipped (hardening over the old
/// `str(value)`/`String(value)` stringification). Names/values containing
/// CR or LF are rejected to prevent command injection.
pub fn format_option(name: &str, value: &Value) -> Option<String> {
    if name.contains('\n') || name.contains('\r') {
        return None;
    }
    let value_str = match value {
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Null | Value::Array(_) | Value::Object(_) => return None,
    };
    if value_str.contains('\n') || value_str.contains('\r') {
        return None;
    }
    Some(format!("setoption name {name} value {value_str}"))
}

/// Resolved TCP/auth settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub bind: String,
    pub port: u16,
    pub token: Option<String>,
}

/// Resolve runtime settings with the documented precedence:
///
/// CLI > process environment > `<config_dir>/.env` > defaults.
///
/// This mirrors `engine_wrapper.py` (`load_dotenv` without override):
/// an environment variable that is already set — even to the empty
/// string — always wins over the `.env` file. An empty
/// `WRAPPER_ACCESS_TOKEN` disables authentication from any source.
/// `${VAR}` interpolation is NOT expanded; file values are literal.
pub fn resolve_runtime(
    cli_bind: Option<String>,
    cli_port: Option<u16>,
    env: &HashMap<String, String>,
    file: &HashMap<String, String>,
) -> Result<RuntimeConfig, String> {
    let bind = cli_bind
        .or_else(|| env.get("BIND_ADDRESS").cloned())
        .or_else(|| file.get("BIND_ADDRESS").cloned())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port_raw = cli_port.map(|p| p.to_string()).or_else(|| {
        env.get("LISTEN_PORT")
            .cloned()
            .or_else(|| file.get("LISTEN_PORT").cloned())
    });
    let port = match port_raw {
        None => 4082,
        Some(raw) => raw
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("invalid LISTEN_PORT value {raw:?}: must be 1-65535"))?,
    };
    // Presence wins (even empty): an explicitly exported empty token
    // disables authentication instead of falling back to the file.
    let token = if env.contains_key("WRAPPER_ACCESS_TOKEN") {
        env.get("WRAPPER_ACCESS_TOKEN")
            .filter(|t| !t.is_empty())
            .cloned()
    } else {
        file.get("WRAPPER_ACCESS_TOKEN")
            .filter(|t| !t.is_empty())
            .cloned()
    };
    Ok(RuntimeConfig { bind, port, token })
}

/// Minimal logger shim: the wrapper logs to stderr without a logging
/// dependency to keep the dependency list small.
pub mod log {
    pub fn info(msg: &str) {
        eprintln!("[{}] {msg}", timestamp());
    }

    pub fn warn_compat(msg: &str) {
        eprintln!("[{}] WARN {msg}", timestamp());
    }

    fn timestamp() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{secs}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_prefers_override_and_ignores_cwd() {
        let dir = resolve_config_dir(Path::new("/app/wrapper"), Some(Path::new("/cfg")));
        assert_eq!(dir, PathBuf::from("/cfg"));
        let dir = resolve_config_dir(Path::new("/app/wrapper"), None);
        assert_eq!(dir, PathBuf::from("/app"));
    }

    #[test]
    fn find_engine_matches_string_ids_only() {
        let engines = vec![json!({"id": "a"}), json!({"id": 1}), json!({"noid": true})];
        assert_eq!(find_engine(&engines, "a").unwrap()["id"], json!("a"));
        assert!(find_engine(&engines, "1").is_none());
        assert!(find_engine(&engines, "missing").is_none());
    }

    #[test]
    fn option_scalars_and_rejections() {
        assert_eq!(
            format_option("Threads", &json!(4)).as_deref(),
            Some("setoption name Threads value 4")
        );
        assert_eq!(
            format_option("USI_Ponder", &json!(true)).as_deref(),
            Some("setoption name USI_Ponder value true")
        );
        assert_eq!(
            format_option("Book", &json!("a.bin")).as_deref(),
            Some("setoption name Book value a.bin")
        );
        assert!(format_option("X", &Value::Null).is_none());
        assert!(format_option("X", &json!([1])).is_none());
        assert!(format_option("X", &json!({"a": 1})).is_none());
        assert!(format_option("Bad\nName", &json!(1)).is_none());
        assert!(format_option("X", &json!("a\nb")).is_none());
    }

    #[test]
    fn relative_paths_resolve_against_config_dir() {
        let (abs, parent) = resolve_engine_path(Path::new("/cfg"), "engines/foo").unwrap();
        assert_eq!(abs, PathBuf::from("/cfg/engines/foo"));
        assert_eq!(parent, PathBuf::from("/cfg/engines"));
        let (abs, _) = resolve_engine_path(Path::new("/cfg"), "/abs/foo").unwrap();
        assert_eq!(abs, PathBuf::from("/abs/foo"));
        assert!(resolve_engine_path(Path::new("/cfg"), "").is_none());
    }

    #[test]
    fn load_missing_file_yields_empty_list() {
        assert!(load_engines(Path::new("/nonexistent-config-dir-xyz")).is_empty());
    }

    fn str_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn runtime_defaults_without_any_source() {
        let cfg = resolve_runtime(None, None, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(
            cfg,
            RuntimeConfig {
                bind: "127.0.0.1".to_string(),
                port: 4082,
                token: None,
            }
        );
    }

    #[test]
    fn runtime_precedence_cli_over_env_over_file() {
        let env = str_map(&[("BIND_ADDRESS", "10.0.0.1"), ("LISTEN_PORT", "5001")]);
        let file = str_map(&[
            ("BIND_ADDRESS", "10.0.0.2"),
            ("LISTEN_PORT", "5002"),
            ("WRAPPER_ACCESS_TOKEN", "file-token"),
        ]);
        // Env beats file.
        let cfg = resolve_runtime(None, None, &env, &file).unwrap();
        assert_eq!(cfg.bind, "10.0.0.1");
        assert_eq!(cfg.port, 5001);
        assert_eq!(cfg.token.as_deref(), Some("file-token"));
        // CLI beats both.
        let cfg = resolve_runtime(Some("10.0.0.9".to_string()), Some(5009), &env, &file).unwrap();
        assert_eq!(cfg.bind, "10.0.0.9");
        assert_eq!(cfg.port, 5009);
        // File alone supplies everything.
        let cfg = resolve_runtime(None, None, &HashMap::new(), &file).unwrap();
        assert_eq!(cfg.bind, "10.0.0.2");
        assert_eq!(cfg.port, 5002);
        assert_eq!(cfg.token.as_deref(), Some("file-token"));
    }

    #[test]
    fn runtime_empty_env_token_disables_auth() {
        let env = str_map(&[("WRAPPER_ACCESS_TOKEN", "")]);
        let file = str_map(&[("WRAPPER_ACCESS_TOKEN", "file-token")]);
        let cfg = resolve_runtime(None, None, &env, &file).unwrap();
        assert_eq!(cfg.token, None);
        // Empty file token is also "unset".
        let cfg = resolve_runtime(
            None,
            None,
            &HashMap::new(),
            &str_map(&[("WRAPPER_ACCESS_TOKEN", "")]),
        )
        .unwrap();
        assert_eq!(cfg.token, None);
    }

    #[test]
    fn runtime_invalid_port_is_an_error() {
        assert!(resolve_runtime(
            None,
            None,
            &str_map(&[("LISTEN_PORT", "not-a-port")]),
            &HashMap::new(),
        )
        .is_err());
        assert!(resolve_runtime(
            None,
            None,
            &HashMap::new(),
            &str_map(&[("LISTEN_PORT", "99999")]),
        )
        .is_err());
    }
}
