//! Launcher launch mode: full dashboard vs standalone config editor.
//!
//! The standalone editor exists so engine-side hosts (remote PC, Docker
//! split, etc.) can run `ShogiHomeLab[.exe] --config-editor` without the
//! Middle Server bundle. It shares the editor backend (`editor.rs`) and the
//! Tauri shell, but never spawns services, never shows the dashboard or
//! tray, and exits when the editor window closes.
//!
//! `--config-dir` uses the same meaning as the wrapper's `--config-dir`:
//! the directory holding `engines.json`. Relative engine paths and USI
//! probes resolve against it. When omitted, the portable layout default
//! (`<exe-dir>/engine-wrapper`) is used.

use std::path::PathBuf;

use crate::error::LauncherError;

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
    pub tray_enabled: bool,
}

pub fn usage() -> String {
    format!(
        "usage: {} [--config-editor [--config-dir DIR]] [--tray | --no-tray] [--help]",
        crate::paths::executable_name("ShogiHomeLab")
    )
}

/// Parse `std::env::args`-style arguments (including argv[0]).
///
/// Unknown flags are an error so typos fail loudly instead of silently
/// starting the wrong mode. `--config-dir` requires `--config-editor`:
/// the launcher keeps its portable `dist_root` layout so service
/// supervision, migration, and readiness stay on one snapshot, and an
/// editor pointed elsewhere would save settings the supervised wrapper
/// never reads.
pub fn parse_args(args: &[String]) -> Result<LaunchConfig, LauncherError> {
    let mut mode = LaunchMode::Launcher;
    let mut config_dir_override = None;
    let mut show_help = false;
    let mut tray_override = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--config-editor" => mode = LaunchMode::ConfigEditor,
            "--tray" | "--no-tray" => {
                let enabled = args[i] == "--tray";
                if tray_override.is_some_and(|previous| previous != enabled) {
                    return Err(LauncherError::msg(format!(
                        "{}\n{}",
                        crate::native_text::text("trayConflict"),
                        usage()
                    )));
                }
                tray_override = Some(enabled);
            }
            "--config-dir" => {
                i += 1;
                match args.get(i) {
                    // A following flag is a missing value, not a directory.
                    Some(dir) if !dir.trim().is_empty() && !dir.starts_with("--") => {
                        config_dir_override = Some(PathBuf::from(dir));
                    }
                    _ => {
                        return Err(LauncherError::msg(format!(
                            "missing value for --config-dir\n{usage}",
                            usage = usage()
                        )));
                    }
                }
            }
            "--help" | "-h" => show_help = true,
            other => {
                return Err(LauncherError::msg(format!(
                    "unknown argument: {other}\n{usage}",
                    usage = usage()
                )));
            }
        }
        i += 1;
    }
    if config_dir_override.is_some() && mode != LaunchMode::ConfigEditor {
        return Err(LauncherError::msg(format!(
            "--config-dir requires --config-editor\n{usage}",
            usage = usage()
        )));
    }
    if mode == LaunchMode::ConfigEditor && tray_override.is_some() {
        return Err(LauncherError::msg(format!(
            "{}\n{}",
            crate::native_text::text("trayLauncherOnly"),
            usage()
        )));
    }
    Ok(LaunchConfig {
        mode,
        config_dir_override,
        show_help,
        // Linux tray construction can succeed without a visible tray host.
        // Make residency opt-in there; --no-tray works on every desktop OS.
        tray_enabled: mode == LaunchMode::Launcher
            && tray_override.unwrap_or(!cfg!(target_os = "linux")),
    })
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
    fn tray_residency_is_explicit_and_editor_never_uses_it() {
        assert_eq!(
            parse_args(&args(&["app"])).unwrap().tray_enabled,
            !cfg!(target_os = "linux")
        );
        assert!(
            !parse_args(&args(&["app", "--no-tray"]))
                .unwrap()
                .tray_enabled
        );
        assert!(parse_args(&args(&["app", "--tray"])).unwrap().tray_enabled);
        assert!(
            !parse_args(&args(&["app", "--config-editor"]))
                .unwrap()
                .tray_enabled
        );
        assert!(parse_args(&args(&["app", "--tray", "--no-tray"])).is_err());
        assert!(parse_args(&args(&["app", "--config-editor", "--tray"])).is_err());
        assert!(parse_args(&args(&["app", "--config-editor", "--no-tray"])).is_err());
    }
}
