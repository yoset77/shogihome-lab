//! Config-editor backend: engines.json validation, atomic save, and USI
//! option probing.
//!
//! Fixes over `config_editor.py`:
//! - load path validates (the old loader rendered anything JSON shaped);
//! - probes drain stdout AND stderr concurrently with bounded buffers,
//!   belong to a process group (POSIX) for tree cleanup, and honor a
//!   cancellation flag so closing the editor never orphans a probe;
//! - `refresh_options` keeps manual/unadvertised options instead of
//!   silently dropping them on every probe.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const PROBE_USIOK_TIMEOUT: Duration = Duration::from_secs(5);
pub const PROBE_QUIT_TIMEOUT: Duration = Duration::from_secs(1);
/// Cap per probe: lines and total bytes (noisy engines cannot OOM the launcher).
pub const PROBE_MAX_LINES: usize = 10_000;
pub const PROBE_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsiOptionType {
    Check,
    Spin,
    Combo,
    String,
    Button,
    Filename,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsiOption {
    pub option_type: UsiOptionType,
    pub default: String,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub vars: Vec<String>,
}

/// Parse one USI `option ...` line. Returns `None` for non-option lines.
pub fn parse_usi_option_line(line: &str) -> Option<(String, UsiOption)> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.first() != Some(&"option") {
        return None;
    }
    let keys = ["name", "type", "default", "min", "max", "var"];
    // Split into (field, words) preserving multiword values.
    let mut fields: Vec<(&str, Vec<&str>)> = Vec::new();
    let mut current: Option<&str> = None;
    let mut buf: Vec<&str> = Vec::new();
    let mut vars: Vec<Vec<&str>> = Vec::new();
    for tok in &tokens[1..] {
        if keys.contains(tok) {
            if let Some(field) = current.take() {
                if field == "var" {
                    vars.push(std::mem::take(&mut buf));
                } else {
                    fields.push((field, std::mem::take(&mut buf)));
                }
            }
            current = Some(tok);
            if *tok == "var" {
                // vars handled via take above on next keyword/end
            }
        } else if current.is_none() {
            return None;
        } else {
            buf.push(tok);
        }
    }
    if let Some(field) = current {
        if field == "var" {
            vars.push(buf);
        } else {
            fields.push((field, buf));
        }
    }
    let get = |name: &str| {
        fields
            .iter()
            .find(|(f, _)| *f == name)
            .map(|(_, w)| w.join(" "))
    };
    let name = get("name").filter(|n| !n.is_empty())?;
    let type_str = get("type")?;
    let default = get("default").unwrap_or_default();
    let default = if default == "<empty>" {
        String::new()
    } else {
        default
    };
    let option = match type_str.as_str() {
        "check" => UsiOption {
            option_type: UsiOptionType::Check,
            default: default.to_lowercase(),
            min: None,
            max: None,
            vars: vec![],
        },
        "spin" => {
            let min = get("min").and_then(|v| v.parse().ok()).unwrap_or(0);
            let max = get("max").and_then(|v| v.parse().ok()).unwrap_or(1_000_000);
            let default_num: i64 = default.parse().unwrap_or(min);
            UsiOption {
                option_type: UsiOptionType::Spin,
                default: default_num.to_string(),
                min: Some(min),
                max: Some(max),
                vars: vec![],
            }
        }
        "combo" => UsiOption {
            option_type: UsiOptionType::Combo,
            default,
            min: None,
            max: None,
            vars: vars.into_iter().map(|w| w.join(" ")).collect(),
        },
        "string" => UsiOption {
            option_type: UsiOptionType::String,
            default,
            min: None,
            max: None,
            vars: vec![],
        },
        "button" => UsiOption {
            option_type: UsiOptionType::Button,
            default: String::new(),
            min: None,
            max: None,
            vars: vec![],
        },
        "filename" => UsiOption {
            option_type: UsiOptionType::Filename,
            default,
            min: None,
            max: None,
            vars: vec![],
        },
        _ => return None,
    };
    Some((name, option))
}

pub const ENGINE_TYPES: &[&str] = &["game", "research", "mate"];

