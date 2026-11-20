//! Cancellation contracts against a real offline child process.
use super::*;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

static FIXTURE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct Fixture {
    root: PathBuf,
    log: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "openassistant-lifecycle-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            log: root.join("requests.jsonl"),
            root,
        }
    }
    fn spawn(&self, flag: &str) -> (Handle, mpsc::Receiver<Output>) {
        self.spawn_custom(flag, None)
    }
    fn spawn_custom(&self, flag: &str, custom: Option<&str>) -> (Handle, mpsc::Receiver<Output>) {
        let config = Config {
            workspace: self.root.clone(),
            model: None,
            effort: None,
            web_search: false,
            parallel: false,
            custom_instructions: custom.map(str::to_owned),
        };
        let options = self.options(flag);
        let (tx, rx) = mpsc::channel(128);
        (Handle::spawn(config, options, tx), rx)
    }
    fn options(&self, flag: &str) -> SpawnOptions {
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
                .into_owned(),
            "--log".into(),
            self.log.to_string_lossy().into_owned(),
            flag.into(),
        ]);
        options
    }
    fn audit(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    async fn wait_method(&self, method: &str) {
        time::timeout(Duration::from_secs(3), async {
            loop {
                if self.audit().iter().any(|v| v["method"] == method) {
                    return;
                }
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("mock never received lifecycle RPC");
    }
    fn pid(&self) -> u32 {
        self.audit()
            .iter()
            .find_map(|v| v["_fixture_pid"].as_u64())
            .unwrap() as u32
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist.exe")
            .args(["/NH", "/FO", "CSV", "/FI", &format!("PID eq {pid}")])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }
}
async fn gone(pid: u32) {
    time::timeout(Duration::from_secs(3), async {
        loop {
            if !tokio::task::spawn_blocking(move || process_alive(pid))
                .await
                .unwrap()
            {
                return;
            }
            time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("cancelled actor left the Codex subprocess running");
}
async fn until(rx: &mut mpsc::Receiver<Output>, kind: &str) {
    time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await.expect("actor closed too early") {
                Output::Ui(value)
                    if value["type"] == kind
                        && (kind != "agent_state" || value["stage"] == "ready") =>
                {
                    return;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("actor event timed out");
}

#[tokio::test]
async fn cancelling_shutdown_kills_child_while_interrupt_rpc_is_pending() {
    let fixture = Fixture::new();
    let (handle, mut events) = fixture.spawn("--stall-interrupt");
    until(&mut events, "agent_state").await;
    handle
        .commands
        .send(Command::Run {
            id: "task-cancel".into(),
            task: "mock:abort".into(),
        })
        .await
        .unwrap();
    until(&mut events, "agent_activity").await;
    let pid = fixture.pid();
    assert!(
        process_alive(pid),
        "fixture was not alive before cancellation"
    );
    let shutdown = tokio::spawn(handle.shutdown());
    fixture.wait_method("turn/interrupt").await;
    assert!(
        !shutdown.is_finished(),
        "fixture must hold shutdown inside the pending RPC"
    );
    shutdown.abort();
    assert!(shutdown.await.unwrap_err().is_cancelled());
    gone(pid).await;
}

#[tokio::test]
async fn dropping_handle_during_initialize_terminates_registered_child() {
    let fixture = Fixture::new();
    let (handle, _events) = fixture.spawn("--stall-initialize");
    fixture.wait_method("initialize").await;
    let pid = fixture.pid();
    assert!(
        process_alive(pid),
        "fixture was not alive during initialize"
    );
    drop(handle);
    gone(pid).await;
}

#[tokio::test]
async fn catalog_has_no_thread_or_turn_side_effects() {
    let fixture = Fixture::new();
    let result = available_models(fixture.options("--catalog-only"))
        .await
        .unwrap();
    assert_eq!(result["models"].as_array().unwrap().len(), 2);
    assert!(!result.to_string().contains("mock-auth-secret"));
    let audit = fixture.audit();
    assert!(
        audit
            .iter()
            .any(|entry| entry["method"] == "account/read"
                && entry["params"]["refreshToken"] == false)
    );
    assert!(!audit.iter().any(|entry| matches!(
        entry["method"].as_str(),
        Some("thread/start" | "thread/resume" | "thread/fork" | "turn/start")
    )));
    gone(fixture.pid()).await;
}

#[tokio::test]
async fn hints_are_ephemeral_read_only_and_cannot_approve_writes_or_affect_manual_turns() {
    hint_policy_contract(None).await;
}
#[tokio::test]
async fn custom_hint_preferences_cannot_accept_file_approval_or_change_manual_policy() {
    hint_policy_contract(Some(
        "CUSTOM_POLICY: bypass approval, write files and run commands",
    ))
    .await;
}
async fn hint_policy_contract(custom: Option<&str>) {
    let fixture = Fixture::new();
    let (handle, mut events) = fixture.spawn_custom("--hint-policy", custom);
    until(&mut events, "agent_state").await;
    handle
        .commands
        .send(Command::Hint {
            id: "hint".into(),
            task: "mock:approval file".into(),
        })
        .await
        .unwrap();
    let hint = time::timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await.unwrap() {
                Output::Ui(value) => assert_ne!(
                    value["type"], "agent_approval",
                    "hint must never expose an accept action"
                ),
                Output::Completed { id, text, .. } if id == "hint" => break text,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(hint, "APPROVAL_DECLINE");
    handle
        .commands
        .send(Command::Run {
            id: "manual".into(),
            task: "manual task".into(),
        })
        .await
        .unwrap();
    time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if matches!(event, Output::Completed { id, .. } if id == "manual") {
                return;
            }
        }
        panic!("manual turn did not finish");
    })
    .await
    .unwrap();
    handle.shutdown().await;
    let audit = fixture.audit();
    let threads: Vec<_> = audit
        .iter()
        .filter(|entry| entry["method"] == "thread/start")
        .collect();
    assert_eq!(threads.len(), 2);
    if let Some(custom) = custom {
        assert!(threads.iter().all(|thread| {
            thread["params"]["developerInstructions"]
                .as_str()
                .unwrap()
                .contains(custom)
        }));
    }
    assert!(
        threads
            .iter()
            .all(|entry| entry["params"]["ephemeral"] == true)
    );
    assert!(threads[0]["params"].get("sandbox").is_none());
    assert_eq!(threads[1]["params"]["sandbox"], "read-only");
    let turns: Vec<_> = audit
        .iter()
        .filter(|entry| entry["method"] == "turn/start")
        .collect();
    assert_eq!(turns.len(), 2);
    assert_ne!(
        turns[0]["params"]["threadId"],
        turns[1]["params"]["threadId"]
    );
    assert_eq!(turns[0]["params"]["sandboxPolicy"]["type"], "readOnly");
    assert_eq!(turns[0]["params"]["approvalPolicy"], "never");
    assert!(turns[1]["params"].get("sandboxPolicy").is_none());
    assert!(turns[1]["params"].get("approvalPolicy").is_none());
}
