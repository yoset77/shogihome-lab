//! Server settings schema and two-file persistence.
//!
//! Schema mirrors `server_settings.py` (ids, keys, types, defaults, ranges)
//! so the UI edits the same surface. Fixes vs the old code:
//! - booleans load correctly regardless of default (`env_codec` checks bool
//!   before int);
//! - `save` validates first (no file touched on error), writes each file
//!   atomically, and rolls back the first file when the second fails;
//! - `load` reports linked-key mismatches instead of silently hiding them.

use std::collections::HashMap;
use std::path::Path;

use crate::env_codec::{load_env_value, upsert_env_values, EnvValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingType {
    Int,
    Bool,
    Text,
    Choice,
    List,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvFile {
    Server,
    Wrapper,
}

#[derive(Debug, Clone)]
pub struct Setting {
    pub id: &'static str,
    pub keys: &'static [(&'static str, EnvFile)],
    pub setting_type: SettingType,
    pub default_int: i64,
    pub default_str: &'static str,
    pub default_bool: bool,
    pub section: &'static str,
    pub min_value: Option<i64>,
    pub max_value: Option<i64>,
    pub choices: &'static [&'static str],
    pub item_rule: Option<ListRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListRule {
    Origin,
    Domain,
}

pub const SECTION_BASIC: &str = "basic";
pub const SECTION_ENGINE: &str = "engine";
pub const SECTION_SECURITY: &str = "security";
pub const SECTION_KIFU: &str = "kifu";

pub const SETTINGS: &[Setting] = &[
    Setting { id: "PORT", keys: &[("PORT", EnvFile::Server)], setting_type: SettingType::Int, default_int: 8140, default_str: "", default_bool: false, section: SECTION_BASIC, min_value: Some(1), max_value: Some(65535), choices: &[], item_rule: None },
    Setting { id: "BIND_ADDRESS", keys: &[("BIND_ADDRESS", EnvFile::Server)], setting_type: SettingType::Choice, default_int: 0, default_str: "0.0.0.0", default_bool: false, section: SECTION_BASIC, min_value: None, max_value: None, choices: &["0.0.0.0", "127.0.0.1"], item_rule: None },
    Setting { id: "ENGINE_CONNECTION_PROTECTION_TIMEOUT", keys: &[("ENGINE_CONNECTION_PROTECTION_TIMEOUT", EnvFile::Server)], setting_type: SettingType::Int, default_int: 60, default_str: "", default_bool: false, section: SECTION_BASIC, min_value: Some(1), max_value: Some(3600), choices: &[], item_rule: None },
    Setting { id: "LISTEN_PORT", keys: &[("LISTEN_PORT", EnvFile::Wrapper), ("REMOTE_ENGINE_PORT", EnvFile::Server)], setting_type: SettingType::Int, default_int: 4082, default_str: "", default_bool: false, section: SECTION_ENGINE, min_value: Some(1), max_value: Some(65535), choices: &[], item_rule: None },
    Setting { id: "ALLOWED_ORIGINS", keys: &[("ALLOWED_ORIGINS", EnvFile::Server)], setting_type: SettingType::List, default_int: 0, default_str: "", default_bool: false, section: SECTION_SECURITY, min_value: None, max_value: None, choices: &[], item_rule: Some(ListRule::Origin) },
    Setting { id: "DISABLE_AUTO_ALLOWED_ORIGINS", keys: &[("DISABLE_AUTO_ALLOWED_ORIGINS", EnvFile::Server)], setting_type: SettingType::Bool, default_int: 0, default_str: "", default_bool: false, section: SECTION_SECURITY, min_value: None, max_value: None, choices: &[], item_rule: None },
    Setting { id: "TRUST_PROXY", keys: &[("TRUST_PROXY", EnvFile::Server)], setting_type: SettingType::Bool, default_int: 0, default_str: "", default_bool: false, section: SECTION_SECURITY, min_value: None, max_value: None, choices: &[], item_rule: None },
    Setting { id: "WRAPPER_ACCESS_TOKEN", keys: &[("WRAPPER_ACCESS_TOKEN", EnvFile::Wrapper), ("WRAPPER_ACCESS_TOKEN", EnvFile::Server)], setting_type: SettingType::Text, default_int: 0, default_str: "", default_bool: false, section: SECTION_SECURITY, min_value: None, max_value: None, choices: &[], item_rule: None },
    Setting { id: "ALLOWED_FETCH_DOMAINS", keys: &[("ALLOWED_FETCH_DOMAINS", EnvFile::Server)], setting_type: SettingType::List, default_int: 0, default_str: "sunfish-shogi.github.io,live4.computer-shogi.org,www.computer-shogi.org,wdoor.c.u-tokyo.ac.jp", default_bool: false, section: SECTION_SECURITY, min_value: None, max_value: None, choices: &[], item_rule: Some(ListRule::Domain) },
    Setting { id: "KIFU_DIR", keys: &[("KIFU_DIR", EnvFile::Server)], setting_type: SettingType::Text, default_int: 0, default_str: "", default_bool: false, section: SECTION_KIFU, min_value: None, max_value: None, choices: &[], item_rule: None },
    Setting { id: "KIFU_DIR_USE_POLLING", keys: &[("KIFU_DIR_USE_POLLING", EnvFile::Server)], setting_type: SettingType::Bool, default_int: 0, default_str: "", default_bool: false, section: SECTION_KIFU, min_value: None, max_value: None, choices: &[], item_rule: None },
    Setting { id: "ANALYSIS_DB_MIN_DEPTH", keys: &[("ANALYSIS_DB_MIN_DEPTH", EnvFile::Server)], setting_type: SettingType::Int, default_int: 10, default_str: "", default_bool: false, section: SECTION_KIFU, min_value: Some(0), max_value: Some(100), choices: &[], item_rule: None },
    Setting { id: "ONTHEFLY_THRESHOLD_MB", keys: &[("ONTHEFLY_THRESHOLD_MB", EnvFile::Server)], setting_type: SettingType::Int, default_int: 128, default_str: "", default_bool: false, section: SECTION_KIFU, min_value: Some(1), max_value: Some(100000), choices: &[], item_rule: None },
    Setting { id: "SBK_ONTHEFLY_THRESHOLD_MB", keys: &[("SBK_ONTHEFLY_THRESHOLD_MB", EnvFile::Server)], setting_type: SettingType::Int, default_int: 32, default_str: "", default_bool: false, section: SECTION_KIFU, min_value: Some(1), max_value: Some(100000), choices: &[], item_rule: None },
];

