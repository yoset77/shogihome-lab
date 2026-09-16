//! Service log rotation and capped reading.
//!
//! Rotation keeps one `.old` generation per service (ported from the
//! launcher). The viewer cap (1 MiB per file) bounds UI memory; it is not a
//! disk cap — same as before.

pub const LOG_NAMES: &[&str] = &["server.log", "wrapper.log"];
/// Maximum bytes handed to the log viewer per file.
pub const VIEWER_CAP_BYTES: u64 = 1024 * 1024;

use crate::error::LauncherError;

/// Rotate `<dir>/server.log` and `<dir>/wrapper.log`: existing files move to
/// `*.log.old` (previous generation discarded). Missing files are fine.
pub fn rotate_logs(dir: &std::path::Path) -> Result<(), LauncherError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| LauncherError::io(format!("creating {}", dir.display()), e))?;
    for name in LOG_NAMES {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        let old = path.with_extension("log.old");
        if old.exists() {
            std::fs::remove_file(&old)
                .map_err(|e| LauncherError::io(format!("cleaning {}", old.display()), e))?;
        }
        std::fs::rename(&path, &old)
            .map_err(|e| LauncherError::io(format!("rotating {}", path.display()), e))?;
    }
    Ok(())
}

/// Read up to the last `VIEWER_CAP_BYTES` of a log file, lossy-decoded.
/// Missing file → empty string. Seeks to the tail first so a multi-GB log
/// never allocates more than the cap plus a small UTF-8 resync window.
pub fn read_tail(path: &std::path::Path) -> String {
    match std::fs::File::open(path) {
        Ok(file) => read_tail_reader(file),
        Err(_) => String::new(),
    }
}

/// Tail core over any seekable byte stream, so tests can meter the read
/// volume without multi-GB fixtures. Never reads more than the cap plus a
/// small UTF-8 resync window, regardless of stream length.
fn read_tail_reader<R: std::io::Read + std::io::Seek>(mut src: R) -> String {
    use std::io::{Read, SeekFrom};
    let size = match src.seek(SeekFrom::End(0)) {
        Ok(size) => size,
        Err(_) => return String::new(),
    };
    let offset = size.saturating_sub(VIEWER_CAP_BYTES);
    if src.seek(SeekFrom::Start(offset)).is_err() {
        return String::new();
    }
    // Cap the read itself; the file may grow between seek and read.
    let mut bytes = Vec::new();
    let limit = (VIEWER_CAP_BYTES + 4) as usize;
    if src.take(limit as u64).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    if bytes.len() > VIEWER_CAP_BYTES as usize {
        // The file grew between seek and read: keep the newest bytes.
        let excess = bytes.len() - VIEWER_CAP_BYTES as usize;
        bytes.drain(..excess);
    }
    // Avoid splitting a UTF-8 sequence at the cut point.
    let mut start = 0;
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

    #[test]
    fn tail_seeks_instead_of_reading_everything() {
        // Sparse file: logical size exceeds the cap while occupying almost
        // no disk. `read_tail` must return the tail without materializing
        // the whole file (the old `fs::read` loaded every byte).
        use std::io::{Seek, SeekFrom, Write};
        let dir = std::env::temp_dir().join(format!("logs3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sparse.log");
        let tail = "TAIL-MARKER-67890".repeat(100);
        let size = VIEWER_CAP_BYTES + 4096;
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"HEAD-MARKER-12345").unwrap();
        f.seek(SeekFrom::Start(size - tail.len() as u64)).unwrap();
        f.write_all(tail.as_bytes()).unwrap();
        drop(f);
        assert!(std::fs::metadata(&path).unwrap().len() > VIEWER_CAP_BYTES);
        let out = read_tail(&path);
        assert_eq!(out.len(), VIEWER_CAP_BYTES as usize);
        assert!(out.ends_with(tail.as_str()));
        assert!(!out.contains("HEAD-MARKER"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Counts bytes pulled through `read` (seeks are free).
    struct Metered<R> {
        inner: R,
        read_bytes: u64,
    }

    impl<R: std::io::Read> std::io::Read for Metered<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.read_bytes += n as u64;
            Ok(n)
        }
    }

    impl<R: std::io::Seek> std::io::Seek for Metered<R> {
        fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    #[test]
    fn tail_read_volume_is_bounded_by_the_cap() {
        // 3x the cap in memory: the old whole-file read would pull all of
        // it; the seek+take path must stay near the cap.
        let filler = vec![b'a'; 3 * VIEWER_CAP_BYTES as usize];
        let tail = "TAIL-MARKER-67890".repeat(100);
        let mut data = filler;
        data.extend_from_slice(tail.as_bytes());
        let mut metered = Metered {
            inner: std::io::Cursor::new(data),
            read_bytes: 0,
        };
        let out = read_tail_reader(&mut metered);
        assert_eq!(out.len(), VIEWER_CAP_BYTES as usize);
        assert!(out.ends_with(tail.as_str()));
        assert!(
            metered.read_bytes <= VIEWER_CAP_BYTES + 4,
            "read {} bytes for a {}-byte stream",
            metered.read_bytes,
            3 * VIEWER_CAP_BYTES + tail.len() as u64,
        );
    }
}
