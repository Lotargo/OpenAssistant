//! Offline Codex process-contract tests. Uses only the Python JSONL fixture.
use assistant_core::codex::{Client, Event, SpawnOptions};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, time::timeout};

static FIXTURE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct Fixture {
    root: PathBuf,
    log: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openassistant-codex-contract-{}-{}-{suffix}",
            std::process::id(),
            FIXTURE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            log: root.join("requests.jsonl"),
            root,
        }
    }
    async fn spawn(&self) -> (Client, mpsc::Receiver<Event>) {
        let mut options = SpawnOptions::new(&self.root);
        options.executable = Some(PathBuf::from(if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        }));
        options.arguments = Some(vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/mock_codex.py")
                .to_string_lossy()
                .into(),
            "--log".into(),
            self.log.to_string_lossy().into(),
        ]);
        let (tx, rx) = mpsc::channel(128);
        let client = Client::spawn(options, tx)
            .await
            .expect("offline Codex fixture failed to initialize");
        (client, rx)
    }
    fn messages(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn recv(rx: &mut mpsc::Receiver<Event>) -> Event {
    timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("Codex event timed out")
        .expect("Codex event channel closed")
}
async fn completed(rx: &mut mpsc::Receiver<Event>, turn_id: &str) -> (Value, String) {
    let mut text = String::new();
    loop {
        match recv(rx).await {
            Event::Notification { method, params } => {
                if method == "item/agentMessage/delta" && params["turnId"] == turn_id {
                    text.push_str(params["delta"].as_str().unwrap_or(""));
                }
                if method == "turn/completed" && params["turn"]["id"] == turn_id {
                    return (params, text);
                }
            }
            Event::Disconnected { message } => panic!("unexpected Codex disconnect: {message}"),
            _ => {}
        }
    }
}

#[tokio::test]
async fn native_requests_approvals_parallelism_and_interrupt_are_preserved() {
    let fixture = Fixture::new();
    let (client, mut events) = fixture.spawn().await;
    let models = client.list_models().await.unwrap();
    assert_eq!(
        models["data"].as_array().unwrap().len(),
        2,
        "model pagination was lost"
    );
    let thread = client
        .start_thread(&fixture.root, Some("mock-codex"))
        .await
        .unwrap();
    let thread_id = thread["thread"]["id"].as_str().unwrap().to_owned();
    let turn = client
        .start_turn(&thread_id, "mock:approval", None, Some("medium"))
        .await
        .unwrap();
    let turn_id = turn["turn"]["id"].as_str().unwrap().to_owned();
    let request_id = loop {
        if let Event::Request { id, method, params } = recv(&mut events).await {
            assert_eq!(method, "item/commandExecution/requestApproval");
            assert_eq!(params["turnId"], turn_id);
            break id;
        }
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        !fixture.messages().iter().any(|v| v.get("result").is_some()),
        "approval was automatically answered"
    );
    assert!(
        client
            .resolve(&request_id, json!({"decision":"acceptForSession"}))
            .await
            .is_err(),
        "persistent permission escalation must be rejected"
    );
    client.approve(&request_id, true).await.unwrap();
    let (done, text) = completed(&mut events, &turn_id).await;
    assert_eq!(done["turn"]["status"], "completed");
    assert_eq!(text, "APPROVAL_ACCEPT");
    assert!(
        client.approve(&request_id, true).await.is_err(),
        "approval ID reused"
    );

    let (left, right) = tokio::join!(
        client.request("test/slow", json!({"value":"left","delay":0.08})),
        client.request("test/slow", json!({"value":"right","delay":0.02}))
    );
    assert_eq!(left.unwrap()["value"], "left");
    assert_eq!(right.unwrap()["value"], "right");

    let child = client.fork_thread(&thread_id).await.unwrap();
    let child_id = child["thread"]["id"].as_str().unwrap();
    assert_ne!(child_id, thread_id);
    let turn = client
        .start_turn(child_id, "mock:abort", None, None)
        .await
        .unwrap();
    let abort_id = turn["turn"]["id"].as_str().unwrap().to_owned();
    loop {
        if let Event::Notification { method, params } = recv(&mut events).await
            && method == "item/started"
            && params["turnId"] == abort_id
        {
            break;
        }
    }
    client.interrupt(child_id, &abort_id).await.unwrap();
    let (done, _) = completed(&mut events, &abort_id).await;
    assert_eq!(done["turn"]["status"], "interrupted");

    let messages = fixture.messages();
    let initialization = messages
        .iter()
        .find(|v| v["method"] == "initialize")
        .unwrap();
    assert_eq!(
        initialization["params"]["capabilities"]["requiredHumanApproval"],
        true
    );
    assert!(messages.iter().any(|v| v["method"] == "initialized"));
    let start = messages
        .iter()
        .find(|v| v["method"] == "thread/start")
        .unwrap();
    assert!(
        start["params"].get("approvalPolicy").is_none(),
        "native approval policy was overridden"
    );
    assert!(
        start["params"].get("sandbox").is_none(),
        "native sandbox policy was overridden"
    );
    assert!(
        messages
            .iter()
            .any(|v| v["id"] == "mock-approval-1" && v["result"]["decision"] == "accept"),
        "original app-server approval ID was not preserved"
    );
    let _ = client.shutdown().await;
}

#[tokio::test]
async fn child_exit_drains_pending_requests_without_waiting_for_request_timeout() {
    let fixture = Fixture::new();
    let (client, mut events) = fixture.spawn().await;
    let refusal = client
        .request("test/no_such_method", json!({}))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refusal.contains("test/no_such_method"),
        "RPC errors must identify the failed method"
    );
    assert!(refusal.contains("-32601"));
    let result = timeout(
        Duration::from_secs(3),
        client.request("test/exit", json!({})),
    )
    .await
    .expect("pending request survived app-server exit");
    assert!(result.is_err());
    loop {
        if matches!(recv(&mut events).await, Event::Disconnected { .. }) {
            break;
        }
    }
    let _ = client.shutdown().await;
}
