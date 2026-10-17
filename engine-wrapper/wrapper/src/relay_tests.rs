use super::*;
use crate::admission::ConnectionLimits;
use tokio::io::AsyncBufReadExt;
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration, Instant};

async fn connection(
    token: Option<&str>,
) -> (
    BufReader<TcpStream>,
    tokio::task::JoinHandle<()>,
    watch::Sender<bool>,
    ConnectionLimits,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let (tx, shutdown) = watch::channel(false);
    let ctx = RelayContext {
        config_dir: Arc::from(Path::new("unused-admission-test")),
        access_token: token.map(Arc::from),
        #[cfg(windows)]
        engine_high_qos: false,
        shutdown,
    };
    let limits = ConnectionLimits::new();
    let mut permit = limits.try_accept().unwrap();
    permit.deadline = Instant::now() + Duration::from_millis(300);
    let task = tokio::spawn(handle_connection(server, ctx, permit));
    (BufReader::new(client), task, tx, limits)
}

#[tokio::test]
async fn idle_auth_and_unauthenticated_connections_expire() {
    for token in [None, Some("token")] {
        let (mut client, task, _shutdown, limits) = connection(token).await;
        let mut output = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut output))
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap();
        if token.is_some() {
            assert!(output.starts_with(b"auth_cram_sha256 "));
        } else {
            assert!(output.is_empty());
        }
        assert!(limits.try_accept().is_some());
    }
}

#[tokio::test]
async fn trickled_input_does_not_extend_the_deadline() {
    let (mut client, task, _shutdown, _limits) = connection(None).await;
    let mut closed = false;
    for _ in 0..20 {
        if client.get_mut().write_all(b"l").await.is_err() {
            break;
        }
        let mut byte = [0];
        match timeout(Duration::from_millis(50), client.read(&mut byte)).await {
            Ok(Ok(0)) | Ok(Err(_)) => {
                closed = true;
                break;
            }
            _ => {}
        }
    }
    timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(closed, "trickled input must not keep the connection alive");
}

#[tokio::test]
async fn auth_and_initial_command_share_one_deadline() {
    let (mut client, task, _shutdown, _limits) = connection(Some("token")).await;
    let mut challenge = String::new();
    client.read_line(&mut challenge).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let nonce = challenge.trim().strip_prefix("auth_cram_sha256 ").unwrap();
    let digest = auth::expected_digest("token", nonce);
    client
        .get_mut()
        .write_all(format!("auth {digest}\n").as_bytes())
        .await
        .unwrap();
    let mut reply = String::new();
    client.read_line(&mut reply).await.unwrap();
    assert_eq!(reply, "auth_ok\n");
    // Only the remainder of the original deadline is left for the command.
    timeout(Duration::from_millis(200), task)
        .await
        .unwrap()
        .unwrap();
    let mut byte = [0];
    assert_eq!(client.read(&mut byte).await.unwrap(), 0);
}
