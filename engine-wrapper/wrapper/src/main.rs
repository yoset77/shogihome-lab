//! `shogihome-wrapper`: standalone TCP relay between the ShogiHome server
//! and USI engines.
//!
//! Configuration (CLI wins over environment):
//! - `--config-dir <dir>` — directory holding `engines.json` (default: the
//!   directory containing this executable; never the process CWD).
//! - `BIND_ADDRESS` / `--bind-address` (default `127.0.0.1`)
//! - `LISTEN_PORT` / `--port` (default `4082`)
//! - `WRAPPER_ACCESS_TOKEN` (unset/empty disables authentication)

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::watch;

mod auth;
mod config;
mod encoding;
mod process;
mod relay;

use crate::config::{load_engines, log, resolve_config_dir};
use crate::relay::{handle_connection, RelayContext};

/// Graceful-shutdown deadline for live sessions (matches Node's 10s).
const SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

fn print_usage() {
    eprintln!("usage: shogihome-wrapper [--config-dir DIR] [--bind-address ADDR] [--port PORT]");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut config_override: Option<PathBuf> = None;
    let mut bind = std::env::var("BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1".to_string());
    let mut port: u16 = std::env::var("LISTEN_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4082);

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--config-dir" => {
                i += 1;
                if i >= args.len() {
                    print_usage();
                    std::process::exit(2);
                }
                config_override = Some(PathBuf::from(&args[i]));
            }
            "--bind-address" => {
                i += 1;
                if i >= args.len() {
                    print_usage();
                    std::process::exit(2);
                }
                bind = args[i].clone();
            }
            "--port" => {
                i += 1;
                match args.get(i).and_then(|v| v.parse().ok()) {
                    Some(p) => port = p,
                    None => {
                        print_usage();
                        std::process::exit(2);
                    }
                }
            }
            "--help" | "-h" => {
                print_usage();
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                print_usage();
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let config_dir = resolve_config_dir(&exe_dir, config_override.as_deref());

    let token = std::env::var("WRAPPER_ACCESS_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");
    rt.block_on(async_main(config_dir, bind, port, token));
}

async fn async_main(config_dir: PathBuf, bind: String, port: u16, token: Option<String>) {
    let listener = match TcpListener::bind((bind.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("failed to bind {bind}:{port}: {e}");
            std::process::exit(1);
        }
    };
    let engines = load_engines(&config_dir);
    log::info(&format!(
        "shogihome-wrapper listening on {bind}:{port} ({} engines, config {})",
        engines.len(),
        config_dir.display()
    ));
    for e in &engines {
        let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let path = e.get("path").and_then(|v| v.as_str()).unwrap_or("?");
        log::info(&format!("  - {id}: {name} ({path})"));
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let ctx = RelayContext {
        config_dir: Arc::from(config_dir),
        access_token: token.map(|t| Arc::from(t.as_str())),
        shutdown: shutdown_rx,
    };

    let notify = Arc::new(tokio::sync::Notify::new());
    let notify_signal = notify.clone();
    tokio::spawn(async move {
        wait_for_signal().await;
        notify_signal.notify_one();
    });

    let mut sessions = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = notify.notified() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let ctx = ctx.clone();
                    sessions.spawn(async move {
                        handle_connection(stream, ctx).await;
                    });
                    // Reap finished session tasks so the set stays small.
                    while sessions.try_join_next().is_some() {}
                }
                Err(e) => {
                    log::warn_compat(&format!("accept failed: {e}"));
                }
            },
        }
    }

    log::info("shutdown requested; draining sessions");
    shutdown_tx.send_replace(true);
    match tokio::time::timeout(SHUTDOWN_DEADLINE, sessions.join_all()).await {
        Ok(_) => {
            log::info("all sessions closed; exiting");
        }
        Err(_) => {
            log::warn_compat("shutdown deadline exceeded; forcing exit");
            std::process::exit(1);
        }
    }
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("failed to watch SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
