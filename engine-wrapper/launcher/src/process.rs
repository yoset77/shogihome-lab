//! Child-process ownership: POSIX process groups and Windows Job Objects.
//!
//! The implementation lives in the shared [`shogihome_process`] crate so the
//! wrapper (tokio) and launcher (sync) cannot drift. This module keeps the
//! original `ManagedChild` / `spawn` names so existing callers are untouched.

pub use shogihome_process::{is_batch_script, spawn_sync as spawn, SyncChild as ManagedChild};
