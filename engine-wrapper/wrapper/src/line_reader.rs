//! Bounded line reader for TCP client input.
//!
//! `tokio::io::read_until` appends until a newline arrives, so checking the
//! length *after* it returns cannot bound memory when the peer never sends
//! `\n`. This helper enforces `MAX_LINE_BYTES` *while* reading: each fill
//! is limited to the remaining budget, and the connection is closed as soon
//! as the budget is exceeded without a newline.
//!
//! The caller owns `buf` across calls so a line split over many TCP segments
//! — or a `select!` that picks another branch mid-line — never loses the
//! already-received prefix. A `buf` that already holds a complete line is
//! consumed without doing I/O.

use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::sync::watch;

use crate::encoding::MAX_LINE_BYTES;

/// Read one `\n`-terminated line, returning the trimmed text.
///
/// `buf` is the caller's scratch space, reused across calls. On success the
/// consumed line (including its newline) is drained from `buf`, leaving any
/// pipelined bytes for the next call. Returns `None` on EOF (no complete
/// line), read error, oversized line, or listener shutdown. The newline
/// counts toward `MAX_LINE_BYTES` (legacy parity: a line totaling more than
/// `MAX_LINE_BYTES` including `\n` is rejected).
pub async fn read_line_bounded<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<String> {
    loop {
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            if pos + 1 > MAX_LINE_BYTES {
                return None;
            }
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line);
            return Some(text.trim_end_matches(['\r', '\n']).to_string());
        }
        if buf.len() >= MAX_LINE_BYTES {
            // No newline within budget: any continuation would exceed it.
            return None;
        }
        let remaining = MAX_LINE_BYTES.saturating_sub(buf.len()) as u64;
        // `take` borrows `reader`; keep it alive across the `select!`.
        let mut limited = reader.take(remaining);
        let filled = tokio::select! {
            biased;
            _ = shutdown.changed() => return None,
            result = limited.read_until(b'\n', buf) => match result {
                Ok(0) => return None,
                Ok(n) => n,
                Err(_) => return None,
            },
        };
        let _ = filled;
        // Loop to consume the line or detect oversize on the next pass.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    fn shutdown() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    #[tokio::test]
    async fn consumes_pipelined_lines_without_io() {
        let data = b"run a\nusi\n".to_vec();
        let mut reader = BufReader::new(&data[..]);
        let (_tx, mut sd) = shutdown();
        let mut buf = Vec::new();
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf, &mut sd)
                .await
                .as_deref(),
            Some("run a")
        );
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf, &mut sd)
                .await
                .as_deref(),
            Some("usi")
        );
    }

    #[tokio::test]
    async fn split_lines_across_reads_are_preserved() {
        use tokio::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let writer = tokio::spawn(async move {
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            use tokio::io::AsyncWriteExt;
            s.write_all(b"hel").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            s.write_all(b"lo\nnext\n").await.unwrap();
        });
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let (_tx, mut sd) = shutdown();
        let mut buf = Vec::new();
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf, &mut sd)
                .await
                .as_deref(),
            Some("hello")
        );
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf, &mut sd)
                .await
                .as_deref(),
            Some("next")
        );
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn newline_less_input_is_bounded() {
        use tokio::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let writer = tokio::spawn(async move {
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            use tokio::io::AsyncWriteExt;
            // No newline, well over the budget.
            let chunk = vec![b'x'; 64 * 1024];
            for _ in 0..64 {
                if s.write_all(&chunk).await.is_err() {
                    return;
                }
            }
            // Hold the connection open without FIN: the reader must give up
            // by budget, not by close.
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        });
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let (_tx, mut sd) = shutdown();
        let mut buf = Vec::new();
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            read_line_bounded(&mut reader, &mut buf, &mut sd),
        )
        .await;
        assert!(result.is_ok(), "bounded read must finish without FIN");
        assert!(
            result.unwrap().is_none(),
            "oversize must close, not return a line"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(
            buf.len() <= MAX_LINE_BYTES,
            "buffer must stay bounded, got {}",
            buf.len()
        );
        writer.abort();
    }

    #[tokio::test]
    async fn boundary_exact_limit_succeeds_one_over_fails() {
        let mut buf = Vec::new();
        // Total exactly MAX_LINE_BYTES including the newline: accepted.
        let mut data = vec![b'a'; MAX_LINE_BYTES - 1];
        data.push(b'\n');
        let mut reader = BufReader::new(&data[..]);
        let (_tx, mut sd) = shutdown();
        let line = read_line_bounded(&mut reader, &mut buf, &mut sd).await;
        assert!(line.is_some());
        assert_eq!(line.unwrap().len(), MAX_LINE_BYTES - 1);
        // One byte more (total MAX_LINE_BYTES + 1): rejected.
        let mut data2 = vec![b'b'; MAX_LINE_BYTES];
        data2.push(b'\n');
        let mut reader2 = BufReader::new(&data2[..]);
        let mut buf2 = Vec::new();
        let (_tx2, mut sd2) = shutdown();
        assert!(read_line_bounded(&mut reader2, &mut buf2, &mut sd2)
            .await
            .is_none());
    }
}
