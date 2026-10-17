//! Transport resource limits, independent of USI session state.

use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

const MAX_CONNECTIONS: usize = 128;
const MAX_INITIAL_CONNECTIONS: usize = 32;
pub const INITIAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub struct ConnectionLimits {
    connections: Arc<Semaphore>,
    initial: Arc<Semaphore>,
}

pub struct ConnectionPermit {
    _connection: OwnedSemaphorePermit,
    initial: Option<OwnedSemaphorePermit>,
    pub deadline: Instant,
}

impl ConnectionLimits {
    pub fn new() -> Self {
        Self::with_capacity(MAX_CONNECTIONS, MAX_INITIAL_CONNECTIONS)
    }

    fn with_capacity(total: usize, initial: usize) -> Self {
        Self {
            connections: Arc::new(Semaphore::new(total)),
            initial: Arc::new(Semaphore::new(initial)),
        }
    }

    /// Never queue a task waiting for admission: reject excess sockets instead.
    pub fn try_accept(&self) -> Option<ConnectionPermit> {
        let connection = self.connections.clone().try_acquire_owned().ok()?;
        let initial = self.initial.clone().try_acquire_owned().ok()?;
        Some(ConnectionPermit {
            _connection: connection,
            initial: Some(initial),
            deadline: Instant::now() + INITIAL_TIMEOUT,
        })
    }
}

impl ConnectionPermit {
    pub fn finish_initial(&mut self) {
        self.initial.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn limits_initial_and_total_connections_and_releases_permits() {
        let limits = ConnectionLimits::with_capacity(2, 1);
        let mut first = limits.try_accept().unwrap();
        assert!(limits.try_accept().is_none());
        first.finish_initial();
        let mut second = limits.try_accept().unwrap();
        second.finish_initial();
        assert!(limits.try_accept().is_none());
        drop(first);
        let third = limits.try_accept().unwrap();
        assert!(limits.try_accept().is_none());
        drop(third);
        assert!(limits.try_accept().is_some());
    }
}