pub const SECTION_ORDER: &[&str] = &[
    SECTION_BASIC,
    SECTION_ENGINE,
    SECTION_SECURITY,
    SECTION_KIFU,
];

/// UI-facing value: booleans native, everything else as entered/displayed text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingValue {
    Bool(bool),
    Text(String),
}

fn setting_default(setting: &Setting) -> SettingValue {
    match setting.setting_type {
        SettingType::Bool => SettingValue::Bool(setting.default_bool),
        SettingType::Int => SettingValue::Text(setting.default_int.to_string()),
        _ => SettingValue::Text(setting.default_str.to_string()),
    }
}

fn raw_to_value(setting: &Setting, raw: &EnvValue) -> SettingValue {
    match setting.setting_type {
        SettingType::Bool => match raw {
            EnvValue::Bool(b) => SettingValue::Bool(*b),
            _ => SettingValue::Bool(setting.default_bool),
        },
        _ => match raw {
            EnvValue::Str(s) => SettingValue::Text(s.clone()),
            EnvValue::Int(n) => SettingValue::Text(n.to_string()),
            EnvValue::Bool(b) => SettingValue::Text(b.to_string()),
        },
    }
}

pub struct EnvPaths {
    pub server: std::path::PathBuf,
    pub wrapper: std::path::PathBuf,
}

impl EnvPaths {
    pub fn new(shogihome_dir: &Path, wrapper_dir: &Path) -> Self {
        Self {
            server: shogihome_dir.join(".env"),
            wrapper: wrapper_dir.join(".env"),
        }
    }

    pub fn get(&self, kind: EnvFile) -> &Path {
        match kind {
            EnvFile::Server => &self.server,
            EnvFile::Wrapper => &self.wrapper,
        }
    }
}

