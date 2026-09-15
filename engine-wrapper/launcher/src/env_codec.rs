//! `.env` formatting, upsert, and merge.
//!
//! Decoding and parsing live in the shared `shogihome-env-file` crate so
//! the wrapper reuses the exact same contract (re-exported here for
//! compatibility):
//! - Decoding fallback: UTF-8 BOM → UTF-8 → CP932 → lossy UTF-8
//!   (mirrors `common.py`).
//! - Load parsing follows python-dotenv: quotes, `export `, blank lines,
//!   `#` comments, and ` #`-suffix stripping for *unquoted* values.
//! - Known divergence: Node's `parseEnv` strips `#` even without a
//!   preceding space (`A=B#C` → `B`, python keeps `B#C`). The launcher
//!   therefore always quotes values containing `#`, so files it writes
//!   parse identically in both.
//! - Known divergence: POSIX `${VAR}` interpolation is NOT expanded;
//!   values are literal.
//! - Formatting strategy (ported from `_format_env_value`): bare, then
//!   single-quoted, then double-quoted; each candidate is verified by
//!   parsing it back. Unrepresentable values are an error, raised before
//!   any file is touched.

use std::collections::HashMap;
use std::path::Path;

use crate::error::LauncherError;

pub use shogihome_env_file::{
    copy_file_atomic, decode_env_bytes, is_valid_key, parse_env, read_env_file,
    strip_export_prefix, write_atomic, UTF8_SIG,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvValue {
    Str(String),
    Int(i64),
    Bool(bool),
}

/// Typed read mirroring `load_env_value`, with the bool/int bug fixed:
/// booleans are detected before integers (`"true"` with a `false` default
/// must read back `true`).
pub fn load_env_value(content: &str, key: &str, default: EnvValue) -> EnvValue {
    let map = parse_env(content);
    let raw = match map.get(key) {
        Some(v) => v,
        None => return default,
    };
    match default {
        EnvValue::Bool(_) => match raw.trim().to_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => EnvValue::Bool(true),
            "false" | "0" | "no" | "off" | "" => EnvValue::Bool(false),
            _ => default,
        },
        EnvValue::Int(_) => match raw.trim().parse::<i64>() {
            Ok(n) => EnvValue::Int(n),
            Err(_) => default,
        },
        EnvValue::Str(_) => EnvValue::Str(raw.clone()),
    }
}

/// Render a value so python-dotenv and Node `parseEnv` read it back
/// identically. Errors before writing when no representation round-trips.
pub fn format_env_value(key: &str, value: &str) -> Result<String, LauncherError> {
    if value.contains('\n') || value.contains('\r') {
        return Err(LauncherError::msg(format!(
            "Value for '{key}' must not contain newlines"
        )));
    }
    let mut candidates = Vec::new();
    if !value.contains('#')
        && value == value.trim()
        && !matches!(value.chars().next(), Some('\'' | '"' | '`'))
    {
        candidates.push(value.to_string());
    }
    // Single quotes keep Windows paths literal; Node never unescapes them.
    for quote in ['\'', '"'] {
        if !value.contains(quote) {
            candidates.push(format!("{quote}{value}{quote}"));
        }
    }
    for candidate in candidates {
        let parsed = parse_env(&format!("{key}={candidate}\n"));
        if parsed.get(key).map(String::as_str) == Some(value) {
            return Ok(candidate);
        }
    }
    Err(LauncherError::msg(format!(
        "Value for '{key}' cannot be represented consistently in Python and Node .env files"
    )))
}

#[derive(Debug)]
struct Entry {
    line: String,
    key: Option<String>,
    commented: bool,
}

fn split_entries(content: &str) -> (Vec<Entry>, std::collections::HashSet<String>) {
    let mut entries = Vec::new();
    let mut active = std::collections::HashSet::new();
    for line in content.split_inclusive('\n') {
        let stripped = line.trim();
        let mut commented = false;
        let mut rest = stripped;
        if let Some(after) = rest.strip_prefix('#') {
            // `#+` followed by optional whitespace = commented entry.
            let after_hashes = after.trim_start_matches('#');
            if after_hashes.is_empty()
                || after_hashes.starts_with(char::is_whitespace)
                || after_hashes.contains('=')
            {
                commented = true;
                rest = after_hashes.trim_start();
            }
        }
        let mut key = None;
        if commented || !stripped.starts_with('#') {
            // Single scanner shared with `parse_env`: `export ` and
            // `export\t` (plus extra whitespace) all count as active.
            let body = strip_export_prefix(rest);
            if let Some(eq) = body.find('=') {
                let candidate = body[..eq].trim();
                if is_valid_key(candidate) {
                    key = Some(candidate.to_string());
                }
            }
        }
        if let Some(ref k) = key {
            if !commented {
                active.insert(k.clone());
            }
        }
        entries.push(Entry {
            line: line.to_string(),
            key,
            commented,
        });
    }
    // Trailing content without newline forms one last entry.
    if !content.ends_with('\n') && !content.is_empty() {
        // Already covered: split_inclusive yields the tail as an entry.
    }
    (entries, active)
}

