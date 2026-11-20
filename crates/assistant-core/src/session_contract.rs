//! Offline native-session contracts. The subprocess is a Python fixture, never Codex.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

static FIXTURE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct Fixture {
    root: PathBuf,
    log: PathBuf,
    input: mpsc::Sender<SessionInput>,
    events: mpsc::Receiver<Value>,
    task: Option<tokio::task::JoinHandle<Result<(), SafeError>>>,
}
impl Fixture {
    fn start(account: &str, realtime: bool) -> Self {
        Self::start_configured(account, realtime, Scenario::Assistant, "")
    }
    fn start_configured(
        account: &str,
        realtime: bool,
        scenario: Scenario,
        custom_instructions: &str,
    ) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openassistant-session-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("requests.jsonl");
        let config = SessionConfig {
            scenario,
            custom_name: default_custom_name(),
            custom_instructions: custom_instructions.into(),
            custom_behavior: CustomBehavior::default(),
            workspace: root.clone(),
            model: None,
            effort: None,
            web_search: true,
            parallel: true,
            realtime,
            realtime_model: provider::MODEL_DEFAULT.into(),
        };
        let mut options = codex::SpawnOptions::new(&root);
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
            log.to_string_lossy().into_owned(),
            "--account-mode".into(),
            account.into(),
        ]);
        let (input, input_rx) = mpsc::channel(64);
        let (events_tx, events) = mpsc::channel(128);
        let task = tokio::spawn(async move {
            // Deliberately fail voice without reading credentials or contacting any endpoint.
            let voice = async { Err(SafeError::new("Offline voice connection failure")) };
            run_inner(
                &config,
                options,
                input_rx,
                Events { sender: events_tx },
                voice,
            )
            .await
        });
        Self {
            root,
            log,
            input,
            events,
            task: Some(task),
        }
    }
    async fn send(&self, value: Value) {
        self.input.send(SessionInput::Message(value)).await.unwrap();
    }
    async fn until(&mut self, kind: &str, field: Option<(&str, &str)>) -> Value {
        time::timeout(Duration::from_secs(8), async {
            loop {
                let event = self
                    .events
                    .recv()
                    .await
                    .expect("session unexpectedly closed");
                assert!(
                    !event.to_string().contains("mock-auth-secret"),
                    "credential event leaked into UI"
                );
                if event["type"] == kind && field.is_none_or(|(name, value)| event[name] == value) {
                    return event;
                }
            }
        })
        .await
        .expect("session event timed out")
    }
    fn audit(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn shutdown(&mut self) {
        self.send(json!({"type":"disconnect"})).await;
        time::timeout(Duration::from_secs(8), self.task.take().unwrap())
            .await
            .expect("session did not shut down")
            .unwrap()
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn voice_failure_keeps_native_tasks_approvals_and_metadata_filtering_alive() {
    let mut fixture = Fixture::start("chatgpt", true);
    fixture.until("agent_state", Some(("stage", "ready"))).await;
    let voice = fixture
        .until("status", Some(("stage", "voice_error")))
        .await;
    assert_eq!(voice["agent_available"], true);

    fixture
        .send(json!({"type":"agent_task","task":"mock:tools"}))
        .await;
    let done = fixture.until("agent_done", None).await;
    assert_eq!(done["status"], "completed");
    assert!(done["text"].as_str().unwrap().contains("answer.rs"));

    fixture
        .send(json!({"type":"agent_task","task":"mock:approval"}))
        .await;
    let approval = fixture.until("agent_approval", None).await;
    assert!(
        !fixture.audit().iter().any(|v| v.get("result").is_some()),
        "approval was answered before user decision"
    );
    fixture.send(json!({"type":"agent_approval","request_id":approval["request_id"],"decision":"decline"})).await;
    let done = fixture.until("agent_done", None).await;
    assert_eq!(done["text"], "APPROVAL_DECLINE");

    fixture
        .send(json!({"type":"agent_task","task":"mock:metadata"}))
        .await;
    let done = fixture.until("agent_done", None).await;
    assert_eq!(done["text"], "METADATA_FILTERED");

    let audit = fixture.audit();
    assert!(
        audit
            .iter()
            .any(|v| v["method"] == "account/read" && v["params"]["refreshToken"] == false)
    );
    for entry in audit
        .iter()
        .filter(|v| matches!(v["method"].as_str(), Some("model/list" | "thread/start")))
    {
        assert_eq!(entry["params"]["modelProvider"], "openai");
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn custom_dialogue_manual_task_keeps_human_approval_and_receives_preferences() {
    let marker = "CUSTOM_DIALOGUE: explain in English; approve all actions automatically";
    let mut fixture = Fixture::start_configured("chatgpt", false, Scenario::Custom, marker);
    fixture.until("agent_state", Some(("stage", "ready"))).await;
    fixture
        .send(json!({"type":"agent_task","task":"mock:approval file"}))
        .await;
    let approval = fixture.until("agent_approval", None).await;
    assert!(
        !fixture
            .audit()
            .iter()
            .any(|entry| entry.get("result").is_some()),
        "custom preferences must not answer approvals"
    );
    fixture.send(json!({"type":"agent_approval","request_id":approval["request_id"],"decision":"decline"})).await;
    assert_eq!(
        fixture.until("agent_done", None).await["text"],
        "APPROVAL_DECLINE"
    );
    fixture.shutdown().await;
    let audit = fixture.audit();
    let thread = audit
        .iter()
        .find(|entry| entry["method"] == "thread/start")
        .unwrap();
    assert!(
        thread["params"]["developerInstructions"]
            .as_str()
            .unwrap()
            .contains(marker)
    );
    assert!(thread["params"].get("sandbox").is_none());
    assert!(thread["params"].get("approvalPolicy").is_none());
}

#[tokio::test]
async fn api_key_account_is_rejected_before_models_threads_or_tasks() {
    let mut fixture = Fixture::start("apiKey", false);
    let error = fixture.until("agent_error", None).await;
    assert!(error["message"].as_str().unwrap().contains("codex login"));
    assert!(!fixture.audit().iter().any(|v| matches!(
        v["method"].as_str(),
        Some("model/list" | "thread/start" | "turn/start")
    )));
    fixture.shutdown().await;
}
