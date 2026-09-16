//! `shogihome-wrapper`: standalone TCP relay between the ShogiHome server
//! and USI engines.
//!
//! Configuration (CLI > environment > `<config-dir>/.env` > defaults):
//! - `--config-dir <dir>` — directory holding `engines.json` and `.env`
//!   (default: `<exe-dir>/engine-wrapper` when it holds `engines.json`,
//!   else the directory containing this executable; never the process
//!   CWD and never an ancestor search).
//! - `BIND_ADDRESS` / `--bind-address` (default `127.0.0.1`)
//! - `LISTEN_PORT` / `--port` (default `4082`)
//! - `WRAPPER_ACCESS_TOKEN` (unset/empty disables authentication)
//! - `--no-env-file` — skip `<config-dir>/.env` (the launcher passes this
//!   and hands over an already-resolved environment snapshot instead).
//!
//! File values are literal (`${VAR}` is not expanded). An explicitly
//! exported (even empty) environment variable always wins over the file.
//!
//! Only `BIND_ADDRESS`, `LISTEN_PORT`, and `WRAPPER_ACCESS_TOKEN` are read
//! from `<config-dir>/.env`. Other entries are ignored and never reach
//! engines: engines inherit the OS/launcher process environment (PATH and
//! system-wide GPU/library setup belong there). The launcher forwards the
//! same three keys to supervised wrappers, so standalone and supervised
//! launches observe the same engine environment.

use std::path::PathBuf;
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
    eprintln!(
        "usage: shogihome-wrapper [--config-dir DIR] [--bind-address ADDR] [--port PORT] [--no-env-file]"
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut config_override: Option<PathBuf> = None;
    let mut cli_bind: Option<String> = None;
    let mut cli_port: Option<u16> = None;
    let mut no_env_file = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--config-dir" => {
                i += 1;
                match args.get(i) {
                    Some(dir) if !dir.starts_with("--") => {
                        config_override = Some(PathBuf::from(dir));
                    }
                    _ => {
                        eprintln!("missing value for --config-dir");
                        print_usage();
                        std::process::exit(2);
                    }
                }
            }
            "--bind-address" => {
                i += 1;
                match args.get(i) {
                    Some(addr) if !addr.starts_with("--") => {
                        cli_bind = Some(addr.clone());
                    }
                    _ => {
                        eprintln!("missing value for --bind-address");
                        print_usage();
                        std::process::exit(2);
                    }
                }
            }
            "--port" => {
                i += 1;
                match args.get(i).and_then(|v| v.parse::<u16>().ok()) {
                    Some(p) => cli_port = Some(p),
                    None => {
                        eprintln!("missing or invalid value for --port");
                        print_usage();
                        std::process::exit(2);
                    }
                }
            }
            "--no-env-file" => no_env_file = true,
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
    let config_dir = resolve_config_dir(&exe, config_override.as_deref());

    let file_values = if no_env_file {
        std::collections::HashMap::new()
    } else {
        let content = match shogihome_env_file::read_env_file(&config_dir.join(".env")) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("failed to read {}: {e}", config_dir.join(".env").display());
                std::process::exit(1);
            }
        };
        shogihome_env_file::parse_env(&content)
    };
    let mut env_values = std::collections::HashMap::new();
    for key in ["BIND_ADDRESS", "LISTEN_PORT", "WRAPPER_ACCESS_TOKEN"] {
        // Presence (even empty) beats the file, like load_dotenv.
        if let Ok(value) = std::env::var(key) {
            env_values.insert(key.to_string(), value);
        }
    }
    let runtime =
        match crate::config::resolve_runtime(cli_bind, cli_port, &env_values, &file_values) {
            Ok(runtime) => runtime,
            Err(e) => {
                eprintln!("invalid wrapper configuration: {e}");
                std::process::exit(2);
            }
        };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");
    rt.block_on(async_main(
        config_dir,
        runtime.bind,
        runtime.port,
        runtime.token,
    ));
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