/// Update keys while preserving comments and unknown lines.
///
/// - Every active `KEY=` line is replaced in place at the first occurrence;
///   later active duplicates are dropped (dedup).
/// - A commented `# KEY=` line is activated only when no active definition
///   exists.
/// - Missing keys are appended. The file is written back as UTF-8 via a
///   temporary file + rename. Empty updates touch nothing.
pub fn upsert_env_values(
    path: &Path,
    updates: &HashMap<String, String>,
) -> Result<(), LauncherError> {
    if updates.is_empty() {
        return Ok(());
    }
    let mut formatted = HashMap::new();
    for (key, value) in updates {
        formatted.insert(key.clone(), format_env_value(key, value)?);
    }

    let content = read_env_file(path)
        .map_err(|e| LauncherError::io(format!("reading {}", path.display()), e))?;
    let (entries, active_keys) = split_entries(&content);
    let mut remaining = formatted.clone();
    let mut out: Vec<String> = Vec::new();

    for entry in &entries {
        match &entry.key {
            Some(key) if formatted.contains_key(key) => {
                if entry.commented && active_keys.contains(key) {
                    out.push(entry.line.clone());
                } else if let Some(rep) = remaining.remove(key) {
                    out.push(format!("{key}={rep}\n"));
                } else if entry.commented {
                    out.push(entry.line.clone());
                }
                // else: later active duplicate → dropped (dedup).
            }
            _ => out.push(entry.line.clone()),
        }
    }
    if !remaining.is_empty() {
        if let Some(last) = out.last_mut() {
            if !last.ends_with('\n') {
                last.push('\n');
            }
        }
        // Deterministic order for tests: sorted by key.
        let mut rest: Vec<_> = remaining.into_iter().collect();
        rest.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, rep) in rest {
            out.push(format!("{key}={rep}\n"));
        }
    }

    write_atomic(path, out.join("").as_bytes())
        .map_err(|e| LauncherError::io(format!("writing {}", path.display()), e))
}

