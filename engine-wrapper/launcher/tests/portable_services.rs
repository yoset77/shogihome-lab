//! The runtime builder and launcher must agree on native executable names.
use shogihome_launcher::service::{
    portable_services, portable_services_with_env, portable_services_with_env_with,
};

#[test]
fn portable_plan_uses_native_names_and_one_config_snapshot() {
    let root = std::env::temp_dir().join(format!("portable 設定 {}", std::process::id()));
    std::fs::create_dir_all(root.join("shogihome")).unwrap();
    std::fs::create_dir_all(root.join("engine-wrapper")).unwrap();
    std::fs::write(
        root.join("shogihome/.env"),
        "PORT=18140\nBIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    std::fs::write(
        root.join("engine-wrapper/.env"),
        "LISTEN_PORT=14082\nBIND_ADDRESS=127.0.0.1\nCUDA_VISIBLE_DEVICES=0\n",
    )
    .unwrap();
    let plan = portable_services(&root).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    let suffix = std::env::consts::EXE_SUFFIX;
    assert_eq!(
        plan.specs[0].program,
        root.join(format!("shogihome/shogihome-server{suffix}"))
    );
    assert_eq!(plan.specs[1].program, root.join(format!("wrapper{suffix}")));
    assert_eq!(plan.specs[1].cwd, root.join("engine-wrapper"));
    assert_eq!(
        plan.specs[1].args,
        [
            "--config-dir",
            root.join("engine-wrapper").to_str().unwrap(),
            "--no-env-file"
        ]
    );
    assert_eq!(plan.expectations["server"].port, 18140);
    assert_eq!(plan.expectations["wrapper"].port, 14082);
    assert!(plan.specs[1]
        .env
        .contains(&("LISTEN_PORT".into(), "14082".into())));
    // Wrapper config extras never reach engines: standalone resolves the
    // same three keys, so supervised launches must match.
    assert!(
        !plan.specs[1]
            .env
            .iter()
            .any(|(k, _)| k == "CUDA_VISIBLE_DEVICES"),
        "wrapper snapshot must drop non-forwarded keys: {:?}",
        plan.specs[1].env
    );
}

#[test]
fn server_snapshot_uses_node_parseenv_for_quoted_paths() {
    use std::process::Command;
    // Requires Node for the parseEnv reference; the shared parser alone
    // would expand `\t`/`\r` python-dotenv style.
    let node_ok = Command::new("node")
        .args(["-e", "process.exit(0)"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !node_ok {
        return;
    }
    let root = std::env::temp_dir().join(format!("portable-node-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("shogihome")).unwrap();
    std::fs::create_dir_all(root.join("engine-wrapper")).unwrap();
    std::fs::write(
        root.join("shogihome/.env"),
        "PORT=18141\nBIND_ADDRESS=127.0.0.1\nKIFU_DIR=\"C:\\temp\\records\"\n",
    )
    .unwrap();
    std::fs::write(
        root.join("engine-wrapper/.env"),
        "LISTEN_PORT=14083\nBIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    let plan = portable_services(&root).unwrap();
    std::fs::remove_dir_all(&root).ok();
    let server_env: std::collections::HashMap<_, _> =
        plan.specs[0].env.clone().into_iter().collect();
    // Node keeps `\t` literal; the legacy python shape would be TAB + CR.
    assert_eq!(
        server_env.get("KIFU_DIR").map(String::as_str),
        Some("C:\\temp\\records")
    );
}

#[test]
fn exported_env_wins_over_file_for_both_services() {
    // Guard the Node-parity rule (parent env wins) without needing Node:
    // simple numeric values parse identically in both parsers. Uses an
    // explicit parent map so parallel tests never observe global env.
    let root = std::env::temp_dir().join(format!("portable-precedence-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("shogihome")).unwrap();
    std::fs::create_dir_all(root.join("engine-wrapper")).unwrap();
    std::fs::write(
        root.join("shogihome/.env"),
        "PORT=18142\nBIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    std::fs::write(
        root.join("engine-wrapper/.env"),
        "LISTEN_PORT=14084\nBIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    let parent = std::collections::HashMap::from([
        ("PORT".to_string(), "18143".to_string()),
        ("LISTEN_PORT".to_string(), "14085".to_string()),
    ]);
    let plan = portable_services_with_env(&root, &parent).unwrap();
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(plan.expectations["server"].port, 18143);
    assert_eq!(plan.expectations["wrapper"].port, 14085);
    let server_env: std::collections::HashMap<_, _> =
        plan.specs[0].env.clone().into_iter().collect();
    let wrapper_env: std::collections::HashMap<_, _> =
        plan.specs[1].env.clone().into_iter().collect();
    assert_eq!(server_env.get("PORT").map(String::as_str), Some("18143"));
    assert_eq!(
        wrapper_env.get("LISTEN_PORT").map(String::as_str),
        Some("14085")
    );
}

#[test]
fn windows_style_lowercase_parent_names_win_over_files() {
    // Windows env names are case-insensitive: lowercase exports must drive
    // both readiness and the child snapshot, keeping the file's key casing
    // so the child observes one unambiguous variable.
    let root = std::env::temp_dir().join(format!("portable-ci-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("shogihome")).unwrap();
    std::fs::create_dir_all(root.join("engine-wrapper")).unwrap();
    std::fs::write(
        root.join("shogihome/.env"),
        "PORT=18144\nBIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    std::fs::write(
        root.join("engine-wrapper/.env"),
        "LISTEN_PORT=14086\nBIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    let parent = std::collections::HashMap::from([
        ("port".to_string(), "18145".to_string()),
        ("listen_port".to_string(), "14087".to_string()),
    ]);
    let plan = portable_services_with_env_with(&root, &parent, true).unwrap();
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(plan.expectations["server"].port, 18145);
    assert_eq!(plan.expectations["wrapper"].port, 14087);
    let server_env: std::collections::HashMap<_, _> =
        plan.specs[0].env.clone().into_iter().collect();
    let wrapper_env: std::collections::HashMap<_, _> =
        plan.specs[1].env.clone().into_iter().collect();
    assert_eq!(server_env.get("PORT").map(String::as_str), Some("18145"));
    assert!(!server_env.contains_key("port"));
    assert_eq!(
        wrapper_env.get("LISTEN_PORT").map(String::as_str),
        Some("14087")
    );
    assert!(!wrapper_env.contains_key("listen_port"));
}
