//! The runtime builder and launcher must agree on native executable names.
use shogihome_launcher::service::portable_services;

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
        "LISTEN_PORT=14082\nBIND_ADDRESS=127.0.0.1\n",
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
}
