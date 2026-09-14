//! Launcher launch mode: full dashboard vs standalone config editor.
//!
//! The standalone editor exists so engine-side hosts (remote PC, Docker
//! split, etc.) can run `ShogiHomeLab.exe --config-editor` without the
//! Middle Server bundle. It shares the editor backend (`editor.rs`) and the
//! Tauri shell, but never spawns services, never shows the dashboard or
//! tray, and exits when the editor window closes.
//!
//! `--config-dir` uses the same meaning as the wrapper's `--config-dir`:
//! the directory holding `engines.json`. Relative engine paths and USI
//! probes resolve against it. When omitted, the portable layout default
//! (`<exe-dir>/engine-wrapper`) is used.

use std::path::{Path, PathBuf};

/// Which top-level window the Tauri shell should create.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    /// Full launcher: dashboard, tray, service supervision.
    Launcher,
    /// Standalone editor only.
    ConfigEditor,
}

/// Parsed command line for the launcher executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    pub mode: LaunchMode,
    pub config_dir_override: Option<PathBuf>,
    pub show_help: bool,
}

pub fn usage() -> &'static str {
    "usage: ShogiHomeLab.exe [--config-editor [--config-dir DIR]] [--help]"
}

/// Parse `std::env::args`-style arguments (including argv[0]).
///
/// Unknown flags are an error so typos fail loudly instead of silently
/// starting the wrong mode. `--config-dir` requires `--config-editor`:
/// the launcher keeps its portable `dist_root` layout so service
/// supervision, migration, and readiness stay on one snapshot, and an
/// editor pointed elsewhere would save settings the supervised wrapper
/// never reads.
pub fn parse_args(args: &[String]) -> Result<LaunchConfig, String> {
    let mut mode = LaunchMode::Launcher;
    let mut config_dir_override = None;
    let mut show_help = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--config-editor" => mode = LaunchMode::ConfigEditor,
            "--config-dir" => {
                i += 1;
                match args.get(i) {
                    // A following flag is a missing value, not a directory.
                    Some(dir) if !dir.trim().is_empty() && !dir.starts_with("--") => {
                        config_dir_override = Some(PathBuf::from(dir));
                    }
                    _ => {
                        return Err(format!(
                            "missing value for --config-dir\n{usage}",
                            usage = usage()
                        ));
                    }
                }
            }
            "--help" | "-h" => show_help = true,
            other => {
                return Err(format!(
                    "unknown argument: {other}\n{usage}",
                    usage = usage()
                ));
            }
        }
        i += 1;
    }
    if config_dir_override.is_some() && mode != LaunchMode::ConfigEditor {
        return Err(format!(
            "--config-dir requires --config-editor\n{usage}",
            usage = usage()
        ));
    }
    Ok(LaunchConfig {
        mode,
        config_dir_override,
        show_help,
    })
}

/// Resolve the editor configuration directory.
///
/// - Explicit `--config-dir` wins (made absolute, like the wrapper).
/// - Otherwise the portable default `<exe-dir>/engine-wrapper` is used.
///   The process CWD is never used implicitly.
pub fn resolve_editor_config_dir(exe_path: &Path, override_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = override_dir {
        return std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    }
    let exe_dir = exe_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("engine-wrapper")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_to_launcher_without_config_dir() {
        let cfg = parse_args(&args(&["ShogiHomeLab.exe"])).unwrap();
        assert_eq!(cfg.mode, LaunchMode::Launcher);
        assert_eq!(cfg.config_dir_override, None);
        assert!(!cfg.show_help);
    }

    #[test]
    fn editor_mode_with_optional_config_dir() {
        let cfg = parse_args(&args(&[
            "ShogiHomeLab.exe",
            "--config-editor",
            "--config-dir",
            "D:\\engines\\config",
        ]))
        .unwrap();
        assert_eq!(cfg.mode, LaunchMode::ConfigEditor);
        assert_eq!(
            cfg.config_dir_override,
            Some(PathBuf::from("D:\\engines\\config"))
        );
    }

    #[test]
    fn rejects_unknown_flags_and_missing_values() {
        assert!(parse_args(&args(&["app", "--bogus"])).is_err());
        assert!(parse_args(&args(&["app", "--config-dir"])).is_err());
        assert!(parse_args(&args(&["app", "--config-dir", "  "])).is_err());
        // A following flag is not a value.
        assert!(parse_args(&args(&["app", "--config-dir", "--config-editor"])).is_err());
    }

    #[test]
    fn config_dir_requires_editor_mode() {
        assert!(parse_args(&args(&["app", "--config-dir", "/cfg"])).is_err());
        assert!(parse_args(&args(&["app", "--config-editor", "--config-dir", "/cfg"])).is_ok());
    }

    #[test]
    fn help_flag_is_reported() {
        let cfg = parse_args(&args(&["app", "--help"])).unwrap();
        assert!(cfg.show_help);
    }

    #[test]
    fn config_dir_prefers_override_and_ignores_cwd() {
        let dir =
            resolve_editor_config_dir(Path::new("/app/ShogiHomeLab"), Some(Path::new("/cfg")));
        assert_eq!(dir, PathBuf::from("/cfg"));
        let dir = resolve_editor_config_dir(Path::new("/app/ShogiHomeLab"), None);
        assert_eq!(dir, PathBuf::from("/app/engine-wrapper"));
    }
}