/// Merge old user values onto a new template file (ported from
/// `smart_merge_env`): the new file wins structurally; old values overlay
/// matching active keys; old-only keys are dropped.
pub fn smart_merge_env(
    old_path: &Path,
    new_path: &Path,
    dest_path: &Path,
) -> Result<(), LauncherError> {
    let old_content = read_env_file(old_path)
        .map_err(|e| LauncherError::io(format!("reading {}", old_path.display()), e))?;
    if old_content.is_empty() && !old_path.exists() {
        if new_path != dest_path && new_path.exists() {
            let bytes = std::fs::read(new_path)
                .map_err(|e| LauncherError::io(format!("reading {}", new_path.display()), e))?;
            std::fs::write(dest_path, bytes)
                .map_err(|e| LauncherError::io(format!("writing {}", dest_path.display()), e))?;
        }
        return Ok(());
    }
    let old_values = parse_env(&old_content);
    if !new_path.exists() {
        if old_path != dest_path {
            std::fs::write(
                dest_path,
                decode_env_bytes(&std::fs::read(old_path).map_err(|e| {
                    LauncherError::io(format!("reading {}", old_path.display()), e)
                })?)
                .as_bytes(),
            )
            .map_err(|e| LauncherError::io(format!("writing {}", dest_path.display()), e))?;
        }
        return Ok(());
    }
    let new_content = std::fs::read_to_string(new_path)
        .map_err(|e| LauncherError::io(format!("reading {}", new_path.display()), e))?;
    let mut merged = String::new();
    for line in new_content.split_inclusive('\n') {
        let stripped = line.trim();
        if stripped.is_empty() || stripped.starts_with('#') || !stripped.contains('=') {
            merged.push_str(line);
            continue;
        }
        if let Some(eq) = line.find('=') {
            let lhs = line[..eq].trim();
            // Templates may carry `export ` (space or tab); overlay old
            // values while preserving the prefix spelling.
            let body = strip_export_prefix(lhs);
            let prefix_len = lhs.len() - body.len();
            let prefix = &lhs[..prefix_len];
            let key = body.trim();
            if is_valid_key(key) {
                if let Some(old) = old_values.get(key) {
                    merged.push_str(&format!("{prefix}{key}={}\n", format_env_value(key, old)?));
                    continue;
                }
            }
        }
        merged.push_str(line);
    }
    write_atomic(dest_path, merged.as_bytes())
        .map_err(|e| LauncherError::io(format!("writing {}", dest_path.display()), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_prefers_utf8_and_falls_back() {
        assert_eq!(decode_env_bytes("PORT=8140\n".as_bytes()), "PORT=8140\n");
        assert_eq!(
            decode_env_bytes(&[0xEF, 0xBB, 0xBF, b'A', b'=', b'1', b'\n']),
            "A=1\n"
        );
        // 0x82 0xA0 is CP932 "あ"; lone 0xFF is invalid everywhere → lossy.
        assert_eq!(decode_env_bytes(&[b'N', b'=', 0x82, 0xA0, b'\n']), "N=あ\n");
        assert_eq!(decode_env_bytes(&[b'N', b'=', 0xFF, b'\n']), "N=�\n");
    }

    #[test]
    fn parse_quotes_export_comments() {
        let map = parse_env("A=1\n# B=2\nC=\"q #1\"\nD='s'\nexport E=5\nEMPTY=\n");
        assert_eq!(map["A"], "1");
        assert!(!map.contains_key("B"));
        assert_eq!(map["C"], "q #1");
        assert_eq!(map["D"], "s");
        assert_eq!(map["E"], "5");
        assert_eq!(map["EMPTY"], "");
        // Last active definition wins.
        let map = parse_env("A=1\nA=2\n");
        assert_eq!(map["A"], "2");
    }

    #[test]
    fn reads_existing_quoted_values_and_comments() {
        let map = parse_env(
            "PORT=\"9000\" # custom port\nKIFU_DIR=\"C:\\Users\\someone\\kifu\"\nTOKEN='a # b' # note\n",
        );
        assert_eq!(map["PORT"], "9000");
        assert_eq!(map["KIFU_DIR"], r"C:\Users\someone\kifu");
        assert_eq!(map["TOKEN"], "a # b");
        assert_eq!(parse_env("A='it\\'s'\n")["A"], "it's");
    }

    #[test]
    fn bool_before_int_fix() {
        // Regression: default False + "true" must read True.
        assert_eq!(
            load_env_value("TRUST_PROXY=true\n", "TRUST_PROXY", EnvValue::Bool(false)),
            EnvValue::Bool(true)
        );
        assert_eq!(
            load_env_value("PORT=abc\n", "PORT", EnvValue::Int(0)),
            EnvValue::Int(0)
        );
        assert_eq!(
            load_env_value("PORT=8140\n", "PORT", EnvValue::Int(0)),
            EnvValue::Int(8140)
        );
    }

    #[test]
    fn format_special_values() {
        assert_eq!(format_env_value("K", "C:/kifu").unwrap(), "C:/kifu");
        assert_eq!(
            format_env_value("K", "C:/Shogi #1/kifu").unwrap(),
            "'C:/Shogi #1/kifu'"
        );
        assert_eq!(format_env_value("K", "abc#def").unwrap(), "'abc#def'");
        assert_eq!(format_env_value("K", "a'b #c").unwrap(), "\"a'b #c\"");
        assert_eq!(format_env_value("K", "").unwrap(), "");
        assert!(format_env_value("K", "both'\"#quotes").is_err());
        assert!(format_env_value("K", "a\nb").is_err());
    }

    #[test]
    fn upsert_replaces_dedups_and_activates() {
        let dir = std::env::temp_dir().join(format!("upsert-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "# PORT=8140\nPORT=9000\nexport FOO=1\nPORT=9001\n# PORT=8000\nCUSTOM=keep\n",
        )
        .unwrap();
        upsert_env_values(
            &path,
            &HashMap::from([("PORT".to_string(), "9999".to_string())]),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# PORT=8140\nPORT=9999\nexport FOO=1\n# PORT=8000\nCUSTOM=keep\n"
        );
        // export counts as active; FOO untouched.
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("export FOO=1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_activates_comment_when_no_active() {
        let dir = std::env::temp_dir().join(format!("upsert2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "# REMOTE_ENGINE_PORT=4082\n").unwrap();
        upsert_env_values(
            &path,
            &HashMap::from([("REMOTE_ENGINE_PORT".to_string(), "5000".to_string())]),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "REMOTE_ENGINE_PORT=5000\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_appends_and_normalizes_newline() {
        let dir = std::env::temp_dir().join(format!("upsert3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "PORT=8140").unwrap();
        upsert_env_values(
            &path,
            &HashMap::from([("BIND_ADDRESS".to_string(), "127.0.0.1".to_string())]),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "PORT=8140\nBIND_ADDRESS=127.0.0.1\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_treats_export_tab_like_export_space() {
        // Single-scanner parity: `parse_env` accepts `export\t`, so the
        // writer must update (not duplicate) such lines.
        let dir = std::env::temp_dir().join(format!("upsert-tab-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "export\tPORT=9000\n").unwrap();
        upsert_env_values(
            &path,
            &HashMap::from([("PORT".to_string(), "9999".to_string())]),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "PORT=9999\n");
        assert_eq!(parse_env("export\tPORT=9000\n")["PORT"], "9000");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_overlays_export_prefixed_template_keys() {
        let dir = std::env::temp_dir().join(format!("merge-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("old.env");
        let new = dir.join("new.env");
        let dest = dir.join("dest.env");
        std::fs::write(&old, "PORT=9000\n").unwrap();
        std::fs::write(&new, "export PORT=8140\nexport\tOTHER=1\n").unwrap();
        smart_merge_env(&old, &new, &dest).unwrap();
        let merged = std::fs::read_to_string(&dest).unwrap();
        assert!(merged.contains("export PORT=9000"), "{merged}");
        assert!(merged.contains("export\tOTHER=1"), "{merged}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
