//! Shared `.env` decoding and parsing for the wrapper and launcher.
//!
//! Compatibility contract (verified against real parsers):
//! - Decoding fallback: UTF-8 BOM → UTF-8 → CP932 → lossy UTF-8
//!   (mirrors `common.py`).
//! - Parsing follows python-dotenv: quotes, `export `, blank lines,
//!   `#` comments, and ` #`-suffix stripping for *unquoted* values.
//! - Known divergence: Node's `parseEnv` strips `#` even without a
//!   preceding space (`A=B#C` → `B`, python keeps `B#C`).
//! - Known divergence: POSIX `${VAR}` interpolation is NOT expanded;
//!   values are literal (python-dotenv would expand them). Files relying
//!   on interpolation must be resolved before use.
//!
//! Higher-level read/write helpers (formatting, upsert, merge) stay in
//! `shogihome-launcher::env_codec`.

use std::collections::HashMap;
use std::io;
use std::path::Path;

pub const UTF8_SIG: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Decode `.env` bytes with the BOM/UTF-8/CP932/replace fallback chain.
pub fn decode_env_bytes(bytes: &[u8]) -> String {
    if let Some(stripped) = bytes.strip_prefix(&UTF8_SIG) {
        if let Ok(text) = std::str::from_utf8(stripped) {
            return text.to_string();
        }
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let (decoded, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Read and decode a `.env` file. Missing file → empty string.
pub fn read_env_file(path: &Path) -> io::Result<String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(decode_env_bytes(&bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    }
}

/// Parse `.env` content into key → value, last active definition wins.
/// Commented-out lines never contribute.
pub fn parse_env(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        if let Some((key, value)) = parse_line(line) {
            map.insert(key, value);
        }
    }
    map
}

/// Strip a leading `export ` / `export\t` prefix (plus following
/// whitespace), returning the remainder. This is the single scanner for the
/// prefix so `parse_line` and the upsert/merge writers cannot drift.
pub fn strip_export_prefix(s: &str) -> &str {
    if let Some(rest) = s.strip_prefix("export") {
        if rest.starts_with([' ', '\t']) {
            return rest.trim_start_matches([' ', '\t']);
        }
    }
    s
}

/// Parse one line. Returns `None` for blanks, comments, and non-assignments.
fn parse_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let rest = strip_export_prefix(trimmed);
    let eq = rest.find('=')?;
    let (raw_key, raw_value) = rest.split_at(eq);
    let key = raw_key.trim();
    if !is_valid_key(key) {
        return None;
    }
    let value = raw_value[1..].trim_start();
    if let Some(quote @ ('\'' | '"')) = value.chars().next() {
        let mut escaped = false;
        for (index, ch) in value.char_indices().skip(1) {
            if ch == quote && !escaped {
                let suffix = value[index + ch.len_utf8()..].trim();
                if !suffix.is_empty() && !suffix.starts_with('#') {
                    return None;
                }
                return Some((key.to_string(), unescape_quoted(&value[1..index], quote)));
            }
            escaped = ch == '\\' && !escaped;
        }
        return None;
    }
    // Unquoted: trim trailing whitespace, strip ` #` comments (python-dotenv).
    let mut value = value.trim_end().to_string();
    if let Some(pos) = value.find(" #") {
        value.truncate(pos);
        value = value.trim_end().to_string();
    }
    Some((key.to_string(), value))
}

/// True for `KEY=` names (`[A-Za-z_][A-Za-z0-9_]*`).
pub fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Temporary path for an atomic write: same directory (so `rename` stays on
/// one filesystem), per-process unique so concurrent writers — or a
/// launcher-embedded and a standalone editor session — cannot truncate each
/// other's file. Same-process concurrent saves disambiguate via a counter.
fn atomic_tmp_path(path: &Path) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    let tmp_name = if seq == 0 {
        format!("{file_name}.{}.tmp", std::process::id())
    } else {
        format!("{file_name}.{}.{seq}.tmp", std::process::id())
    };
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(tmp_name),
        _ => std::path::PathBuf::from(tmp_name),
    }
}

/// Atomically write `content` to `path` via a unique temporary file in the
/// same directory + rename, so readers never observe a half-written file.
/// Cleans up the temporary file when the write or rename fails.
pub fn write_atomic(path: &Path, content: &[u8]) -> io::Result<()> {
    let tmp = atomic_tmp_path(path);
    if let Err(e) = std::fs::write(&tmp, content) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Atomically publish `src` at `dest` (copy + rename), creating `dest`'s
/// parent directory. Used for registry/record publication.
pub fn copy_file_atomic(src: &Path, dest: &Path) -> io::Result<()> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = atomic_tmp_path(dest);
    if let Err(e) = std::fs::copy(src, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn unescape_quoted(s: &str, quote: char) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some(c) if c == quote => out.push(c),
                Some('n') if quote == '"' => out.push('\n'),
                Some('r') if quote == '"' => out.push('\r'),
                Some('t') if quote == '"' => out.push('\t'),
                Some('a') if quote == '"' => out.push('\u{7}'),
                Some('b') if quote == '"' => out.push('\u{8}'),
                Some('f') if quote == '"' => out.push('\u{c}'),
                Some('v') if quote == '"' => out.push('\u{b}'),
                Some('\'') if quote == '"' => out.push('\''),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
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
    fn interpolation_is_literal() {
        // python-dotenv would expand ${HOME}; this parser keeps it literal.
        let map = parse_env("A=${HOME}/kifu\n");
        assert_eq!(map["A"], "${HOME}/kifu");
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("env-file-missing-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_env_file(&path).unwrap(), "");
    }

    #[test]
    fn export_prefix_scanner_handles_space_and_tab() {
        assert_eq!(strip_export_prefix("export FOO=1"), "FOO=1");
        assert_eq!(strip_export_prefix("export\tFOO=1"), "FOO=1");
        assert_eq!(strip_export_prefix("export  \t FOO=1"), "FOO=1");
        // Bare `export` without whitespace is not a prefix.
        assert_eq!(strip_export_prefix("exportFOO=1"), "exportFOO=1");
        assert_eq!(strip_export_prefix("FOO=1"), "FOO=1");
        // Both spellings parse identically.
        assert_eq!(parse_env("export\tE=5\n")["E"], "5");
        assert_eq!(parse_env("export E=5\n")["E"], "5");
    }

    #[test]
    fn atomic_write_leaves_no_tmp_behind() {
        let dir = std::env::temp_dir().join(format!("env-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        write_atomic(&path, b"A=1\n").unwrap();
        write_atomic(&path, b"A=2\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "A=2\n");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![".env".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
