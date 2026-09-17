//! Server `.env` resolution through the bundled Node runtime.
//!
//! The Middle Server reads its `.env` with Node's `process.loadEnvFile()`
//! (`node:util.parseEnv`), which interprets quoted backslashes differently
//! from python-dotenv (e.g. `"C:\temp"` keeps a literal backslash in Node
//! but becomes tab + CR in python-dotenv). The launcher must resolve the
//! same values it hands to the supervised server, otherwise an existing
//! `.env` means one directory under direct launch and another under the
//! launcher.
//!
//! This module shells out to the portable `shogihome-server[.exe]` binary
//! (a renamed Node runtime) with a short `-e` script that prints
//! `parseEnv` output as JSON. When no runtime is available (unit tests
//! without a bundle), it falls back to the shared `parse_env` so logic
//! tests stay hermetic; the Node-parity integration tests pin the real
//! behavior.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::error::LauncherError;

/// Script run with `node -e`: reads the file at `argv[1]` as UTF-8 and
/// prints the `parseEnv` map as JSON. Missing file yields `{}`.
const PARSE_SCRIPT: &str = "const fs=require('node:fs');const{parseEnv}=require('node:util');const p=process.argv[1];let m={};try{m=parseEnv(fs.readFileSync(p,'utf8'))}catch(e){if(e&&e.code!=='ENOENT')throw e}m=Object.fromEntries(Object.entries(m).filter(([,v])=>typeof v==='string'));process.stdout.write(JSON.stringify(m))";

/// How long to wait for the helper Node process.
const PARSE_TIMEOUT: Duration = Duration::from_secs(10);

/// Load the server `.env` file the way the server itself sees it.
///
/// - `server_program` is the portable `shogihome-server[.exe]`; when it is
///   missing, a `node` on `PATH` is tried so dev fixtures behave the same.
/// - When neither exists, falls back to [`crate::env_codec::parse_env`].
/// - A missing file yields an empty map (matching `parseEnv` on ENOENT).
pub fn load_server_env(
    env_path: &Path,
    server_program: &Path,
) -> Result<HashMap<String, String>, LauncherError> {
    // No fast path: even micro-syntax (`export` prefixes, backquotes,
    // empty values, `#` handling) diverges between Node `parseEnv` and the
    // python-dotenv shape, so the Node runtime is authoritative whenever it
    // exists. The helper maps a missing file to `{}` (parseEnv on ENOENT).
    if let Some(map) = try_node_parse(server_program, env_path)? {
        return Ok(map);
    }
    if let Some(map) = try_node_parse(Path::new("node"), env_path)? {
        return Ok(map);
    }
    // No Node runtime available: python-dotenv shape (missing file reads
    // as empty, matching the helper's ENOENT mapping).
    let content = crate::env_codec::read_env_file(env_path)
        .map_err(|e| LauncherError::io(format!("reading {}", env_path.display()), e))?;
    Ok(crate::env_codec::parse_env(&content))
}

/// Run `program -e SCRIPT env_path` with a timeout, returning `None` when
/// the program is missing so the caller can try the next runtime.
fn try_node_parse(
    program: &Path,
    env_path: &Path,
) -> Result<Option<HashMap<String, String>>, LauncherError> {
    let mut cmd = Command::new(program);
    cmd.args(["-e", PARSE_SCRIPT, &env_path.to_string_lossy()]);
    // Do not let a stray parent env leak into the parse: the helper only
    // reads the file. Keep a minimal env for Node startup.
    cmd.env_clear();
    cmd.env("PATH", std::env::var_os("PATH").unwrap_or_default());
    #[cfg(windows)]
    {
        cmd.env(
            "SYSTEMROOT",
            std::env::var_os("SYSTEMROOT").unwrap_or_default(),
        );
        cmd.env("WINDIR", std::env::var_os("WINDIR").unwrap_or_default());
        // The launcher has no console: keep the short-lived helper hidden
        // like every other supervised child (see `shogihome-process`).
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(std::process::Stdio::null());
    let child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(LauncherError::io(
                format!("spawning {}", program.display()),
                e,
            ));
        }
    };
    let output = wait_output(child, PARSE_TIMEOUT)
        .map_err(|e| LauncherError::io(format!("reading {}", env_path.display()), e))?;
    if !output.status.success() {
        return Err(LauncherError::msg(format!(
            "failed to parse {} with {}",
            env_path.display(),
            program.display()
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| LauncherError::json(format!("parsing {}", env_path.display()), e))?;
    let mut map = HashMap::new();
    if let Some(obj) = value.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                map.insert(k.clone(), s.to_string());
            }
        }
    }
    Ok(Some(map))
}

/// Wait for a child with a deadline, collecting its piped stdout.
///
/// Polls `try_wait` so the child stays owned here: on timeout it is killed
/// and reaped before reporting `TimedOut`, leaving no helper behind. A reader
/// thread drains stdout concurrently so large JSON output cannot fill the pipe.
fn wait_output(
    mut child: std::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read as _;
    use std::time::Instant;
    let start = Instant::now();
    let stdout = child.stdout.take();
    let reader = match std::thread::Builder::new()
        .name("node-env-stdout".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut out) = stdout {
                out.read_to_end(&mut bytes)?;
            }
            Ok::<_, std::io::Error>(bytes)
        }) {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(error),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    break Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "node .env parse timed out",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    };
    if status.is_err() {
        // Closing the helper's pipe also lets the reader finish on failure.
        let _ = child.kill();
        let _ = child.wait();
    }
    let stdout = reader
        .join()
        .map_err(|_| std::io::Error::other("node .env stdout reader panicked"));
    Ok(std::process::Output {
        status: status?,
        stdout: stdout??,
        stderr: Vec::new(),
    })
}

