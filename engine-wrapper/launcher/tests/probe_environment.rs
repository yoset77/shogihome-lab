//! Probe the real engine-spawn path without mutating the test runner's environment.

use shogihome_launcher::editor::probe_usi_options;
use std::process::Command;
use std::sync::atomic::AtomicBool;

#[test]
fn probe_does_not_inherit_wrapper_access_token() {
    const CHILD: &str = "SHOGIHOME_TEST_PROBE_ENV_CHILD";
    const CUSTOM: &str = "SHOGIHOME_TEST_ENGINE_LIBRARY";
    if std::env::var_os(CHILD).is_none() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "probe_does_not_inherit_wrapper_access_token",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env(CUSTOM, "fixture-library-path")
            .env(
                "WRAPPER_ACCESS_TOKEN",
                "probe-test-token-at-least-32-characters",
            );
        // Windows environment names are case-insensitive, including removals.
        #[cfg(windows)]
        command.env_remove("WRAPPER_ACCESS_TOKEN").env(
            "wrapper_access_token",
            "probe-test-token-at-least-32-characters",
        );
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    assert!(std::env::var_os("WRAPPER_ACCESS_TOKEN").is_some());
    let dir = std::env::temp_dir().join(format!("probe-environment-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("engine.py");
    std::fs::write(&script, "import json,os,sys\nwith open('environment.json','w') as f:\n json.dump({'token_present': 'WRAPPER_ACCESS_TOKEN' in os.environ, 'path': os.environ.get('PATH'), 'library': os.environ.get('SHOGIHOME_TEST_ENGINE_LIBRARY')}, f)\nfor line in sys.stdin:\n if line.strip() == 'usi': print('usiok',flush=True)\n elif line.strip() == 'quit': break\n").unwrap();
    let launcher = dir.join(if cfg!(windows) {
        "engine probe.cmd"
    } else {
        "engine probe.sh"
    });
    std::fs::write(
        &launcher,
        if cfg!(windows) {
            format!("@echo off\npython \"{}\"\n", script.display())
        } else {
            format!("#!/bin/sh\nexec python3 \"{}\"\n", script.display())
        },
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let result = probe_usi_options(&launcher, &dir, &AtomicBool::new(false));
    let environment: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("environment.json")).unwrap()).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    result.unwrap();
    assert_eq!(environment["token_present"], false);
    assert_eq!(environment["path"], std::env::var("PATH").unwrap());
    assert_eq!(environment["library"], "fixture-library-path");
}
