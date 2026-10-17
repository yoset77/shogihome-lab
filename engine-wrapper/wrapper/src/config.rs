//! Engine configuration loading.
//!
//! `engines.json` is reloaded for every discovery/selection request (not
//! cached at startup), matching both previous implementations. Entries are
//! kept as `serde_json::Value` so unknown fields, entry order, and legacy
//! `type` forms survive the `list` round-trip untouched; the server (not the
//! wrapper) strips private fields.
//!
//! The root may be a legacy array or a v2 `{ "resources": ..., "engines":
//! [...] }` object. The wrapper only consumes the engine entries; resource
//! settings are forwarded verbatim through `list` for the server to enforce.

use serde_json::Value;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

const MIN_ACCESS_TOKEN_CHARS: usize = 32;

/// Resolve the configuration root: explicit `--config-dir` wins, otherwise
/// `<exe-dir>/engine-wrapper` when it holds `engines.json` (portable ZIP
/// layout, shared with the launcher editor default), else the directory
/// containing the executable. The process CWD is never used implicitly.
pub fn resolve_config_dir(exe_path: &Path, override_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = override_dir {
        return std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    }
    let exe_dir = exe_path.parent().map(Path::to_path_buf);
    if let Some(ref dir) = exe_dir {
        if dir.join("engine-wrapper").join("engines.json").is_file() {
            return dir.join("engine-wrapper");
        }
    }
    exe_dir.unwrap_or_else(|| PathBuf::from("."))
}

/// Load the parsed registry document as-is (any JSON value).
pub fn load_engines_document(config_dir: &Path) -> Result<Value, String> {
    let path = config_dir.join("engines.json");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("engines.json not available at {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("failed to parse engines.json: {e}"))
}

/// Extract the engine array from either root form.
pub fn extract_engines(document: &Value) -> Result<Vec<Value>, String> {
    match document {
        Value::Array(entries) => Ok(entries.clone()),
        Value::Object(map) => match map.get("engines") {
            Some(Value::Array(entries)) => Ok(entries.clone()),
            Some(_) => Err("engines.json 'engines' must be an array".to_string()),
            None => Err("engines.json object root must contain 'engines'".to_string()),
        },
        _ => Err("engines.json root must be an array or an object with 'engines'".to_string()),
    }
}

/// Load the engine array. Returns an empty vec when the file is missing
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
    let document = load_engines_document(config_dir)?;
    extract_engines(&document)
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

/// Resolved TCP/auth and engine process settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub bind: String,
    pub port: u16,
    pub token: Option<String>,
    pub engine_high_qos: bool,
}

/// Resolve runtime settings with the documented precedence:
///
/// CLI > process environment > `<config_dir>/.env` > defaults.
///
/// An environment variable that is already set — even to the empty
/// string — always wins over the `.env` file. An empty
/// `WRAPPER_ACCESS_TOKEN` disables authentication on loopback only; nonempty
/// tokens must have at least 32 characters and not be all whitespace. An empty
/// `ENGINE_HIGH_QOS` disables HighQoS from any source.
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
    // selects no token instead of falling back to the file.
    let token = if env.contains_key("WRAPPER_ACCESS_TOKEN") {
        env.get("WRAPPER_ACCESS_TOKEN")
            .filter(|t| !t.is_empty())
            .cloned()
    } else {
        file.get("WRAPPER_ACCESS_TOKEN")
            .filter(|t| !t.is_empty())
            .cloned()
    };
    if let Some(token) = &token {
        if token.chars().count() < MIN_ACCESS_TOKEN_CHARS || token.chars().all(char::is_whitespace)
        {
            return Err(format!(
                "WRAPPER_ACCESS_TOKEN must contain at least {MIN_ACCESS_TOKEN_CHARS} characters and must not be only whitespace"
            ));
        }
    }
    let high_qos_raw = env
        .get("ENGINE_HIGH_QOS")
        .or_else(|| file.get("ENGINE_HIGH_QOS"))
        .map(String::as_str)
        .unwrap_or("");
    let engine_high_qos = match high_qos_raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => true,
        "false" | "0" | "no" | "off" | "" => false,
        _ => {
            return Err(format!(
                "invalid ENGINE_HIGH_QOS value {high_qos_raw:?}: expected true/false, 1/0, yes/no, on/off, or empty"
            ))
        }
    };
    Ok(RuntimeConfig {
        bind,
        port,
        token,
        engine_high_qos,
    })
}

