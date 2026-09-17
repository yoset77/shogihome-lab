//! Engine output decoding.
//!
//! Decoded per complete line (without the trailing newline): strict UTF-8
//! first, then CP932 (Shift-JIS via `encoding_rs`), then lossy UTF-8. The
//! result is always forwarded toward the server as UTF-8. Engine stdin is
//! never transcoded to CP932.

/// Maximum buffered bytes for one engine output line (1 MiB, matching the
/// server-side engine-list cap scale). Lines beyond this abort the session
/// instead of growing memory without bound.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Decode one engine output line (newline already stripped by the caller).
pub fn decode_line(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let (decoded, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_passthrough() {
        assert_eq!(decode_line("こんにちは".as_bytes()), "こんにちは");
    }

    #[test]
    fn cp932_fallback() {
        // "あ" in CP932: invalid UTF-8, valid Shift-JIS.
        assert_eq!(decode_line(&[0x82, 0xA0]), "あ");
    }

    #[test]
    fn invalid_bytes_do_not_panic() {
        let out = decode_line(&[0xFF, 0xFF]);
        assert!(!out.is_empty());
    }

    #[test]
    fn mixed_ascii_and_cp932() {
        let mut bytes = b"info string ".to_vec();
        bytes.extend_from_slice(&[0x82, 0xA0]);
        assert_eq!(decode_line(&bytes), "info string あ");
    }
}
