//! Launcher backend: service supervision, settings persistence, data
//! migration, log handling, and update checks.
//!
//! UI-agnostic and synchronous so it can be unit-tested on any platform.
//! The Tauri command layer (later phase) binds UI requests to this logic;
//! the UI never spawns processes or writes config files directly.

pub mod editor;
pub mod env_codec;
pub mod logs;
pub mod migration;
pub mod network;
pub mod permissions;
pub mod service;
pub mod settings;
pub mod supervisor;
pub mod update;
