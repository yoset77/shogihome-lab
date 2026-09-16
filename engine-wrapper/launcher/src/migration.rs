//! First-run data migration from an older portable folder.
//!
//! Trigger: `shogihome/data` absent in the new installation. The UI asks the
//! user, resolves the old root (tolerating one extra ZIP-nesting level),
//! previews what exists, then executes: data dir (staged copy + rename),
//! `engines.json` (atomic copy), both `.env` files (smart merge).
//!
//! Improvements over `launcher.py::_check_and_run_migration`:
//! - a completion record (`.migration.json`) distinguishes "never tried"
//!   from "partially copied", so a failed run can resume instead of
//!   silently never offering migration again;
//! - the data copy lands in `data.tmp` and is renamed only on success.

use std::path::{Path, PathBuf};

use crate::env_codec::smart_merge_env;
use crate::error::LauncherError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPlan {
    pub old_root: PathBuf,
    pub has_data: bool,
    pub has_engines: bool,
    pub has_any_env: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPaths {
    pub data_dir: PathBuf,
    pub engines_json: PathBuf,
    pub server_env: PathBuf,
    pub wrapper_env: PathBuf,
}

impl MigrationPaths {
    pub fn new(dist_root: &Path) -> Self {
        Self {
            data_dir: dist_root.join("shogihome").join("data"),
            engines_json: dist_root.join("engine-wrapper").join("engines.json"),
            server_env: dist_root.join("shogihome").join(".env"),
            wrapper_env: dist_root.join("engine-wrapper").join(".env"),
        }
    }

    pub fn needs_migration(&self) -> bool {
        match load_record(&self.completion_record()) {
            Some(record) => !record.is_complete(),
            None => !self.data_dir.exists(),
        }
    }

    pub fn pending_source(&self) -> Option<PathBuf> {
        load_record(&self.completion_record())
            .filter(|record| !record.is_complete())
            .map(|record| PathBuf::from(record.old_root))
    }

    pub fn completion_record(&self) -> PathBuf {
        self.engines_json.with_extension("migration.json")
    }
}

/// Resolve the old installation root, tolerating one extra nesting level
/// from ZIP extraction (ported from the launcher).
pub fn resolve_old_root(selected: &Path) -> PathBuf {
    if selected.join("shogihome").exists() {
        return selected.to_path_buf();
    }
    if let Ok(entries) = std::fs::read_dir(selected) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("shogihome").exists() {
                return path;
            }
        }
    }
    selected.to_path_buf()
}

/// Inspect the old root and describe what can be migrated.
pub fn plan_migration(old_root: &Path) -> MigrationPlan {
    let has_data = old_root.join("shogihome").join("data").exists();
    let has_engines = old_root
        .join("engine-wrapper")
        .join("engines.json")
        .exists();
    let has_any_env = old_root.join("shogihome").join(".env").exists()
        || old_root.join("engine-wrapper").join(".env").exists();
    MigrationPlan {
        old_root: old_root.to_path_buf(),
        has_data,
        has_engines,
        has_any_env,
    }
}

impl MigrationPlan {
    /// Human-readable list of missing sources (for the "continue anyway?"
    /// prompt). Empty = everything present.
    pub fn missing(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if !self.has_data {
            out.push("shogihome/data");
        }
        if !self.has_engines {
            out.push("engine-wrapper/engines.json");
        }
        if !self.has_any_env {
            out.push(".env files");
        }
        out
    }