/// Validate one engine entry, normalizing legacy `type` forms.
/// Returns the normalized entry or an error string.
pub fn normalize_engine_entry(entry: &serde_json::Value) -> Result<serde_json::Value, String> {
    let obj = entry.as_object().ok_or("entry must be an object")?;
    let get_str = |field: &str| {
        obj.get(field)
            .and_then(|v| v.as_str())
            .ok_or(format!("missing required field '{field}'"))
    };
    let id = get_str("id")?;
    let name = get_str("name")?;
    let path = get_str("path")?;
    if id.trim().is_empty() {
        return Err("engine id cannot be empty".to_string());
    }
    if path.trim().is_empty() {
        return Err("engine path cannot be empty".to_string());
    }
    let mut out = serde_json::Map::new();
    // Preserve unknown fields (DB group metadata, future keys).
    for (k, v) in obj {
        out.insert(k.clone(), v.clone());
    }
    out.insert("id".to_string(), serde_json::Value::String(id.to_string()));
    out.insert(
        "name".to_string(),
        serde_json::Value::String(name.to_string()),
    );
    out.insert(
        "path".to_string(),
        serde_json::Value::String(path.to_string()),
    );
    if let Some(t) = obj.get("type") {
        let mut types: Vec<String> = if let Some(s) = t.as_str() {
            if s == "both" {
                vec![
                    "game".to_string(),
                    "research".to_string(),
                    "mate".to_string(),
                ]
            } else {
                vec![s.to_string()]
            }
        } else if let Some(arr) = t.as_array() {
            arr.iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect()
        } else {
            return Err("field 'type' must be a string or list".to_string());
        };
        for t in &types {
            if !ENGINE_TYPES.contains(&t.as_str()) {
                return Err(format!("invalid engine type '{t}'"));
            }
        }
        types.sort();
        types.dedup();
        out.insert(
            "type".to_string(),
            serde_json::Value::Array(types.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    if let Some(options) = obj.get("options") {
        if !options.is_object() {
            return Err("field 'options' must be an object".to_string());
        }
    }
    Ok(serde_json::Value::Object(out))
}

/// Validate a full engines document (load AND save paths).
pub fn validate_engines(data: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    let arr = data.as_array().ok_or("root must be a list")?;
    arr.iter().map(normalize_engine_entry).collect()
}

/// Load + validate `engines.json`. Missing file → empty list.
pub fn load_engines_file(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    validate_engines(&data)
}

/// Validate + atomically save `engines.json`.
///
/// The temporary file uses a per-process unique name in the same directory
/// so concurrent editor sessions (launcher-embedded and standalone
/// `--config-editor`) cannot truncate each other's file. Last writer still
/// wins, but the registry is never left half-written.
pub fn save_engines_file(path: &Path, data: &serde_json::Value) -> Result<(), String> {
    let engines = validate_engines(data)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let content = serde_json::to_string_pretty(&engines).map_err(|e| e.to_string())?;
    let tmp = unique_tmp_path(path);
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

fn unique_tmp_path(path: &Path) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "engines.json".to_string());
    let tmp_name = format!("{file_name}.{}.tmp", std::process::id());
    // Same-process concurrent saves share the pid; disambiguate with a counter.
    let tmp_name = if seq == 0 {
        tmp_name
    } else {
        format!("{tmp_name}.{seq}")
    };
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(tmp_name),
        _ => std::path::PathBuf::from(tmp_name),
    }
}

#[derive(Debug)]
pub enum ProbeError {
    NotFound(String),
    Timeout,
    Cancelled,
    Io(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(p) => write!(f, "engine not found: {p}"),
            Self::Timeout => write!(f, "engine USI response timed out"),
            Self::Cancelled => write!(f, "probe cancelled"),
            Self::Io(e) => write!(f, "probe failed: {e}"),
        }
    }
}

