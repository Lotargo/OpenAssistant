//! Offline end-to-end interview lifecycle: fake provider channels + an offline Codex child.
use super::*;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

struct VoiceHub {
    outputs: Mutex<[Option<mpsc::Sender<VoiceOutput>>; 2]>,
    commands: Mutex<Vec<(Source, Value)>>,
    gates: mpsc::UnboundedSender<Value>,
    auto_clear: AtomicBool,
    stopped: AtomicUsize,
}
struct WorkerGuard(Arc<VoiceHub>);
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.0.stopped.fetch_add(1, Ordering::AcqRel);
    }
}
impl VoiceHub {
    fn start(self: &Arc<Self>, source: Source, output: mpsc::Sender<VoiceOutput>) -> Voice {
        self.outputs.lock().unwrap()[source.index()] = Some(output.clone());
        let (commands, mut receiver) = mpsc::channel::<Value>(64);
        let hub = self.clone();
        let task = tokio::spawn(async move {
            let _guard = WorkerGuard(hub.clone());
            output
                .send(VoiceOutput::Event(
                    source,
                    json!({"type":"session.updated"}),
                ))
                .await
                .unwrap();
            while let Some(value) = receiver.recv().await {
                hub.commands.lock().unwrap().push((source, value.clone()));
                match value["type"].as_str() {
                    Some("input_audio_buffer.clear") if hub.auto_clear.load(Ordering::Acquire) => {
                        if output
                            .send(VoiceOutput::Event(
                                source,
                                json!({"type":"input_audio_buffer.cleared"}),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some("response.create") => {
                        hub.gates.send(value).unwrap();
                    }
                    _ => {}
                }
            }
        });
        Voice { commands, task }
    }
    async fn event(&self, source: Source, value: Value) {
        let output = self.outputs.lock().unwrap()[source.index()]
            .clone()
            .unwrap();
        output
            .send(VoiceOutput::Event(source, value))
            .await
            .unwrap();
    }
    async fn failed(&self, source: Source) {
        let output = self.outputs.lock().unwrap()[source.index()]
            .clone()
            .unwrap();
        output
            .send(VoiceOutput::Failed(
                source,
                "Offline connection failure".into(),
            ))
            .await
            .unwrap();
    }
    async fn phrase(&self, source: Source, id: &str, text: &str) {
        for kind in [
            "input_audio_buffer.speech_started",
            "input_audio_buffer.committed",
            "input_audio_buffer.speech_stopped",
        ] {
            self.event(source, json!({"type":kind,"item_id":id})).await;
        }
        self.event(source, json!({"type":"conversation.item.input_audio_transcription.completed","item_id":id,"transcript":text})).await;
    }
    fn count(&self, kind: &str) -> usize {
        self.commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, command)| command["type"] == kind)
            .count()
    }
    async fn wait_count(&self, kind: &str, count: usize) {
        time::timeout(Duration::from_secs(3), async {
            while self.count(kind) < count {
                time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}
struct Fixture {
    root: PathBuf,
    log: PathBuf,
    input: mpsc::Sender<SessionInput>,
    events: mpsc::Receiver<Value>,
    gates: mpsc::UnboundedReceiver<Value>,
    hub: Arc<VoiceHub>,
    task: Option<JoinHandle<Result<(), SafeError>>>,
}
impl Fixture {
    fn start(auto_clear: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openassistant-interview-contract-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let log = root.join("requests.jsonl");
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
        ]);
        let config = SessionConfig {
            workspace: root.clone(),
            scenario: session::Scenario::Interview,
            model: None,
            effort: None,
            web_search: false,
            parallel: false,
            realtime: true,
            realtime_model: provider::MODEL_DEFAULT.into(),
        };
        let (input, input_rx) = mpsc::channel(64);
        let (event_tx, events) = mpsc::channel(256);
        let (gate_tx, gates) = mpsc::unbounded_channel();
        let hub = Arc::new(VoiceHub {
            outputs: Mutex::new([None, None]),
            commands: Mutex::new(vec![]),
            gates: gate_tx,
            auto_clear: AtomicBool::new(auto_clear),
            stopped: AtomicUsize::new(0),
        });
        let worker = hub.clone();
        let task = tokio::spawn(run_inner(
            config,
            input_rx,
            event_tx,
            options,
            move |source, _model, output| worker.start(source, output),
            None,
        ));
        Self {
            root,
            log,
            input,
            events,
            gates,
            hub,
            task: Some(task),
        }
    }
    async fn message(&self, value: Value) {
        self.input.send(SessionInput::Message(value)).await.unwrap();
    }
    async fn event(&mut self, kind: &str, stage: Option<&str>) -> Value {
        time::timeout(Duration::from_secs(5), async {
            loop {
                let value = self.events.recv().await.expect("interview runtime closed");
                if value["type"] == kind && stage.is_none_or(|stage| value["stage"] == stage) {
                    return value;
                }
            }
        })
        .await
        .expect("interview event timed out")
    }
    async fn ready(&mut self) {
        loop {
            let value = self.event("status", Some("ready")).await;
            if value["realtime"] == true {
                break;
            }
        }
    }
    async fn start_listening(&mut self) {
        let clears = self.hub.count("input_audio_buffer.clear");
        self.message(json!({"type":"mic_start"})).await;
        self.message(json!({"type":"system_start"})).await;
        self.message(json!({"type":"interview_start"})).await;
        self.event("interview_state", Some("listening")).await;
        self.hub
            .wait_count("input_audio_buffer.clear", clears + 2)
            .await;
        // Let the ack events cross the same queue used by production sockets.
        time::sleep(Duration::from_millis(15)).await;
    }
    async fn gate(&mut self) -> Value {
        time::timeout(Duration::from_secs(4), self.gates.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn no_gate(&mut self) {
        assert!(
            time::timeout(Duration::from_millis(900), self.gates.recv())
                .await
                .is_err(),
            "unexpected interview decision"
        );
    }
    async fn decision(&self, request: &Value, help: bool) {
        self.hub.event(Source::System, json!({"type":"response.done","response":{
            "id":"offline-decision","metadata":request["response"]["metadata"],"status":"completed",
            "output":[{"type":"function_call","name":"interview_decision","status":"completed",
                "arguments":json!({"help":help,"target":if help {"self"} else {"none"},"reason":"offline test",
                    "task":if help {"Explain this mock question inline"} else {""}}).to_string()}]
        }})).await;
    }
    fn audit(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    async fn finish(&mut self) {
        self.message(json!({"type":"disconnect"})).await;
        time::timeout(Duration::from_secs(5), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        time::timeout(Duration::from_secs(2), async {
            while self.hub.stopped.load(Ordering::Acquire) != 2 {
                time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
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
async fn two_sources_route_independently_and_semantic_gate_is_the_only_hint_trigger() {
    let mut fixture = Fixture::start(true);
    fixture.ready().await;
    fixture
        .input
        .send(SessionInput::Audio(vec![1, 0]))
        .await
        .unwrap();
    fixture
        .input
        .send(SessionInput::SystemAudio(vec![2, 0]))
        .await
        .unwrap();
    time::sleep(Duration::from_millis(20)).await;
    assert_eq!(fixture.hub.count("input_audio_buffer.append"), 0);
    fixture.start_listening().await;
    fixture
        .input
        .send(SessionInput::Audio(vec![1, 0]))
        .await
        .unwrap();
    fixture
        .input
        .send(SessionInput::SystemAudio(vec![2, 0]))
        .await
        .unwrap();
    fixture.hub.wait_count("input_audio_buffer.append", 2).await;
    {
        let commands = fixture.hub.commands.lock().unwrap();
        assert!(
            commands
                .iter()
                .any(|(source, command)| *source == Source::Microphone
                    && command["audio"] == STANDARD.encode([1, 0]))
        );
        assert!(
            commands
                .iter()
                .any(|(source, command)| *source == Source::System
                    && command["audio"] == STANDARD.encode([2, 0]))
        );
    }
    fixture
        .hub
        .phrase(
            Source::Microphone,
            "self-ordinary",
            "I already know this topic",
        )
        .await;
    let transcript = fixture.event("transcript", None).await;
    assert_eq!(transcript["source"], "microphone");
    fixture.no_gate().await;
    fixture
        .hub
        .phrase(
            Source::System,
            "remote-question",
            "Can you explain a SQL left join?",
        )
        .await;
    let transcript = fixture.event("transcript", None).await;
    assert_eq!(transcript["source"], "system");
    assert!(transcript["speaker"].is_null());
    let request = fixture.gate().await;
    assert_eq!(request["response"]["conversation"], "none");
    // A harmless delete error on either socket must not cancel this current gate.
    fixture
        .hub
        .event(
            Source::Microphone,
            json!({"type":"error","error":{"event_id":"interview-delete-microphone-1"}}),
        )
        .await;
    fixture.decision(&request, true).await;
    let done = fixture.event("agent_done", None).await;
    assert!(
        done["task_id"]
            .as_str()
            .unwrap()
            .starts_with("interview-hint-")
    );
    assert_eq!(done["status"], "completed");
    fixture.finish().await;
    assert_eq!(
        fixture
            .audit()
            .iter()
            .filter(|entry| entry["method"] == "turn/start")
            .count(),
        1
    );
}

#[tokio::test]
async fn old_clear_ack_and_late_transcript_cannot_arm_a_restarted_listening_generation() {
    let mut fixture = Fixture::start(false);
    fixture.ready().await;
    fixture.start_listening().await;
    fixture.message(json!({"type":"interview_stop"})).await;
    fixture.event("interview_state", Some("idle")).await;
    fixture.hub.wait_count("input_audio_buffer.clear", 4).await;
    fixture.start_listening().await;
    fixture.hub.wait_count("input_audio_buffer.clear", 6).await;
    for source in [Source::Microphone, Source::System] {
        fixture
            .hub
            .event(source, json!({"type":"input_audio_buffer.cleared"}))
            .await;
        fixture
            .hub
            .event(source, json!({"type":"input_audio_buffer.cleared"}))
            .await;
    }
    fixture
        .hub
        .phrase(
            Source::System,
            "old-utterance",
            "Should never enter this new context",
        )
        .await;
    fixture.no_gate().await;
    for source in [Source::Microphone, Source::System] {
        fixture
            .hub
            .event(source, json!({"type":"input_audio_buffer.cleared"}))
            .await;
    }
    time::sleep(Duration::from_millis(15)).await;
    fixture
        .hub
        .phrase(
            Source::System,
            "new-question",
            "Please explain a binary search",
        )
        .await;
    let transcript = fixture.event("transcript", None).await;
    assert_eq!(transcript["text"], "Please explain a binary search");
    let request = fixture.gate().await;
    assert!(!request.to_string().contains("Should never enter"));
    fixture.decision(&request, false).await;
    fixture.finish().await;
    assert!(
        !fixture
            .audit()
            .iter()
            .any(|entry| entry["method"] == "turn/start")
    );
}

#[tokio::test]
async fn pending_local_transcription_is_included_before_a_decision_is_requested() {
    let mut fixture = Fixture::start(true);
    fixture.ready().await;
    fixture.start_listening().await;
    fixture
        .hub
        .phrase(
            Source::System,
            "question",
            "Please explain how indexes work",
        )
        .await;
    fixture.event("transcript", None).await;
    for kind in [
        "input_audio_buffer.speech_started",
        "input_audio_buffer.committed",
        "input_audio_buffer.speech_stopped",
    ] {
        fixture
            .hub
            .event(Source::Microphone, json!({"type":kind,"item_id":"answer"}))
            .await;
    }
    fixture.no_gate().await;
    fixture
        .hub
        .event(
            Source::Microphone,
            json!({"type":"conversation.item.input_audio_transcription.completed",
        "item_id":"answer","transcript":"I have already answered with a B-tree explanation"}),
        )
        .await;
    fixture.event("transcript", None).await;
    let request = fixture.gate().await;
    assert!(request.to_string().contains("already answered"));
    fixture.decision(&request, false).await;
    fixture.finish().await;
    assert!(
        !fixture
            .audit()
            .iter()
            .any(|entry| entry["method"] == "turn/start")
    );
}

#[tokio::test]
async fn pause_cancels_unknown_and_late_allocated_response_ids_without_starting_a_hint() {
    let mut fixture = Fixture::start(true);
    fixture.ready().await;
    fixture.start_listening().await;
    fixture
        .hub
        .phrase(
            Source::System,
            "question",
            "Write a short example of recursion",
        )
        .await;
    fixture.event("transcript", None).await;
    let request = fixture.gate().await;
    fixture.message(json!({"type":"interview_stop"})).await;
    fixture.event("interview_state", Some("idle")).await;
    fixture.hub.wait_count("response.cancel", 1).await;
    assert!(
        fixture
            .hub
            .commands
            .lock()
            .unwrap()
            .iter()
            .any(|(_, command)| command["type"] == "response.cancel"
                && command.get("response_id").is_none())
    );
    fixture
        .hub
        .event(
            Source::System,
            json!({"type":"response.created","response":{
                "id":"late-allocated","metadata":request["response"]["metadata"]
            }}),
        )
        .await;
    fixture.hub.wait_count("response.cancel", 2).await;
    assert!(
        fixture
            .hub
            .commands
            .lock()
            .unwrap()
            .iter()
            .any(|(_, command)| command["type"] == "response.cancel"
                && command["response_id"] == "late-allocated")
    );
    fixture.decision(&request, true).await;
    fixture
        .hub
        .phrase(
            Source::System,
            "paused",
            "This is paused and must be discarded",
        )
        .await;
    fixture.no_gate().await;
    fixture.finish().await;
    assert!(
        !fixture
            .audit()
            .iter()
            .any(|entry| entry["method"] == "turn/start")
    );
}

#[tokio::test]
async fn a_provider_failure_stops_both_sources_but_keeps_explicit_text_tasks_working() {
    let mut fixture = Fixture::start(true);
    fixture.ready().await;
    fixture.start_listening().await;
    fixture.hub.failed(Source::System).await;
    fixture.event("status", Some("voice_error")).await;
    fixture
        .message(json!({"type":"text","text":"explicit manual task"}))
        .await;
    let done = fixture.event("agent_done", None).await;
    assert_eq!(done["status"], "completed");
    assert!(
        !done["task_id"]
            .as_str()
            .unwrap()
            .starts_with("interview-hint-")
    );
    fixture.finish().await;
}

#[tokio::test]
async fn timed_out_decision_is_cancelled_without_a_hint_and_late_output_is_ignored() {
    let mut fixture = Fixture::start(true);
    fixture.ready().await;
    fixture.start_listening().await;
    fixture
        .hub
        .phrase(
            Source::System,
            "question",
            "Explain this example with a loop",
        )
        .await;
    fixture.event("transcript", None).await;
    let request = fixture.gate().await;
    time::timeout(DECISION_TIMEOUT + Duration::from_secs(3), async {
        while fixture.hub.count("response.cancel") == 0 {
            time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("timed-out gate was not cancelled");
    fixture.decision(&request, true).await;
    fixture.no_gate().await;
    fixture.finish().await;
    assert!(
        !fixture
            .audit()
            .iter()
            .any(|entry| entry["method"] == "turn/start")
    );
}

#[tokio::test]
async fn expired_local_transcription_discards_the_candidate_and_ignores_its_late_text() {
    let mut fixture = Fixture::start(true);
    fixture.ready().await;
    fixture.start_listening().await;
    fixture
        .hub
        .phrase(Source::System, "question", "Explain an index please")
        .await;
    fixture.event("transcript", None).await;
    for kind in [
        "input_audio_buffer.speech_started",
        "input_audio_buffer.committed",
        "input_audio_buffer.speech_stopped",
    ] {
        fixture
            .hub
            .event(
                Source::Microphone,
                json!({"type":kind,"item_id":"missing-answer"}),
            )
            .await;
    }
    time::timeout(TRANSCRIPT_TIMEOUT + Duration::from_secs(3), async {
        loop {
            let event = fixture.events.recv().await.unwrap();
            assert_ne!(event["stage"], "evaluating");
            if event["type"] == "interview_state" && event["stage"] == "listening" {
                break;
            }
        }
    })
    .await
    .expect("missing transcription did not expire");
    fixture
        .hub
        .event(
            Source::Microphone,
            json!({"type":"conversation.item.input_audio_transcription.completed",
        "item_id":"missing-answer","transcript":"LATE TEXT MUST NOT ENTER CONTEXT"}),
        )
        .await;
    fixture.no_gate().await;
    fixture
        .hub
        .phrase(Source::System, "next-question", "Now explain binary search")
        .await;
    let request = fixture.gate().await;
    assert!(!request.to_string().contains("LATE TEXT"));
    fixture.decision(&request, false).await;
    fixture.finish().await;
    assert!(
        !fixture
            .audit()
            .iter()
            .any(|entry| entry["method"] == "turn/start")
    );
}