    pub fn has_nothing(&self) -> bool {
        !self.has_data && !self.has_engines && !self.has_any_env
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct CompletionRecord {
    old_root: String,
    data_copied: bool,
    engines_copied: bool,
    envs_merged: bool,
    #[serde(default)]
    finished: bool,
}

impl CompletionRecord {
    fn is_complete(&self) -> bool {
        self.finished || (self.data_copied && self.engines_copied && self.envs_merged)
    }
}

/// Execute the migration. Idempotent: completed steps are skipped on retry.
pub fn execute_migration(plan: &MigrationPlan, dest: &MigrationPaths) -> Result<(), LauncherError> {
    if plan.has_nothing() {
        return Err(LauncherError::msg(
            "no migratable data found in the selected folder",
        ));
    }
    let record_path = dest.completion_record();
    let mut record = load_record(&record_path).unwrap_or(CompletionRecord {
        old_root: plan.old_root.to_string_lossy().into_owned(),
        data_copied: false,
        engines_copied: false,
        envs_merged: false,
        finished: false,
    });
    if Path::new(&record.old_root) != plan.old_root {
        return Err(LauncherError::msg(
            "resume migration from the original source folder",
        ));
    }
    // Persist intent before publishing data, including if a later write fails.
    save_record(&record_path, &record)?;

    if plan.has_data && !record.data_copied {
        copy_dir_staged(
            &plan.old_root.join("shogihome").join("data"),
            &dest.data_dir,
        )?;
        record.data_copied = true;
        save_record(&record_path, &record)?;
    }
    if plan.has_engines && !record.engines_copied {
        copy_file_atomic(
            &plan.old_root.join("engine-wrapper").join("engines.json"),
            &dest.engines_json,
        )?;
        record.engines_copied = true;
        save_record(&record_path, &record)?;
    }
    if plan.has_any_env && !record.envs_merged {
        let old_server = plan.old_root.join("shogihome").join(".env");
        let old_wrapper = plan.old_root.join("engine-wrapper").join(".env");
        if old_server.exists() {
            smart_merge_env(&old_server, &dest.server_env, &dest.server_env)?;
        }
        if old_wrapper.exists() {
            smart_merge_env(&old_wrapper, &dest.wrapper_env, &dest.wrapper_env)?;
        }
        record.envs_merged = true;
        save_record(&record_path, &record)?;
    }
    record.finished = true;
    save_record(&record_path, &record)
}

fn load_record(path: &Path) -> Option<CompletionRecord> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_record(path: &Path, record: &CompletionRecord) -> Result<(), LauncherError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| LauncherError::io(format!("creating {}", parent.display()), e))?;
    }
    let content = serde_json::to_string_pretty(record)
        .map_err(|e| LauncherError::json("serializing migration record".to_string(), e))?;
    shogihome_env_file::write_atomic(path, content.as_bytes())
        .map_err(|e| LauncherError::io(format!("writing {}", path.display()), e))
}

fn copy_file_atomic(src: &Path, dest: &Path) -> Result<(), LauncherError> {
    shogihome_env_file::copy_file_atomic(src, dest)
        .map_err(|e| LauncherError::io(format!("copying {}", dest.display()), e))
}

fn copy_dir_contents(src: &Path, dest: &Path) -> Result<(), LauncherError> {
    std::fs::create_dir_all(dest)
        .map_err(|e| LauncherError::io(format!("creating {}", dest.display()), e))?;
    let entries = std::fs::read_dir(src)
        .map_err(|e| LauncherError::io(format!("reading {}", src.display()), e))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| LauncherError::io(format!("reading {}", src.display()), e))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| LauncherError::io(format!("reading {}", from.display()), e))?;
        if file_type.is_dir() {
            copy_dir_contents(&from, &to)?;
        } else if file_type.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|e| LauncherError::io(format!("copying {}", to.display()), e))?;
        }
        // Symlinks and special files are skipped deliberately.
    }
    Ok(())
}