/// Load current values (first mapping wins) plus linked-key mismatches that
/// already exist on disk, e.g. `LISTEN_PORT=1` vs `REMOTE_ENGINE_PORT=2`.
pub fn load_settings(paths: &EnvPaths) -> (HashMap<String, SettingValue>, Vec<String>) {
    let server_content = crate::env_codec::read_env_file(&paths.server).unwrap_or_default();
    let wrapper_content = crate::env_codec::read_env_file(&paths.wrapper).unwrap_or_default();
    let contents = [
        (EnvFile::Server, &server_content),
        (EnvFile::Wrapper, &wrapper_content),
    ];
    let mut values = HashMap::new();
    let mut mismatches = Vec::new();
    for setting in SETTINGS {
        let mut seen: Vec<String> = Vec::new();
        for (key, kind) in setting.keys {
            let content = contents
                .iter()
                .find(|(k, _)| *k == *kind)
                .map(|(_, c)| c.as_str())
                .unwrap_or("");
            let default = match setting.setting_type {
                SettingType::Bool => EnvValue::Bool(setting.default_bool),
                SettingType::Int => EnvValue::Int(setting.default_int),
                _ => EnvValue::Str(setting.default_str.to_string()),
            };
            let raw = load_env_value(content, key, default);
            seen.push(formatted_raw(&raw));
            if setting.keys[0].0 == *key {
                values.insert(setting.id.to_string(), raw_to_value(setting, &raw));
            }
        }
        if seen.windows(2).any(|w| w[0] != w[1]) {
            mismatches.push(setting.id.to_string());
        }
    }
    (values, mismatches)
}

fn formatted_raw(raw: &EnvValue) -> String {
    match raw {
        EnvValue::Str(s) => s.clone(),
        EnvValue::Int(n) => n.to_string(),
        EnvValue::Bool(b) => b.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    InvalidInt,
    OutOfRange,
    InvalidChoice,
    InvalidOrigin,
    InvalidDomain,
}

impl ValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInt => "invalid_int",
            Self::OutOfRange => "out_of_range",
            Self::InvalidChoice => "invalid_choice",
            Self::InvalidOrigin => "invalid_origin",
            Self::InvalidDomain => "invalid_domain",
        }
    }
}

fn valid_origin(item: &str) -> bool {
    let item = item.trim();
    if item.is_empty() {
        return true;
    }
    let rest = item
        .strip_prefix("http://")
        .or_else(|| item.strip_prefix("https://"));
    match rest {
        Some(host) => !host.is_empty() && !host.chars().any(|c| c.is_whitespace() || c == ','),
        None => false,
    }
}

fn valid_domain(item: &str) -> bool {
    let item = item.trim();
    if item.is_empty() {
        return true;
    }
    let bytes = item.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'-')
}

