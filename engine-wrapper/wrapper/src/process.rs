//! Engine process ownership: POSIX process groups and Windows Job Objects.
//!
//! The implementation lives in the shared [`shogihome_process`] crate (async
//! child) so the wrapper and launcher cannot drift. This module keeps the
//! original `EngineChild` / `spawn_engine` / `is_not_found` names so the
//! relay is untouched.

pub use shogihome_process::{
    is_not_found, spawn_async_engine as spawn_engine, AsyncChild as EngineChild,
};
