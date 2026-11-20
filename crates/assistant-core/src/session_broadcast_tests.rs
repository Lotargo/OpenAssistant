//! Only local sockets are used; no credentials, provider endpoints, or model turns.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[tokio::test]
async fn native_stop_drops_the_actual_dialogue_socket_without_stopping_codex_work() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        // Abrupt task cancellation drops the TCP socket. There must be no writer
        // or reader holding it alive after the terminal event can be published.
        matches!(
            socket.next().await,
            None | Some(Err(_)) | Some(Ok(UpstreamMessage::Close(_)))
        )
    });
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
        .await
        .unwrap();
    let control = BroadcastControl::default();
    assert!(control.begin("dialogue-1"));
    let transport = VoiceTransport::new(socket, &control, "dialogue-1");
    let codex_work = tokio::spawn(std::future::pending::<()>());
    control.stop("dialogue-1");
    transport.shutdown().await;
    assert!(
        time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(!codex_work.is_finished());
    codex_work.abort();
    let _ = codex_work.await;
}

struct OpeningGuard(Arc<AtomicBool>);
impl Drop for OpeningGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[tokio::test]
async fn native_stop_cancels_pending_voice_opening_before_any_socket_exists() {
    let dropped = Arc::new(AtomicBool::new(false));
    let guard = dropped.clone();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let mut future = Some(async move {
        let _guard = OpeningGuard(guard);
        let _ = started.send(());
        std::future::pending::<Result<provider::ProviderSocket, SafeError>>().await
    });
    let mut opening = None;
    let control = BroadcastControl::default();
    assert!(control.begin("opening-1"));
    launch_voice(&mut future, &mut opening, &control, "opening-1");
    waiting.await.unwrap();
    control.stop("opening-1");
    assert!(
        (&mut opening.as_mut().unwrap().0)
            .await
            .unwrap_err()
            .is_cancelled()
    );
    assert!(dropped.load(Ordering::Acquire));
    assert!(
        future.is_none(),
        "cancelled opening must never be retried in this session"
    );
}
