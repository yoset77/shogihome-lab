//! Portable layout shared by supervision and the editor. Native bundles and
//! installed data directories are deliberately a separate distribution concern.
use std::path::{Path, PathBuf};

pub fn executable_name(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

#[derive(Debug, Clone)]
pub struct PortablePaths {
    pub root: PathBuf,
}

impl PortablePaths {
    pub fn new(root: &Path) -> std::io::Result<Self> {
        Ok(Self {
            root: std::path::absolute(root)?,
        })
    }

    pub fn from_executable(exe: &Path) -> std::io::Result<Self> {
        let exe = std::path::absolute(exe)?;
        Self::new(
            exe.parent()
                .ok_or_else(|| std::io::Error::other("executable has no parent"))?,
        )
    }

    pub fn server_dir(&self) -> PathBuf {
        self.root.join("shogihome")
    }

    pub fn config_dir(&self) -> PathBuf {
        self.root.join("engine-wrapper")
    }

    pub fn editor_config_dir(&self, override_dir: Option<&Path>) -> std::io::Result<PathBuf> {
        override_dir.map_or_else(|| Ok(self.config_dir()), std::path::absolute)
    }

    pub fn server_program(&self) -> PathBuf {
        self.server_dir().join(executable_name("shogihome-server"))
    }

    pub fn wrapper_program(&self) -> PathBuf {
        self.root.join(executable_name("wrapper"))
    }

    pub fn env_paths(&self) -> crate::settings::EnvPaths {
        crate::settings::EnvPaths::new(&self.server_dir(), &self.config_dir())
    }

    pub fn log_dir(&self) -> PathBuf {
        self.config_dir().join("logs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_and_services_share_the_executable_relative_layout() {
        let root = std::env::temp_dir().join("portable 日本語 folder");
        let paths =
            PortablePaths::from_executable(&root.join(executable_name("ShogiHomeLab"))).unwrap();
        assert_eq!(paths.root, root);
        assert_eq!(paths.editor_config_dir(None).unwrap(), paths.config_dir());
        let relative = Path::new("relative config");
        assert_eq!(
            paths.editor_config_dir(Some(relative)).unwrap(),
            std::path::absolute(relative).unwrap()
        );
        assert_eq!(paths.config_dir(), root.join("engine-wrapper"));
        assert_eq!(paths.env_paths().wrapper, root.join("engine-wrapper/.env"));
    }
}