/// Probe USI options: spawn with the engine dir as CWD, send `usi`, collect
/// `option` lines until `usiok`, send `quit`, tree-kill leftovers.
/// Both stdout and stderr are drained (stderr discarded); total output is
/// bounded; `cancel` aborts promptly.
pub fn probe_usi_options(
    engine_path: &Path,
    base_dir: &Path,
    cancel: &AtomicBool,
) -> Result<BTreeMap<String, UsiOption>, ProbeError> {
    let resolved = if engine_path.is_absolute() {
        engine_path.to_path_buf()
    } else {
        base_dir.join(engine_path)
    };
    if !resolved.is_file() {
        return Err(ProbeError::NotFound(
            resolved.to_string_lossy().into_owned(),
        ));
    }
    let cwd = resolved.parent().unwrap_or(base_dir);

    let mut child = spawn_probe(&resolved, cwd).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ProbeError::NotFound(resolved.to_string_lossy().into_owned())
        } else {
            ProbeError::Io(e.to_string())
        }
    })?;
    let stdin = child
        .stdin()
        .as_mut()
        .ok_or_else(|| ProbeError::Io("no stdin".to_string()))?;
    if stdin.write_all(b"usi\n").is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ProbeError::Io("failed to write usi".to_string()));
    }
    let _ = stdin.flush();

    // Pump stdout lines and stderr bytes on scoped threads; the main loop
    // below only blocks 100ms at a time so cancel/deadline stay responsive.
    let (line_tx, line_rx) = std::sync::mpsc::sync_channel::<Option<Vec<u8>>>(64);
    let mut options = BTreeMap::new();
    let mut lines = 0usize;
    let mut bytes = 0usize;
    let deadline = Instant::now() + PROBE_USIOK_TIMEOUT;
    let result = std::thread::scope(|scope| {
        if let Some(stdout) = child.stdout().take() {
            let line_tx = line_tx.clone();
            scope.spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    let mut bounded =
                        std::io::Read::take(&mut reader, (PROBE_MAX_BYTES + 1) as u64);
                    match bounded.read_until(b'\n', &mut buf) {
                        Ok(0) => {
                            let _ = line_tx.send(None);
                            break;
                        }
                        Ok(_) => {
                            if line_tx.send(Some(std::mem::take(&mut buf))).is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = line_tx.send(None);
                            break;
                        }
                    }
                }
            });
        } else {
            let _ = line_tx.send(None);
        }
        if let Some(mut stderr) = child.stderr().take() {
            scope.spawn(move || {
                let mut buffer = [0; 8192];
                loop {
                    match std::io::Read::read(&mut stderr, &mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            });
        }
        drop(line_tx);
        let outcome = loop {
            if cancel.load(Ordering::Relaxed) {
                break Err(ProbeError::Cancelled);
            }
            if Instant::now() > deadline {
                break Err(ProbeError::Timeout);
            }
            match line_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(buf)) => {
                    lines += 1;
                    bytes += buf.len();
                    if lines > PROBE_MAX_LINES || bytes > PROBE_MAX_BYTES {
                        break Err(ProbeError::Io(
                            "engine output exceeded probe limits".to_string(),
                        ));
                    }
                    let text = String::from_utf8_lossy(&buf);
                    let text = text.trim_end_matches(['\r', '\n']);
                    if text == "usiok" {
                        break Ok(());
                    }
                    if let Some((name, opt)) = parse_usi_option_line(text) {
                        options.insert(name, opt);
                    }
                }
                Ok(None) => break Err(ProbeError::Io("engine closed stdout".to_string())),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(ProbeError::Io("engine closed stdout".to_string()))
                }
            }
        };
        // Release blocked senders before joining the pumps.
        drop(line_rx);
        // Quit + reap INSIDE the scope: killing the child unblocks the pump
        // threads (EOF) so the scope can join. Doing this after the scope
        // would deadlock when the engine never answers.
        if let Some(mut stdin) = child.stdin().take() {
            let _ = stdin.write_all(b"quit\n");
            let _ = stdin.flush();
        }
        let quit_deadline = Instant::now() + PROBE_QUIT_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < quit_deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
        // Helpers may still own the pipes after the leader exits normally.
        // The retained process group / Job remains valid after try_wait().
        let _ = child.kill();
        outcome
    });

    result.map(|_| options)
}

fn spawn_probe(path: &Path, cwd: &Path) -> std::io::Result<crate::process::ManagedChild> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let is_batch = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"))
            .unwrap_or(false);
        let mut cmd = if is_batch {
            let mut c = Command::new("cmd");
            c.args(["/d", "/s", "/c"])
                .raw_arg(format!("\"\"{}\"\"", path.display()));
            c
        } else {
            Command::new(path)
        };
        cmd.current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process::spawn(cmd)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(path);
        cmd.current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process::spawn(cmd)
    }
}

/// Merge probe results over existing manual options: discovered entries take
/// the existing value when present (spin clamped to the advertised range,
/// combo falling back to default when the value is not offered); manual
/// entries the engine no longer advertises are KEPT (old UI dropped them).
pub fn refresh_options(
    existing: &serde_json::Map<String, serde_json::Value>,
    discovered: &BTreeMap<String, UsiOption>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut merged = serde_json::Map::new();
    for (name, opt) in discovered {
        if opt.option_type == UsiOptionType::Button {
            continue;
        }
        let value = match existing.get(name) {
            Some(v) => coerce_existing(v, opt),
            None => default_value(opt),
        };
        merged.insert(name.clone(), value);
    }
    // Preserve manual entries the probe did not advertise.
    for (name, value) in existing {
        if !discovered.contains_key(name) && !merged.contains_key(name) {
            merged.insert(name.clone(), value.clone());
        }
    }
    merged
}