/// Check the actual listener address before accepting clients or reporting readiness.
/// Token shape is validated by `resolve_runtime`, independently of the bind address.
pub fn validate_bind_auth(address: IpAddr, auth_enabled: bool) -> Result<(), String> {
    let loopback = match address {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map_or_else(|| ip.is_loopback(), |ip| ip.is_loopback()),
    };
    if !loopback && !auth_enabled {
        return Err(format!(
            "WRAPPER_ACCESS_TOKEN is required for non-loopback listener {address}"
        ));
    }
    Ok(())
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
    fn resolve_prefers_bundled_engine_wrapper_dir() {
        let root = std::env::temp_dir().join(format!("wrapper-resolve-{}", std::process::id()));
        let exe = root.join("wrapper");
        let bundled = root.join("engine-wrapper");
        std::fs::create_dir_all(&bundled).unwrap();
        // Sibling dir alone is not enough; engines.json selects the layout.
        assert_eq!(resolve_config_dir(&exe, None), root);
        std::fs::write(bundled.join("engines.json"), "[]").unwrap();
        assert_eq!(resolve_config_dir(&exe, None), bundled);
        // Explicit override still wins over the bundled layout.
        assert_eq!(
            resolve_config_dir(&exe, Some(Path::new("/cfg"))),
            PathBuf::from("/cfg")
        );
        std::fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn engines_load_from_legacy_array_and_v2_object_roots() {
        let dir = std::env::temp_dir().join(format!("wrapper-roots-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Legacy array root.
        std::fs::write(dir.join("engines.json"), r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
        let engines = load_engines(&dir);
        assert_eq!(engines.len(), 2);
        // v2 object root: engine entries are extracted, resources untouched.
        std::fs::write(
            dir.join("engines.json"),
            r#"{"resources":{"enabled":true,"groups":[{"id":"g","name":"G","budget":8}]},"engines":[{"id":"a"}]}"#,
        )
        .unwrap();
        let engines = load_engines(&dir);
        assert_eq!(engines.len(), 1);
        assert_eq!(engines[0]["id"], serde_json::json!("a"));
        // An object root without an engines array is an error.
        std::fs::write(dir.join("engines.json"), r#"{"resources":{}}"#).unwrap();
        assert!(load_engines(&dir).is_empty());
        // The document loader still forwards the raw object for `list`.
        assert!(load_engines_document(&dir)
            .unwrap()
            .get("resources")
            .is_some());
        std::fs::remove_dir_all(dir).unwrap();
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
                engine_high_qos: false,
            }
        );
    }

    #[test]
    fn runtime_precedence_cli_over_env_over_file() {
        let env = str_map(&[("BIND_ADDRESS", "10.0.0.1"), ("LISTEN_PORT", "5001")]);
        let file = str_map(&[
            ("BIND_ADDRESS", "10.0.0.2"),
            ("LISTEN_PORT", "5002"),
            (
                "WRAPPER_ACCESS_TOKEN",
                "file-token-with-at-least-32-characters",
            ),
        ]);
        // Env beats file.
        let cfg = resolve_runtime(None, None, &env, &file).unwrap();
        assert_eq!(cfg.bind, "10.0.0.1");
        assert_eq!(cfg.port, 5001);
        assert_eq!(
            cfg.token.as_deref(),
            Some("file-token-with-at-least-32-characters")
        );
        // CLI beats both.
        let cfg = resolve_runtime(Some("10.0.0.9".to_string()), Some(5009), &env, &file).unwrap();
        assert_eq!(cfg.bind, "10.0.0.9");
        assert_eq!(cfg.port, 5009);
        // File alone supplies everything.
        let cfg = resolve_runtime(None, None, &HashMap::new(), &file).unwrap();
        assert_eq!(cfg.bind, "10.0.0.2");
        assert_eq!(cfg.port, 5002);
        assert_eq!(
            cfg.token.as_deref(),
            Some("file-token-with-at-least-32-characters")
        );
    }

    #[test]
    fn runtime_empty_env_token_disables_auth() {
        let env = str_map(&[("WRAPPER_ACCESS_TOKEN", "")]);
        let file = str_map(&[(
            "WRAPPER_ACCESS_TOKEN",
            "file-token-with-at-least-32-characters",
        )]);
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
    fn runtime_validates_token_characters_without_normalizing_or_leaking_it() {
        for token in [
            "x".repeat(31),
            "あ".repeat(31),
            " ".repeat(32),
            "\u{3000}".repeat(32),
        ] {
            for bind in ["127.0.0.1", "0.0.0.0"] {
                let error = resolve_runtime(
                    Some(bind.into()),
                    None,
                    &str_map(&[("WRAPPER_ACCESS_TOKEN", &token)]),
                    &HashMap::new(),
                )
                .unwrap_err();
                assert!(error.contains("WRAPPER_ACCESS_TOKEN"));
                assert!(!error.contains(&token));
            }
        }
        for token in [
            "x".repeat(32),
            "あ".repeat(32),
            format!(" {} ", "x".repeat(32)),
        ] {
            let cfg = resolve_runtime(
                None,
                None,
                &str_map(&[("WRAPPER_ACCESS_TOKEN", &token)]),
                &HashMap::new(),
            )
            .unwrap();
            assert_eq!(cfg.token.as_deref(), Some(token.as_str()));
        }
    }

    #[test]
    fn invalid_environment_token_does_not_fall_back_to_valid_file_token() {
        let file = str_map(&[(
            "WRAPPER_ACCESS_TOKEN",
            "file-token-with-at-least-32-characters",
        )]);
        assert!(resolve_runtime(
            None,
            None,
            &str_map(&[("WRAPPER_ACCESS_TOKEN", "short")]),
            &file
        )
        .is_err());
        assert!(resolve_runtime(
            None,
            None,
            &HashMap::new(),
            &str_map(&[("WRAPPER_ACCESS_TOKEN", "short")])
        )
        .is_err());
    }

    #[test]
    fn only_loopback_listeners_allow_missing_auth() {
        for address in ["127.0.0.1", "127.42.1.2", "::1", "::ffff:127.0.0.1"] {
            assert!(
                validate_bind_auth(address.parse().unwrap(), false).is_ok(),
                "{address}"
            );
        }
        for address in [
            "0.0.0.0",
            "::",
            "192.168.1.1",
            "10.0.0.1",
            "169.254.1.1",
            "::ffff:192.168.1.1",
            "fd00::1",
            "2001:db8::1",
        ] {
            let ip = address.parse().unwrap();
            assert!(validate_bind_auth(ip, false).is_err(), "{address}");
            assert!(validate_bind_auth(ip, true).is_ok(), "{address}");
        }
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

    #[test]
    fn high_qos_is_opt_in_and_environment_presence_overrides_file() {
        let file = str_map(&[("ENGINE_HIGH_QOS", "true")]);
        assert!(
            !resolve_runtime(None, None, &HashMap::new(), &HashMap::new())
                .unwrap()
                .engine_high_qos
        );
        assert!(
            resolve_runtime(None, None, &HashMap::new(), &file)
                .unwrap()
                .engine_high_qos
        );
        for value in ["false", "0", "no", "off", ""] {
            assert!(
                !resolve_runtime(None, None, &str_map(&[("ENGINE_HIGH_QOS", value)]), &file)
                    .unwrap()
                    .engine_high_qos
            );
        }
        for value in ["TRUE", " 1 ", "yes", "On"] {
            assert!(
                resolve_runtime(
                    None,
                    None,
                    &str_map(&[("ENGINE_HIGH_QOS", value)]),
                    &HashMap::new()
                )
                .unwrap()
                .engine_high_qos
            );
        }
    }

    #[test]
    fn invalid_high_qos_value_fails_configuration() {
        let file = str_map(&[("ENGINE_HIGH_QOS", "maybe")]);
        assert!(resolve_runtime(None, None, &HashMap::new(), &file)
            .unwrap_err()
            .contains("ENGINE_HIGH_QOS"));
        // A present environment value replaces even an invalid file value.
        assert!(
            !resolve_runtime(None, None, &str_map(&[("ENGINE_HIGH_QOS", "")]), &file)
                .unwrap()
                .engine_high_qos
        );
    }
}
