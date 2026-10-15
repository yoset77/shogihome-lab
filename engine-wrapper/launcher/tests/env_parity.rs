//! Saved values must round-trip through the wrapper's shared parser and
//! the server's real Node `parseEnv` reader.
//!
//! Intentional layering: unit shape lives in `env_codec` tests, real-parser
//! round-trip here, and `.env`-to-listen behavior in the wrapper contract suite.

use shogihome_launcher::env_codec::{format_env_value, parse_env};
use std::path::PathBuf;
use std::process::Command;

const VALUES: &[&str] = &[
    "C:/Shogi #1/kifu",
    "C:\\new\\棋譜 #1\\records",
    "C:\\temp\\records",
    "abc#def",
    "token with spaces",
    "$TOKEN",
    "${TOKEN}",
    " leading and trailing spaces ",
    "C:/O'Brien #1/kifu",
    "token\"with#quote",
    "\\\\server\\share\\kifu",
    "'quoted'",
    "",
];

fn parse_with_node(path: &std::path::Path) -> String {
    let script = "const fs=require('node:fs');const{parseEnv}=require('node:util');\
        process.stdout.write(parseEnv(fs.readFileSync(process.argv[1],'utf8'))['KIFU_DIR'] ?? '<<MISSING>>');";
    let out = Command::new("node")
        .args(["-e", script, &path.to_string_lossy()])
        .output()
        .expect("node is required for parser parity tests");
    assert!(out.status.success(), "node parseEnv failed: {out:?}");
    String::from_utf8(out.stdout).expect("node output must be UTF-8")
}

#[test]
fn formatted_values_round_trip_through_wrapper_and_node() {
    let dir: PathBuf = std::env::temp_dir().join(format!("parity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for value in VALUES {
        let formatted = format_env_value("KIFU_DIR", value)
            .unwrap_or_else(|e| panic!("value {value:?} must be representable: {e}"));
        let path = dir.join(".env");
        let content = format!("KIFU_DIR={formatted}\n");
        std::fs::write(&path, &content).unwrap();
        assert_eq!(
            parse_with_node(&path),
            *value,
            "node mismatch for {value:?}"
        );
        assert_eq!(
            parse_env(&content)["KIFU_DIR"],
            *value,
            "wrapper mismatch for {value:?}"
        );
    }
    std::fs::remove_dir_all(&dir).ok();
}
