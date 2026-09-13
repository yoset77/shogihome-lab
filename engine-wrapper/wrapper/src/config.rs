//! Engine configuration loading.
//!
//! `engines.json` is reloaded for every discovery/selection request (not
//! cached at startup), matching both previous implementations. Entries are
//! kept as `serde_json::Value` so unknown fields, entry order, and legacy
//! `type` forms survive the `list` round-trip untouched; the server (not the
//! wrapper) strips private fields.

use serde_json::Value;
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
}
