//! Cross-parser parity: values formatted by the Rust backend must read back
//! identically through the REAL python-dotenv and Node `parseEnv` parsers.
//! Mirrors `test_upsert_env_values_round_trip_special_characters`.

use shogihome_launcher::env_codec::{format_env_value, parse_env};
use std::path::PathBuf;
use std::process::Command;

const VALUES: &[&str] = &[
    "C:/Shogi #1/kifu",
    "C:\\new\\棋譜 #1\\records",
    "abc#def",
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

fn python_command() -> String {
    // setup-python (CI) provides `python` everywhere; most Unix systems also
    // have `python3`. Prefer `python3` when both exist so a stale `python`
    // (e.g. Python 2) is never picked up.
    for candidate in ["python3", "python"] {
        if Command::new(candidate).arg("--version").output().is_ok() {
            return candidate.to_string();
        }
    }
    panic!("python + python-dotenv are required for parser parity tests");
}

fn parse_with_python(path: &std::path::Path) -> String {
    let script = "import io,sys;from dotenv import dotenv_values;\
        print(dotenv_values(sys.argv[1]).get('KIFU_DIR','<<MISSING>>'),end='')";
    let out = Command::new(python_command())
        .args(["-c", script, &path.to_string_lossy()])
        // Windows runners use a non-UTF-8 console codepage (e.g. cp1252),
        // which makes `print` of non-ASCII values fail. Force UTF-8 stdout.
        .env("PYTHONIOENCODING", "utf-8")
        .output()
        .expect("python + python-dotenv are required for parser parity tests");
    assert!(out.status.success(), "python dotenv parse failed: {out:?}");
    // Windows stdout is text mode, so decoded "\n" arrives as "\r\n".
    // Compare parser output, not transport newlines.
    String::from_utf8(out.stdout)
        .expect("python output must be UTF-8")
        .replace("\r\n", "\n")
}

#[test]
fn formatted_values_round_trip_through_both_parsers() {
    let dir: PathBuf = std::env::temp_dir().join(format!("parity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for value in VALUES {
        let formatted = format_env_value("KIFU_DIR", value)
            .unwrap_or_else(|e| panic!("value {value:?} must be representable: {e}"));
        let path = dir.join(".env");
        std::fs::write(&path, format!("KIFU_DIR={formatted}\n")).unwrap();
        assert_eq!(
            parse_with_node(&path),
            *value,
            "node mismatch for {value:?}"
        );
        assert_eq!(
            parse_with_python(&path),
            *value,
            "python mismatch for {value:?}"
        );
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn existing_quoted_files_decode_like_python_dotenv() {
    let dir = std::env::temp_dir().join(format!("read-parity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(".env");
    for input in [
        "KIFU_DIR=\"9000\" # custom port\n",
        "KIFU_DIR=\"C:\\Users\\someone\\kifu\"\n",
        "export KIFU_DIR='C:\\new\\棋譜 #1' # comment\n",
        "KIFU_DIR='it\\'s a path'\n",
        "KIFU_DIR=\"a\\tb\\nc\\q\"\n",
    ] {
        std::fs::write(&path, input).unwrap();
        assert_eq!(
            parse_env(input)["KIFU_DIR"],
            parse_with_python(&path),
            "{input}"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}