/// Validate a values mapping. Missing ids fall back to defaults.
pub fn validate(values: &HashMap<String, SettingValue>) -> HashMap<String, ValidationError> {
    let mut errors = HashMap::new();
    for setting in SETTINGS {
        let value = values.get(setting.id);
        let text = match value {
            Some(SettingValue::Text(t)) => t.clone(),
            Some(SettingValue::Bool(_)) => continue, // bools are always valid
            None => match setting_default(setting) {
                SettingValue::Text(t) => t,
                SettingValue::Bool(_) => continue,
            },
        };
        match setting.setting_type {
            SettingType::Int => match text.trim().parse::<i64>() {
                Err(_) => {
                    errors.insert(setting.id.to_string(), ValidationError::InvalidInt);
                }
                Ok(n) => {
                    let low = setting.min_value.map(|m| n < m).unwrap_or(false);
                    let high = setting.max_value.map(|m| n > m).unwrap_or(false);
                    if low || high {
                        errors.insert(setting.id.to_string(), ValidationError::OutOfRange);
                    }
                }
            },
            SettingType::Choice => {
                if !setting.choices.contains(&text.as_str()) {
                    errors.insert(setting.id.to_string(), ValidationError::InvalidChoice);
                }
            }
            SettingType::List => {
                for item in text.split(',') {
                    let item = item.trim();
                    if item.is_empty() {
                        continue;
                    }
                    let ok = match setting.item_rule {
                        Some(ListRule::Origin) => valid_origin(item),
                        Some(ListRule::Domain) => valid_domain(item),
                        None => true,
                    };
                    if !ok {
                        let code = match setting.item_rule {
                            Some(ListRule::Origin) => ValidationError::InvalidOrigin,
                            _ => ValidationError::InvalidDomain,
                        };
                        errors.insert(setting.id.to_string(), code);
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    errors
}

fn format_value(setting: &Setting, value: &SettingValue) -> String {
    match (setting.setting_type, value) {
        (SettingType::Bool, SettingValue::Bool(true)) => "true".to_string(),
        (SettingType::Bool, _) => "false".to_string(),
        (SettingType::Int, SettingValue::Text(t)) => t
            .trim()
            .parse::<i64>()
            .map(|n| n.to_string())
            .unwrap_or_default(),
        (_, SettingValue::Text(t)) => t.clone(),
        (_, SettingValue::Bool(b)) => b.to_string(),
    }
}

/// Validate and persist. On validation failure nothing is written. Writes go
/// through atomic upserts per file; if the second file fails, the first is
/// restored from a backup so linked keys cannot diverge.
pub fn save(values: &HashMap<String, SettingValue>, paths: &EnvPaths) -> Result<(), String> {
    let errors = validate(values);
    if !errors.is_empty() {
        let mut ids: Vec<_> = errors.keys().cloned().collect();
        ids.sort();
        return Err(format!("Invalid settings: {}", ids.join(", ")));
    }
    let mut server_updates = HashMap::new();
    let mut wrapper_updates = HashMap::new();
    for setting in SETTINGS {
        let value = values
            .get(setting.id)
            .cloned()
            .unwrap_or_else(|| setting_default(setting));
        let formatted = format_value(setting, &value);
        for (key, kind) in setting.keys {
            match kind {
                EnvFile::Server => {
                    server_updates.insert(key.to_string(), formatted.clone());
                }
                EnvFile::Wrapper => {
                    wrapper_updates.insert(key.to_string(), formatted.clone());
                }
            }
        }
    }

    // Stage backups so a mid-save failure cannot leave linked keys diverged.
    let server_backup = backup_file(&paths.server)?;
    let wrapper_backup = backup_file(&paths.wrapper)?;
    let result = (|| {
        if !server_updates.is_empty() {
            upsert_env_values(&paths.server, &server_updates)?;
        }
        if !wrapper_updates.is_empty() {
            upsert_env_values(&paths.wrapper, &wrapper_updates)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            drop(server_backup);
            drop(wrapper_backup);
            Ok(())
        }
        Err(e) => {
            server_backup.restore();
            wrapper_backup.restore();
            Err(e)
        }
    }
}

struct FileBackup {
    original: std::path::PathBuf,
    backup: Option<std::path::PathBuf>,
}

fn backup_file(path: &Path) -> Result<FileBackup, String> {
    if !path.exists() {
        return Ok(FileBackup {
            original: path.to_path_buf(),
            backup: None,
        });
    }
    let backup = path.with_extension("env.bak");
    std::fs::copy(path, &backup).map_err(|e| e.to_string())?;
    Ok(FileBackup {
        original: path.to_path_buf(),
        backup: Some(backup),
    })
}

impl FileBackup {
    fn restore(mut self) {
        if let Some(backup) = self.backup.take() {
            let _ = std::fs::rename(&backup, &self.original);
        }
    }
}

impl Drop for FileBackup {
    fn drop(&mut self) {
        if let Some(backup) = self.backup.take() {
            let _ = std::fs::remove_file(backup);
        }
    }
}

/// Machine-readable schema for the settings dialog (served to the TS UI).
pub fn settings_schema() -> serde_json::Value {
    let sections: Vec<serde_json::Value> = SECTION_ORDER
        .iter()
        .map(|s| serde_json::Value::String(s.to_string()))
        .collect();
    let settings: Vec<serde_json::Value> = SETTINGS
        .iter()
        .map(|s| {
            let default = match setting_default(s) {
                SettingValue::Bool(b) => serde_json::Value::Bool(b),
                SettingValue::Text(t) => serde_json::Value::String(t),
            };
            serde_json::json!({
                "id": s.id,
                "type": match s.setting_type {
                    SettingType::Int => "int",
                    SettingType::Bool => "bool",
                    SettingType::Text => "text",
                    SettingType::Choice => "choice",
                    SettingType::List => "list",
                },
                "section": s.section,
                "default": default,
                "min": s.min_value,
                "max": s.max_value,
                "choices": s.choices,
                "listRule": match s.item_rule {
                    Some(ListRule::Origin) => "origin",
                    Some(ListRule::Domain) => "domain",
                    None => "none",
                },
            })
        })
        .collect();
    serde_json::json!({"sections": sections, "settings": settings})
}

/// URL-safe random token (≈32 chars), mirroring `secrets.token_urlsafe(24)`.
pub fn generate_token() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(name: &str) -> (std::path::PathBuf, EnvPaths) {
        let base = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("shogihome")).unwrap();
        std::fs::create_dir_all(base.join("wrapper")).unwrap();
        let paths = EnvPaths::new(&base.join("shogihome"), &base.join("wrapper"));
        (base, paths)
    }

    fn cleanup(base: &std::path::Path) {
        std::fs::remove_dir_all(base).ok();
    }

    fn full_values() -> HashMap<String, SettingValue> {
        HashMap::from([
            ("PORT".to_string(), SettingValue::Text("9000".to_string())),
            (
                "BIND_ADDRESS".to_string(),
                SettingValue::Text("127.0.0.1".to_string()),
            ),
            (
                "ENGINE_CONNECTION_PROTECTION_TIMEOUT".to_string(),
                SettingValue::Text("300".to_string()),
            ),
            (
                "LISTEN_PORT".to_string(),
                SettingValue::Text("5000".to_string()),
            ),
            (
                "ALLOWED_ORIGINS".to_string(),
                SettingValue::Text("http://localhost:9000".to_string()),
            ),
            (
                "DISABLE_AUTO_ALLOWED_ORIGINS".to_string(),
                SettingValue::Bool(true),
            ),
            ("TRUST_PROXY".to_string(), SettingValue::Bool(true)),
            (
                "WRAPPER_ACCESS_TOKEN".to_string(),
                SettingValue::Text("secret-token".to_string()),
            ),
            (
                "ALLOWED_FETCH_DOMAINS".to_string(),
                SettingValue::Text("example.com".to_string()),
            ),
            (
                "KIFU_DIR".to_string(),
                SettingValue::Text("C:/kifu".to_string()),
            ),
            (
                "KIFU_DIR_USE_POLLING".to_string(),
                SettingValue::Bool(false),
            ),
            (
                "ANALYSIS_DB_MIN_DEPTH".to_string(),
                SettingValue::Text("20".to_string()),
            ),
            (
                "ONTHEFLY_THRESHOLD_MB".to_string(),
                SettingValue::Text("128".to_string()),
            ),
            (
                "SBK_ONTHEFLY_THRESHOLD_MB".to_string(),
                SettingValue::Text("32".to_string()),
            ),
        ])
    }

    #[test]
    fn defaults_match_python_schema() {
        let (base, paths) = dirs("set-def");
        let (values, mismatches) = load_settings(&paths);
        assert!(mismatches.is_empty());
        assert_eq!(values["PORT"], SettingValue::Text("8140".to_string()));
        assert_eq!(
            values["BIND_ADDRESS"],
            SettingValue::Text("0.0.0.0".to_string())
        );
        assert_eq!(
            values["LISTEN_PORT"],
            SettingValue::Text("4082".to_string())
        );
        assert_eq!(
            values["DISABLE_AUTO_ALLOWED_ORIGINS"],
            SettingValue::Bool(false)
        );
        assert_eq!(values["KIFU_DIR"], SettingValue::Text(String::new()));
        assert!(validate(&values).is_empty());
        cleanup(&base);
    }

    #[test]
    fn bool_true_survives_with_false_default() {
        let (base, paths) = dirs("set-bool");
        std::fs::write(&paths.server, "TRUST_PROXY=true\n").unwrap();
        let (values, _) = load_settings(&paths);
        assert_eq!(values["TRUST_PROXY"], SettingValue::Bool(true));
        cleanup(&base);
    }

    #[test]
    fn linked_mismatch_is_reported() {
        let (base, paths) = dirs("set-mismatch");
        std::fs::write(&paths.server, "REMOTE_ENGINE_PORT=5000\n").unwrap();
        std::fs::write(&paths.wrapper, "LISTEN_PORT=5001\n").unwrap();
        let (values, mismatches) = load_settings(&paths);
        assert!(mismatches.contains(&"LISTEN_PORT".to_string()));
        // First mapping (wrapper LISTEN_PORT) wins for display.
        assert_eq!(
            values["LISTEN_PORT"],
            SettingValue::Text("5001".to_string())
        );
        cleanup(&base);
    }

    #[test]
    fn save_writes_linked_keys_to_both_files() {
        let (base, paths) = dirs("set-save");
        save(&full_values(), &paths).unwrap();
        let server = std::fs::read_to_string(&paths.server).unwrap();
        let wrapper = std::fs::read_to_string(&paths.wrapper).unwrap();
        assert!(server.contains("PORT=9000"));
        assert!(server.contains("REMOTE_ENGINE_PORT=5000"));
        assert!(server.contains("DISABLE_AUTO_ALLOWED_ORIGINS=true"));
        assert!(server.contains("WRAPPER_ACCESS_TOKEN=secret-token"));
        assert!(wrapper.contains("LISTEN_PORT=5000"));
        assert!(wrapper.contains("WRAPPER_ACCESS_TOKEN=secret-token"));
        cleanup(&base);
    }

    #[test]
    fn save_rejects_invalid_without_touching_files() {
        let (base, paths) = dirs("set-invalid");
        let mut values = full_values();
        values.insert(
            "PORT".to_string(),
            SettingValue::Text("not-a-number".to_string()),
        );
        assert!(save(&values, &paths).is_err());
        assert!(!paths.server.exists());
        assert!(!paths.wrapper.exists());
        cleanup(&base);
    }

    #[test]
    fn validation_codes_match_python() {
        let err = |id: &str, v: &str| {
            validate(&HashMap::from([(
                id.to_string(),
                SettingValue::Text(v.to_string()),
            )]))
        };
        assert_eq!(err("PORT", "abc")["PORT"], ValidationError::InvalidInt);
        assert_eq!(err("PORT", "")["PORT"], ValidationError::InvalidInt);
        assert_eq!(err("PORT", "70000")["PORT"], ValidationError::OutOfRange);
        assert_eq!(
            err("ENGINE_CONNECTION_PROTECTION_TIMEOUT", "0")
                ["ENGINE_CONNECTION_PROTECTION_TIMEOUT"],
            ValidationError::OutOfRange
        );
        assert_eq!(
            err("ENGINE_CONNECTION_PROTECTION_TIMEOUT", "3601")
                ["ENGINE_CONNECTION_PROTECTION_TIMEOUT"],
            ValidationError::OutOfRange
        );
        assert!(err("ENGINE_CONNECTION_PROTECTION_TIMEOUT", "300").is_empty());
        assert_eq!(
            err("BIND_ADDRESS", "1.2.3.4")["BIND_ADDRESS"],
            ValidationError::InvalidChoice
        );
        assert_eq!(
            err("ALLOWED_ORIGINS", "http://ok.example.com,not-a-url")["ALLOWED_ORIGINS"],
            ValidationError::InvalidOrigin
        );
        assert!(err(
            "ALLOWED_ORIGINS",
            "http://localhost:8140,https://host.tailnet.ts.net"
        )
        .is_empty());
        assert!(err("ALLOWED_ORIGINS", "").is_empty());
        assert_eq!(
            err("ALLOWED_FETCH_DOMAINS", "example.com,not a domain!")["ALLOWED_FETCH_DOMAINS"],
            ValidationError::InvalidDomain
        );
        let (base, _paths) = dirs("set-val");
        cleanup(&base);
    }

    #[test]
    fn token_is_unique_and_safe() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert!(a.len() >= 20 && !a.contains(' '));
    }
}