/// Merge old server values onto a new template, resolving the old file the
/// way the server sees it (Node `parseEnv` when a runtime is available).
/// New-file structure wins; old values overlay matching keys via the shared
/// formatter (single-quote-first, so the result reads back identically in
/// Node and python-dotenv). Old-only keys are dropped.
pub fn merge_server_env(
    old_path: &Path,
    new_path: &Path,
    dest_path: &Path,
    server_program: Option<&Path>,
) -> Result<(), LauncherError> {
    use crate::env_codec::{format_env_value, is_valid_key, strip_export_prefix};
    let old_values: HashMap<String, String> = match server_program {
        Some(program) => load_server_env(old_path, program)?,
        None => {
            let content = crate::env_codec::read_env_file(old_path)
                .map_err(|e| LauncherError::io(format!("reading {}", old_path.display()), e))?;
            if content.is_empty() && !old_path.exists() {
                if new_path != dest_path && new_path.exists() {
                    let bytes = std::fs::read(new_path).map_err(|e| {
                        LauncherError::io(format!("reading {}", new_path.display()), e)
                    })?;
                    std::fs::write(dest_path, bytes).map_err(|e| {
                        LauncherError::io(format!("writing {}", dest_path.display()), e)
                    })?;
                }
                return Ok(());
            }
            crate::env_codec::parse_env(&content)
        }
    };
    if !new_path.exists() {
        return Err(LauncherError::msg(format!(
            "server template not found: {}",
            new_path.display()
        )));
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
    shogihome_env_file::write_atomic(dest_path, merged.as_bytes())
        .map_err(|e| LauncherError::io(format!("writing {}", dest_path.display()), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node_available() -> bool {
        Command::new("node")
            .args(["-e", "process.exit(0)"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn quoted_windows_path_matches_node_not_python_shape() {
        if !node_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("server-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        // Quoted Windows path: Node keeps `\t` literal, python-dotenv (and
        // the legacy launcher parser) expands it to TAB.
        std::fs::write(&path, "KIFU_DIR=\"C:\\temp\\records\"\nPORT=8140\n").unwrap();
        let map = load_server_env(&path, Path::new("definitely-missing-shogihome-server")).unwrap();
        assert_eq!(
            map.get("KIFU_DIR").map(String::as_str),
            Some("C:\\temp\\records")
        );
        assert_eq!(map.get("PORT").map(String::as_str), Some("8140"));
        // The legacy shared parser disagrees here by design (python shape).
        let legacy = crate::env_codec::parse_env(&std::fs::read_to_string(&path).unwrap());
        assert_ne!(legacy.get("KIFU_DIR"), map.get("KIFU_DIR"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn micro_syntax_matches_node_not_python_shape() {
        if !node_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("server-env-micro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        // Node strips backquotes and a space-separated `export` prefix.
        std::fs::write(&path, "KIFU_DIR=`C:/records`\nEMPTY=\nexport PLAIN=8140\n").unwrap();
        let map = load_server_env(&path, Path::new("definitely-missing-shogihome-server")).unwrap();
        assert_eq!(map.get("KIFU_DIR").map(String::as_str), Some("C:/records"));
        assert_eq!(map.get("EMPTY").map(String::as_str), Some(""));
        assert_eq!(map.get("PLAIN").map(String::as_str), Some("8140"));
        assert!(!map.contains_key("export PLAIN"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_yields_empty_map() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("server-env-missing-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let map = load_server_env(&path, Path::new("definitely-missing-shogihome-server"))
            .unwrap_or_default();
        // With node present this is {}; without node the fallback is also {}.
        assert!(!map.contains_key("PORT"));
    }

    #[cfg(unix)]
    #[test]
    fn helper_failure_is_an_error_not_empty_defaults() {
        // A hermetic helper that exists but exits non-zero: the caller must
        // see `Err` so it can surface the failure instead of showing default
        // settings. (`/bin/false` is not portable: it is missing on macOS,
        // where the missing-program fallback to `node` would mask the error
        // and yield `Ok`.)
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("server-env-false-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let helper = dir.join("fail.sh");
        std::fs::write(&helper, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "PORT=8140\n").unwrap();
        let err = load_server_env(&path, &helper).unwrap_err();
        assert!(err.to_string().contains("failed to parse"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn large_env_output_is_drained_before_helper_exit() {
        let dir = std::env::temp_dir().join(format!("server-env-large-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        let value = "x".repeat(512);
        let expected: HashMap<String, String> = (0..4096)
            .map(|i| (format!("KEY_{i}"), value.clone()))
            .collect();
        let content: String = expected.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
        std::fs::write(&path, content).unwrap();
        // Require Node: the fallback parser would not exercise the pipe.
        let result = try_node_parse(Path::new("node"), &path);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(result.unwrap().expect("Node is required"), expected);
    }

    #[test]
    fn timed_out_helper_is_killed_and_reaped() {
        if !node_available() {
            return;
        }
        let child = Command::new("node")
            .args(["-e", "setTimeout(()=>{},30000)"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let started = std::time::Instant::now();
        let err = wait_output(child, Duration::from_millis(500)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));
        // The helper must be gone, not lingering as a zombie or sleeper.
        #[cfg(target_os = "linux")]
        {
            std::thread::sleep(Duration::from_millis(100));
            assert!(
                !std::path::Path::new(&format!("/proc/{pid}")).exists(),
                "timed-out helper {pid} must be reaped"
            );
        }
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }
}
