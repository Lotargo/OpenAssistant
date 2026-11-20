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
        let config = Config {
            workspace: self.root.clone(),
            model: None,
            effort: None,
            web_search: false,
            parallel: false,
        };
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
        let (tx, rx) = mpsc::channel(128);
        (Handle::spawn(config, options, tx), rx)
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