fn copy_dir_staged(src: &Path, dest: &Path) -> Result<(), LauncherError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| LauncherError::io(format!("creating {}", parent.display()), e))?;
    }
    let staging = dest.with_extension("tmp");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| LauncherError::io(format!("cleaning {}", staging.display()), e))?;
    }
    copy_dir_contents(src, &staging)?;
    if dest.exists() {
        // Another concurrent run finished first; keep the winner.
        std::fs::remove_dir_all(&staging)
            .map_err(|e| LauncherError::io(format!("cleaning {}", staging.display()), e))?;
        return Ok(());
    }
    std::fs::rename(&staging, dest)
        .map_err(|e| LauncherError::io(format!("publishing {}", dest.display()), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_old(base: &Path) {
        std::fs::create_dir_all(base.join("shogihome").join("data")).unwrap();
        std::fs::write(base.join("shogihome").join("data").join("a.db"), b"data").unwrap();
        std::fs::create_dir_all(base.join("engine-wrapper")).unwrap();
        std::fs::write(base.join("engine-wrapper").join("engines.json"), b"[]").unwrap();
        std::fs::write(base.join("shogihome").join(".env"), b"PORT=9000\n").unwrap();
    }

    #[test]
    fn nested_root_and_plan() {
        let base = std::env::temp_dir().join(format!("mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("outer");
        fixture_old(&nested.join("inner"));
        assert_eq!(resolve_old_root(&nested), nested.join("inner"));
        let plan = plan_migration(&nested.join("inner"));
        assert!(plan.missing().is_empty());
        assert!(!plan.has_nothing());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn execute_copies_and_resumes() {
        let base = std::env::temp_dir().join(format!("mig2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("old");
        fixture_old(&old);
        let dest = MigrationPaths::new(&base.join("new"));
        std::fs::create_dir_all(dest.server_env.parent().unwrap()).unwrap();
        std::fs::write(&dest.server_env, b"PORT=8140\nOTHER=1\n").unwrap();

        let plan = plan_migration(&old);
        execute_migration(&plan, &dest).unwrap();
        assert_eq!(std::fs::read(dest.data_dir.join("a.db")).unwrap(), b"data");
        assert_eq!(std::fs::read_to_string(&dest.engines_json).unwrap(), "[]");
        // Old PORT overlays the template; OTHER survives.
        let merged = std::fs::read_to_string(&dest.server_env).unwrap();
        assert!(merged.contains("PORT=9000"));
        assert!(merged.contains("OTHER=1"));
        // Second run is a no-op success (resume path).
        execute_migration(&plan, &dest).unwrap();
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn partial_migration_remains_available_after_data_copy() {
        let base = std::env::temp_dir().join(format!("mig-resume-{}", std::process::id()));
        let dest = MigrationPaths::new(&base);
        std::fs::create_dir_all(&dest.data_dir).unwrap();
        save_record(
            &dest.completion_record(),
            &CompletionRecord {
                old_root: "old".into(),
                data_copied: true,
                engines_copied: false,
                envs_merged: false,
                finished: false,
            },
        )
        .unwrap();
        assert!(dest.needs_migration());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn failed_registry_copy_can_resume_without_starting_services() {
        let base = std::env::temp_dir().join(format!("mig-failed-{}", std::process::id()));
        let old = base.join("old");
        fixture_old(&old);
        let root = base.join("new");
        let dest = MigrationPaths::new(&root);
        // Force the engines.json publication to fail after data is published.
        std::fs::create_dir_all(&dest.engines_json).unwrap();
        let plan = plan_migration(&old);
        assert!(execute_migration(&plan, &dest).is_err());
        assert!(dest.data_dir.join("a.db").exists());
        assert!(dest.needs_migration());
        assert!(crate::service::portable_services(&root).is_err());
        std::fs::remove_dir(&dest.engines_json).unwrap();
        execute_migration(&plan, &dest).unwrap();
        assert!(!dest.needs_migration());
        assert!(crate::service::portable_services(&root).is_ok());
        assert_eq!(
            std::fs::read_to_string(dest.server_env).unwrap(),
            "PORT=9000\n"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn empty_old_root_is_an_error() {
        let base = std::env::temp_dir().join(format!("mig3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(old_join(&base)).unwrap();
        let plan = plan_migration(&base);
        assert_eq!(plan.missing().len(), 3);
        let dest = MigrationPaths::new(&base.join("new"));
        assert!(execute_migration(&plan, &dest).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    fn old_join(base: &Path) -> PathBuf {
        base.to_path_buf()
    }
}