fn default_value(opt: &UsiOption) -> serde_json::Value {
    match opt.option_type {
        UsiOptionType::Check => serde_json::Value::Bool(opt.default == "true"),
        UsiOptionType::Spin => serde_json::Value::from(opt.default.parse::<i64>().unwrap_or(0)),
        _ => serde_json::Value::String(opt.default.clone()),
    }
}

fn coerce_existing(existing: &serde_json::Value, opt: &UsiOption) -> serde_json::Value {
    match opt.option_type {
        UsiOptionType::Check => match existing {
            serde_json::Value::Bool(b) => serde_json::Value::Bool(*b),
            serde_json::Value::String(s) => serde_json::Value::Bool(s.to_lowercase() == "true"),
            _ => default_value(opt),
        },
        UsiOptionType::Spin => {
            let num = match existing {
                serde_json::Value::Number(n) => n.as_i64(),
                serde_json::Value::String(s) => s.parse::<i64>().ok(),
                _ => None,
            };
            match num {
                Some(n) => {
                    let min = opt.min.unwrap_or(i64::MIN);
                    let max = opt.max.unwrap_or(i64::MAX);
                    if n < min || n > max {
                        default_value(opt)
                    } else {
                        serde_json::Value::from(n)
                    }
                }
                None => default_value(opt),
            }
        }
        UsiOptionType::Combo => match existing {
            serde_json::Value::String(s) if opt.vars.contains(s) => existing.clone(),
            _ => default_value(opt),
        },
        _ => match existing {
            serde_json::Value::String(_) => existing.clone(),
            serde_json::Value::Bool(b) => serde_json::Value::String(b.to_string()),
            serde_json::Value::Number(n) => serde_json::Value::String(n.to_string()),
            _ => default_value(opt),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn parse_option_shapes() {
        let (n, o) =
            parse_usi_option_line("option name Threads type spin default 1 min 1 max 128").unwrap();
        assert_eq!(n, "Threads");
        assert_eq!(o.min, Some(1));
        assert_eq!(o.max, Some(128));
        let (n, o) =
            parse_usi_option_line("option name USI_Ponder type check default false").unwrap();
        assert_eq!((n.as_str(), o.default.as_str()), ("USI_Ponder", "false"));
        let (n, o) = parse_usi_option_line(
            "option name Opening type combo default Normal var Move Count Based var Time Based",
        )
        .unwrap();
        assert_eq!(n, "Opening");
        assert!(o.vars.contains(&"Move Count Based".to_string()));
        let (n, _) = parse_usi_option_line("option name Best Book Move type button").unwrap();
        assert_eq!(n, "Best Book Move");
        assert!(parse_usi_option_line("invalid line").is_none());
        assert!(parse_usi_option_line("option name OnlyName").is_none());
        // Unknown types are rejected (engine-specific extensions need explicit support).
        assert!(parse_usi_option_line("option name X type weird default 1").is_none());
    }

    #[test]
    fn validation_and_legacy_types() {
        let data = serde_json::json!([
            {"id": "a", "name": "A", "path": "x", "type": "both", "options": {"Threads": 4}},
            {"id": "b", "name": "B", "path": "y", "type": ["game"]},
        ]);
        let engines = validate_engines(&data).unwrap();
        assert_eq!(
            engines[0]["type"],
            serde_json::json!(["game", "mate", "research"])
        );
        assert!(validate_engines(&serde_json::json!({"id": 1})).is_err());
        assert!(
            validate_engines(&serde_json::json!([{"id": " ", "name": "n", "path": "p"}])).is_err()
        );
        assert!(validate_engines(
            &serde_json::json!([{"id": "a", "name": "n", "path": "p", "type": ["bogus"]}])
        )
        .is_err());
        assert!(validate_engines(
            &serde_json::json!([{"id": "a", "name": "n", "path": "p", "options": []}])
        )
        .is_err());
        // Unknown fields survive.
        let data = serde_json::json!([{"id": "a", "name": "A", "path": "x", "skipAnalysisDB": true, "custom": 1}]);
        let engines = validate_engines(&data).unwrap();
        assert_eq!(engines[0]["skipAnalysisDB"], serde_json::json!(true));
        assert_eq!(engines[0]["custom"], serde_json::json!(1));
    }

    #[test]
    fn save_round_trips_atomically() {
        let dir = std::env::temp_dir().join(format!("ed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("engines.json");
        let data = serde_json::json!([{"id": "a", "name": "A", "path": "x", "type": "both"}]);
        save_engines_file(&path, &data).unwrap();
        save_engines_file(&path, &data).unwrap();
        // No temporary file may survive successful saves. Unique tmp names
        // carry suffixes (`.tmp.1`, …), so anything but the registry itself
        // counts as a leftover.
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["engines.json".to_string()]);
        let loaded = load_engines_file(&path).unwrap();
        assert_eq!(
            loaded[0]["type"],
            serde_json::json!(["game", "mate", "research"])
        );
        assert!(save_engines_file(&path, &serde_json::json!([{"id": "a"}])).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refresh_keeps_manual_options() {
        let existing = serde_json::json!({"Threads": 8, "BookFile": "mine.bin", "Manual": "x"})
            .as_object()
            .unwrap()
            .clone();
        let mut discovered = BTreeMap::new();
        discovered.insert(
            "Threads".to_string(),
            UsiOption {
                option_type: UsiOptionType::Spin,
                default: "1".to_string(),
                min: Some(1),
                max: Some(4),
                vars: vec![],
            },
        );
        discovered.insert(
            "Style".to_string(),
            UsiOption {
                option_type: UsiOptionType::Combo,
                default: "Normal".to_string(),
                min: None,
                max: None,
                vars: vec!["Normal".to_string()],
            },
        );
        let merged = refresh_options(&existing, &discovered);
        // Out-of-range manual Threads falls back to default...
        assert_eq!(merged["Threads"], serde_json::json!(1));
        // ...new options get defaults, unadvertised manual entries survive.
        assert_eq!(merged["Style"], serde_json::json!("Normal"));
        assert_eq!(merged["BookFile"], serde_json::json!("mine.bin"));
        assert_eq!(merged["Manual"], serde_json::json!("x"));
    }

    #[test]
    #[cfg(unix)]
    fn probe_fake_engine_and_cancel() {
        let dir = std::env::temp_dir().join(format!("probe-options-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fixture = dir.join("probe_engine.py");
        std::fs::write(
            &fixture,
            include_str!("../../tests/fixtures/probe_engine.py"),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let opts = probe_usi_options(&fixture, Path::new("/tmp"), &cancel).unwrap();
        assert_eq!(opts["Threads"].max, Some(128));
        assert_eq!(opts["USI_Ponder"].default, "true");

        // Cancelled probe reports cancellation.
        let slow = fixture.parent().unwrap().join("probe_slow.py");
        std::fs::write(
            &slow,
            "#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let cancel2 = AtomicBool::new(true);
        assert!(matches!(
            probe_usi_options(&slow, Path::new("/tmp"), &cancel2),
            Err(ProbeError::Cancelled)
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn probe_parent_exit_does_not_wait_for_inherited_pipes() {
        let dir = std::env::temp_dir().join(format!("probe-descendant-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("engine.py");
        std::fs::write(&script, "import subprocess,sys\nfor line in sys.stdin:\n if line.strip() == 'usi':\n  p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n  open('helper.pid','w').write(str(p.pid))\n  print('usiok',flush=True)\n elif line.strip() == 'quit': break\n").unwrap();
        let launcher = dir.join(if cfg!(windows) {
            "engine probe.cmd"
        } else {
            "engine.sh"
        });
        std::fs::write(
            &launcher,
            if cfg!(windows) {
                format!("@echo off\npython \"{}\"\n", script.display())
            } else {
                format!("#!/bin/sh\nexec python3 \"{}\"\n", script.display())
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let base = dir.clone();
        let worker = std::thread::spawn(move || {
            let result = probe_usi_options(&launcher, &base, &AtomicBool::new(false));
            tx.send(result).ok();
        });
        let result = rx.recv_timeout(Duration::from_secs(3));
        if let Ok(pid) = std::fs::read_to_string(dir.join("helper.pid")) {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid.parse().unwrap(), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/F", "/PID", pid.trim()])
                    .output();
            }
        }
        worker.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(result.expect("probe blocked on inherited pipes").is_ok());
    }
}
