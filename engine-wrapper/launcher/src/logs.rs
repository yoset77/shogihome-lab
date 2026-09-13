//! Service log rotation and capped reading.
//!
//! Rotation keeps one `.old` generation per service (ported from the
//! launcher). The viewer cap (1 MiB per file) bounds UI memory; it is not a
//! disk cap — same as before.

pub const LOG_NAMES: &[&str] = &["server.log", "wrapper.log"];
/// Maximum bytes handed to the log viewer per file.
pub const VIEWER_CAP_BYTES: u64 = 1024 * 1024;

/// Rotate `<dir>/server.log` and `<dir>/wrapper.log`: existing files move to
/// `*.log.old` (previous generation discarded). Missing files are fine.
pub fn rotate_logs(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for name in LOG_NAMES {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        let old = path.with_extension("log.old");
        if old.exists() {
            std::fs::remove_file(&old).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, &old).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read up to the last `VIEWER_CAP_BYTES` of a log file, lossy-decoded.
/// Missing file → empty string.
pub fn read_tail(path: &std::path::Path) -> String {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    let start = bytes.len().saturating_sub(VIEWER_CAP_BYTES as usize);
    // Avoid splitting a UTF-8 sequence at the cut point.
    let mut start = start;
    while start < bytes.len() && (bytes[start] as i8) < -64 {
        start += 1;
    }
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

/// Header line written at the top of fresh log files.
pub fn startup_header(caption: &str) -> String {
    format!("--- {caption} ---\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_one_generation() {
        let dir = std::env::temp_dir().join(format!("logs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server.log"), b"new").unwrap();
        std::fs::write(dir.join("server.log.old"), b"older").unwrap();
        rotate_logs(&dir).unwrap();
        assert_eq!(std::fs::read(dir.join("server.log.old")).unwrap(), b"new");
        assert!(!dir.join("server.log").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_caps_and_survives_missing() {
        assert_eq!(read_tail(std::path::Path::new("/nonexistent-x.log")), "");
        let dir = std::env::temp_dir().join(format!("logs2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.log");
        let big = vec![b'x'; VIEWER_CAP_BYTES as usize + 100];
        std::fs::write(&path, &big).unwrap();
        assert_eq!(read_tail(&path).len(), VIEWER_CAP_BYTES as usize);
        std::fs::remove_dir_all(&dir).ok();
    }
}
