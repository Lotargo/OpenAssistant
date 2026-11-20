//! Transport-independent session state. No browser, HTTP, file or credential access.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const MAX_LOCAL_MESSAGE: usize = 160 * 1024;
pub const MAX_TEXT_LENGTH: usize = 4000;
pub const MAX_AUDIO_BYTES: usize = 9600;
const MAX_TOOL_CALLS: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Emit(Value),
    Send(Value),
    Delegate { call_id: String, task: String },
    Resume,
}

#[derive(Debug)]
pub enum Input {
    Text(Option<String>),
    MicStart,
    MicStop,
    Audio(Vec<u8>),
}

pub struct Bridge {
    demo: bool,
    ready: bool,
    mic_active: bool,
    audio_bytes: u64,
    reported_bytes: u64,
    max_peak: f64,
    seen_calls: HashSet<String>,
}

pub fn event(kind: &str, payload: Value) -> Value {
    let mut value = payload;
    value["type"] = json!(kind);
    value
}
pub fn status(stage: &str, detail: &str) -> Value {
    event("status", json!({"stage": stage, "detail": detail}))
}
pub fn error(message: &str) -> Value {
    event("error", json!({"message": message}))
}
fn emit(kind: &str, payload: Value) -> Action {
    Action::Emit(event(kind, payload))
}
fn failure(message: &str) -> Vec<Action> {
    vec![Action::Emit(error(message))]
}
fn mic(stage: &str, detail: &str) -> Action {
    emit("mic_state", json!({"stage":stage, "detail":detail}))
}
fn limited(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}
fn identifier(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Bridge {
    pub fn new(demo: bool) -> Self {
        Self {
            demo,
            ready: false,
            mic_active: false,
            audio_bytes: 0,
            reported_bytes: 0,
            max_peak: 0.0,
            seen_calls: HashSet::new(),
        }
    }
    pub fn is_ready(&self) -> bool {
        self.ready
    }
    pub fn set_ready(&mut self, ready: bool) {
        self.ready = ready;
    }

    pub fn input(&mut self, input: Input) -> Vec<Action> {
        if !self.ready {
            return if matches!(input, Input::Audio(_)) {
                vec![]
            } else {
                failure("Сначала подключись к модели")
            };
        }
        match input {
            Input::Text(text) => self.text(text.as_deref()),
            Input::MicStart => {
                if self.mic_active {
                    return vec![];
                }
                self.mic_active = true;
                self.audio_bytes = 0;
                self.reported_bytes = 0;
                self.max_peak = 0.0;
                let mut actions = vec![];
                if !self.demo {
                    actions.push(Action::Send(json!({"type":"input_audio_buffer.clear"})));
                }
                actions.push(mic("listening", "Микрофон активен · отвечаю после паузы"));
                actions
            }
            Input::MicStop => {
                if !self.mic_active {
                    return vec![];
                }
                self.mic_active = false;
                let mut actions = vec![];
                // Finish a possible last utterance even if speech_started has not arrived yet.
                // 1s exceeds the 760ms server VAD pause. No manual commit/response trigger.
                if !self.demo && self.audio_bytes > 0 {
                    let silence = STANDARD.encode([0u8; 4800]);
                    for _ in 0..10 {
                        actions.push(Action::Send(
                            json!({"type":"input_audio_buffer.append","audio":silence}),
                        ));
                    }
                }
                self.audio_bytes = 0;
                actions.push(mic(
                    "stopped",
                    if self.demo {
                        "Демо: микрофон выключен"
                    } else {
                        "Микрофон выключен"
                    },
                ));
                actions
            }
            Input::Audio(data) => self.audio(&data),
        }
    }

    fn text(&self, text: Option<&str>) -> Vec<Action> {
        let Some(text) =
            text.filter(|s| !s.trim().is_empty() && s.chars().count() <= MAX_TEXT_LENGTH)
        else {
            return failure("Введите сообщение длиной до 4000 символов");
        };
        if self.demo {
            return vec![
                emit(
                    "delta",
                    json!({"text":format!("Демо-ответ. Сообщение получено: {}",limited(text,300))}),
                ),
                emit("response_done", json!({"tool":false})),
            ];
        }
        vec![
            Action::Send(json!({"type":"conversation.item.create", "item":{
                "type":"message", "role":"user", "content":[{"type":"input_text","text":text}]}})),
            Action::Send(json!({"type":"response.create"})),
        ]
    }

    fn audio(&mut self, data: &[u8]) -> Vec<Action> {
        if !self.mic_active {
            return vec![];
        }
        if data.is_empty() || data.len() > MAX_AUDIO_BYTES || !data.len().is_multiple_of(2) {
            return failure("Некорректный размер PCM16 аудиофрагмента");
        }
        self.audio_bytes += data.len() as u64;
        let peak = data
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f64)
            .map(f64::abs)
            .fold(0.0, f64::max)
            / 32768.0;
        self.max_peak = self.max_peak.max(peak);
        let mut actions = vec![];
        if !self.demo {
            actions.push(Action::Send(
                json!({"type":"input_audio_buffer.append","audio":STANDARD.encode(data)}),
            ));
        }
        if self.audio_bytes - self.reported_bytes >= 14400 {
            self.reported_bytes = self.audio_bytes;
            actions.push(emit(
                "audio_stats",
                json!({
                    "seconds":(self.audio_bytes as f64 / 480.0).round()/100.0,
                    "peak":(peak*1000.0).round()/1000.0,
                    "max_peak":(self.max_peak*1000.0).round()/1000.0
                }),
            ));
        }
        actions
    }

    pub fn provider_event(&mut self, event: &Value) -> Vec<Action> {
        let kind = event["type"].as_str().unwrap_or("");
        match kind {
            "session.created" => vec![],
            "session.updated" => {
                self.ready = true;
                vec![Action::Emit(status(
                    "ready",
                    "GPT-Realtime · текстовый режим",
                ))]
            }
            "response.output_text.delta" | "response.text.delta" => event["delta"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| vec![emit("delta", json!({"text":limited(s,16000)}))])
                .unwrap_or_default(),
            "response.output_text.done" | "response.text.done" => {
                vec![emit(
                    "text_done",
                    json!({"text":limited(event["text"].as_str().unwrap_or(""),16000)}),
                )]
            }
            "input_audio_buffer.speech_started" if self.mic_active => {
                vec![mic("speech", "Речь обнаружена · слушаю")]
            }
            "input_audio_buffer.speech_stopped" => {
                vec![mic("processing", "Пауза обнаружена · обрабатываю")]
            }
            "input_audio_buffer.committed" => vec![mic("committed", "Реплика принята · жду ответ")],
            "input_audio_buffer.cleared" => vec![mic("cleared", "Аудиобуфер очищен")],
            "response.created" => vec![mic("generating", "Модель формирует ответ")],
            "conversation.item.input_audio_transcription.failed" => {
                failure("Распознавание речи не выполнено; проверь сигнал микрофона")
            }
            "conversation.item.input_audio_transcription.completed" => event["transcript"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(|s| vec![emit("transcript", json!({"text":limited(s,10000)}))])
                .unwrap_or_default(),
            "response.done" => self.response_done(event),
            "error" => {
                let code = event["error"]["code"]
                    .as_str()
                    .filter(|s| identifier(s, 80))
                    .unwrap_or("provider_error");
                failure(&format!("Ошибка провайдера: {code}"))
            }
            _ => vec![],
        }
    }

    pub fn tool_output(call_id: &str, text: &str, ok: bool) -> Value {
        json!({"type":"conversation.item.create","item":{
            "type":"function_call_output","call_id":call_id,
            "output":json!({"ok":ok,"result":limited(text,32000)}).to_string()
        }})
    }

    fn response_done(&mut self, event: &Value) -> Vec<Action> {
        let mut actions = vec![];
        let mut tool_pending = false;
        let mut replied = false;
        let response_completed = event["response"]["status"] == "completed";
        if event["response"]["status"] == "failed" {
            actions.extend(failure("Провайдер не смог завершить ответ"));
        }
        if let Some(outputs) = event["response"]["output"].as_array() {
            for item in outputs.iter().filter(|v| v["type"] == "function_call") {
                let Some(id) = item["call_id"].as_str().filter(|v| identifier(v, 128)) else {
                    actions.extend(failure("Отклонён вызов инструмента с некорректным ID"));
                    continue;
                };
                if self.seen_calls.contains(id) {
                    continue;
                }
                // A VAD interruption can leave syntactically valid arguments in a cancelled
                // response. Never turn those partial/cancelled generations into real actions.
                if !response_completed {
                    if self.seen_calls.len() < MAX_TOOL_CALLS {
                        self.seen_calls.insert(id.to_owned());
                    }
                    continue;
                }
                if self.seen_calls.len() >= MAX_TOOL_CALLS {
                    actions.push(Action::Send(Self::tool_output(
                        id,
                        "Лимит вызовов Codex в этой сессии",
                        false,
                    )));
                    replied = true;
                    continue;
                }
                self.seen_calls.insert(id.to_owned());
                if item
                    .get("status")
                    .is_some_and(|status| status != "completed")
                {
                    actions.push(Action::Send(Self::tool_output(
                        id,
                        "Вызов Codex не завершён; задача не выполнялась",
                        false,
                    )));
                    replied = true;
                    continue;
                }
                let args = item["arguments"]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or(Value::Null);
                if item["name"] == "codex_task"
                    && let Some(task) = args["task"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 16000)
                {
                    actions.push(Action::Delegate {
                        call_id: id.to_owned(),
                        task: task.to_owned(),
                    });
                    tool_pending = true;
                    continue;
                }
                actions.push(Action::Send(Self::tool_output(
                    id,
                    "Неизвестный инструмент или некорректная задача Codex",
                    false,
                )));
                replied = true;
            }
        }
        if replied {
            actions.push(Action::Resume);
        }
        actions.push(emit(
            "response_done",
            json!({"tool":tool_pending || replied}),
        ));
        if self.mic_active {
            actions.push(mic(
                "listening",
                if tool_pending {
                    "Codex работает · микрофон остаётся активным"
                } else {
                    "Слушаю следующую реплику"
                },
            ));
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready(demo: bool) -> Bridge {
        let mut b = Bridge::new(demo);
        b.set_ready(true);
        b
    }
    fn emitted(actions: &[Action], kind: &str) -> Option<Value> {
        actions.iter().find_map(|a| match a {
            Action::Emit(v) if v["type"] == kind => Some(v.clone()),
            _ => None,
        })
    }
    #[test]
    fn readiness_requires_provider_ack() {
        let mut b = Bridge::new(false);
        assert!(emitted(&b.input(Input::Text(Some("hi".into()))), "error").is_some());
        b.provider_event(&json!({"type":"session.created"}));
        assert!(!b.is_ready());
        b.provider_event(&json!({"type":"session.updated"}));
        assert!(b.is_ready());
    }
    #[test]
    fn unicode_limit_counts_characters() {
        let mut b = ready(false);
        let s = "я".repeat(4000);
        assert!(matches!(b.input(Input::Text(Some(s)))[0], Action::Send(_)));
        assert!(emitted(&b.input(Input::Text(Some("я".repeat(4001)))), "error").is_some());
        assert!(emitted(&b.input(Input::Text(None)), "error").is_some());
    }
    #[test]
    fn microphone_is_continuous_and_pcm_peak_handles_min_i16() {
        let mut b = ready(false);
        assert!(b.input(Input::Audio(vec![0; 4800])).is_empty());
        b.input(Input::MicStart);
        for _ in 0..2 {
            b.input(Input::Audio([0u8, 128].repeat(2400)));
        }
        let a = b.input(Input::Audio([0u8, 128].repeat(2400)));
        let stats = emitted(&a, "audio_stats").unwrap();
        assert_eq!(stats["seconds"], 0.3);
        assert_eq!(stats["peak"], 1.0);
        assert!(
            a.iter()
                .all(|a| !matches!(a,Action::Send(v) if v["type"]!="input_audio_buffer.append"))
        );
        assert!(emitted(&b.input(Input::Audio(vec![0; 3])), "error").is_some());
        assert!(emitted(&b.input(Input::Audio(vec![0; 9602])), "error").is_some());
    }
    #[test]
    fn stop_flushes_vad_without_manual_response_even_before_speech_event() {
        let mut b = ready(false);
        b.input(Input::MicStart);
        b.input(Input::Audio(vec![1; 4800]));
        let a = b.input(Input::MicStop);
        let sent: Vec<_> = a
            .iter()
            .filter_map(|a| {
                if let Action::Send(v) = a {
                    Some(v)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(sent.len(), 10);
        assert!(
            sent.iter()
                .all(|v| v["type"] == "input_audio_buffer.append")
        );
        assert!(b.input(Input::MicStop).is_empty());
        assert!(b.input(Input::Audio(vec![1; 4800])).is_empty());
    }
    #[test]
    fn tools_delegate_in_parallel_and_duplicates_are_ignored() {
        let mut b = ready(false);
        let e = json!({"type":"response.done","response":{"status":"completed","output":[
            {"type":"function_call","call_id":"call_1","name":"codex_task","arguments":json!({"task":"Read file A"}).to_string()},
            {"type":"function_call","call_id":"call_2","name":"codex_task","status":"completed","arguments":json!({"task":"Read file B"}).to_string()}
        ]}});
        let actions = b.provider_event(&e);
        assert_eq!(
            actions
                .iter()
                .filter(|a| matches!(a, Action::Delegate { .. }))
                .count(),
            2
        );
        assert!(
            !actions
                .iter()
                .any(|a| matches!(a,Action::Send(v) if v["type"]=="response.create"))
        );
        assert_eq!(emitted(&actions, "response_done").unwrap()["tool"], true);
        assert!(
            !b.provider_event(&e)
                .iter()
                .any(|a| matches!(a, Action::Delegate { .. }))
        );
    }
    #[test]
    fn cancelled_failed_and_incomplete_responses_never_execute_tools() {
        for status in [Some("cancelled"), Some("failed"), Some("incomplete"), None] {
            let mut b = ready(false);
            let mut event = json!({"type":"response.done","response":{"output":[{
                "type":"function_call","call_id":"cancelled-call","name":"codex_task",
                "status":"completed","arguments":json!({"task":"Write a real file"}).to_string()
            }]}});
            if let Some(status) = status {
                event["response"]["status"] = json!(status);
            }
            let actions = b.provider_event(&event);
            assert!(!actions.iter().any(|a| matches!(
                a,
                Action::Delegate { .. } | Action::Send(_) | Action::Resume
            )));
            event["response"]["status"] = json!("completed");
            assert!(
                !b.provider_event(&event)
                    .iter()
                    .any(|a| matches!(a, Action::Delegate { .. })),
                "an earlier cancelled call ID must not be resurrected"
            );
        }
    }
    #[test]
    fn incomplete_function_items_are_rejected_even_in_completed_responses() {
        for status in ["in_progress", "incomplete", "failed"] {
            let mut b = ready(false);
            let event = json!({"type":"response.done","response":{"status":"completed","output":[{
                "type":"function_call","call_id":"partial-call","name":"codex_task",
                "status":status,"arguments":json!({"task":"Write a real file"}).to_string()
            }]}});
            let actions = b.provider_event(&event);
            assert!(!actions.iter().any(|a| matches!(a, Action::Delegate { .. })));
            assert_eq!(
                actions
                    .iter()
                    .filter(|a| matches!(a, Action::Send(_)))
                    .count(),
                1
            );
            assert_eq!(
                actions
                    .iter()
                    .filter(|a| matches!(a, Action::Resume))
                    .count(),
                1
            );
        }
    }
    #[test]
    fn malformed_tools_get_a_bounded_failure_and_resume() {
        let mut b = ready(false);
        let e = json!({"type":"response.done","response":{"status":"completed","output":[
            {"type":"function_call","call_id":"bad","name":"shell","arguments":"{}"},
            {"type":"function_call","call_id":"invalid","name":"codex_task","arguments":json!({"task":"x".repeat(16001)}).to_string()}
        ]}});
        let actions = b.provider_event(&e);
        assert!(!actions.iter().any(|a| matches!(a, Action::Delegate { .. })));
        assert_eq!(
            actions
                .iter()
                .filter(|a| matches!(a, Action::Send(_)))
                .count(),
            2
        );
        assert_eq!(
            actions
                .iter()
                .filter(|a| matches!(a, Action::Resume))
                .count(),
            1
        );
        for i in 0..140 {
            b.provider_event(&json!({"type":"response.done","response":{"status":"completed","output":[
                {"type":"function_call","call_id":format!("id_{i}"),"name":"codex_task","arguments":"{}"}
            ]}}));
        }
        assert_eq!(b.seen_calls.len(), MAX_TOOL_CALLS);
    }
    #[test]
    fn provider_errors_never_relay_raw_details() {
        let mut b = ready(false);
        let a = b.provider_event(
            &json!({"type":"error","error":{"code":"bad token SECRET","message":"SECRET"}}),
        );
        assert_eq!(
            emitted(&a, "error").unwrap()["message"],
            "Ошибка провайдера: provider_error"
        );
    }
    #[test]
    fn transcript_and_completion_keep_listening() {
        let mut b = ready(false);
        b.input(Input::MicStart);
        let transcript=b.provider_event(&json!({"type":"conversation.item.input_audio_transcription.completed","transcript":"Привет"}));
        assert_eq!(
            emitted(&transcript, "transcript").unwrap()["text"],
            "Привет"
        );
        let a = b.provider_event(
            &json!({"type":"response.done","response":{"status":"completed","output":[]}}),
        );
        assert_eq!(emitted(&a, "mic_state").unwrap()["stage"], "listening");
        assert!(
            b.input(Input::Audio(vec![0; 4800]))
                .iter()
                .any(|a| matches!(a, Action::Send(_)))
        );
    }
}
