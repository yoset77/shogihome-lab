//! CRAM-SHA256 handshake with the server.
//!
//! Wire format (unchanged from both previous wrappers):
//! wrapper -> client: `auth_cram_sha256 <32 hex chars>\n`
//! client  -> wrapper: `auth <64 hex chars>\n`
//! wrapper -> client: `auth_ok\n`
//!
//! The HMAC key is the token's UTF-8 bytes and the message is the hex nonce
//! **text** (not the raw random bytes). Intentional hardening over Node:
//! the digest must be exactly 64 hex characters (either case); anything
//! else fails closed.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Generate a 16-byte random nonce rendered as 32 lowercase hex chars.
pub fn generate_nonce() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compute the expected hex digest for a nonce under the access token.
pub fn expected_digest(token: &str, nonce: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC takes any key size");
    mac.update(nonce.as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

/// Verify a client-supplied digest string. Strict shape (64 hex chars,
/// either case), constant-time comparison against the expected digest.
pub fn verify_digest(token: &str, nonce: &str, supplied: &str) -> bool {
    let supplied = supplied.trim();
    if supplied.len() != 64 || !supplied.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let expected = expected_digest(token, nonce);
    expected
        .as_bytes()
        .ct_eq(supplied.to_lowercase().as_bytes())
        .into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_is_32_lowercase_hex() {
        let nonce = generate_nonce();
        assert_eq!(nonce.len(), 32);
        assert!(nonce
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }

    #[test]
    fn round_trip_with_known_vector() {
        // Cross-checked against Python:
        // hmac.new(b"token", b"abc", hashlib.sha256).hexdigest()
        // == "d9e22d6183ad8e63acd31eaeb7d5d661774f40f146c8e1f8c1b77ba6604c24c9".
        assert_eq!(
            expected_digest("token", "abc"),
            "d9e22d6183ad8e63acd31eaeb7d5d661774f40f146c8e1f8c1b77ba6604c24c9"
        );
        let digest = expected_digest("token", "abc");
        assert!(verify_digest("token", "abc", &digest));
        assert!(verify_digest("token", "abc", &digest.to_uppercase()));
        assert!(!verify_digest("wrong", "abc", &digest));
        assert!(!verify_digest("token", "abc", "00"));
        assert!(!verify_digest("token", "abc", &format!("{digest}00")));
        assert!(!verify_digest("token", "abc", "zz00"));
    }
}
