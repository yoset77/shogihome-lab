//! Launcher backend: service supervision, settings persistence, data
//! migration, log handling, and update checks.
//!
//! UI-agnostic and synchronous so it can be unit-tested on any platform.
//! The native Tauri command layer binds UI requests to this logic;
//! the UI never spawns processes or writes config files directly.

pub mod controller;
pub mod editor;
pub mod editor_session;
pub mod env_codec;
pub mod error;
pub mod launch_mode;
pub mod lifecycle;
pub mod logs;
pub mod migration;
pub mod native_text;
pub mod network;
pub mod paths;
pub mod permissions;
pub mod process;
pub mod service;
pub mod session_lock;
pub mod settings;
pub mod supervisor;
pub mod update;
