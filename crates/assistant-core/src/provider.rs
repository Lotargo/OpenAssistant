//! Fixed OpenAI transport endpoints and the proven voice session configuration.
use crate::auth::SafeError;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Error as WebSocketError,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
        protocol::WebSocketConfig,
    },
};

pub const MODEL_DEFAULT: &str = "gpt-realtime-2.1";
pub const MINT_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";
pub const WS_URL: &str = "wss://api.openai.com/v1/realtime";
pub const MAX_HTTP_RESPONSE: usize = 256 * 1024;
pub const MAX_WS_MESSAGE: usize = 1024 * 1024;
pub const TRANSCRIPTION_MODEL: &str = "gpt-transcribe";
pub type ProviderSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub fn allowed_model(model: &str) -> bool {
    matches!(model, "gpt-realtime-2.1" | "gpt-realtime-1.5")
}

pub fn session_payload(model: &str) -> Value {
    json!({
        "type": "realtime",
        "model": model,
        "instructions": concat!(
            "Ты голосовой интерфейс локального ассистента OpenAssistant. Отвечай кратко на русском текстом. ",
            "Для любых действий с проектом, чтения файлов, выполнения команд, написания или изменения кода, ",
            "проверок, поиска в интернете и проверки текущих фактов обязательно вызывай codex_task. ",
            "Передай полную задачу и нужный контекст. Codex имеет собственные инструменты, веб-поиск и ",
            "поддержку параллельной работы; рабочая папка выбрана пользователем в настройках. ",
            "Если пользователь просит написать даже небольшой код, делегируй это Codex, чтобы код был ",
            "отображён в IDE-панели. Независимые задачи можно передать несколькими вызовами инструмента. ",
            "Не выдумывай результаты, не дублируй уже запущенную задачу и не проси подтверждения ",
            "уже сформулированного поручения. Пока Codex работает, продолжай общение. ",
            "После результата дай короткое подтверждение; сам код и подробности уже показываются в интерфейсе."
        ),
        "output_modalities": ["text"],
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.44,
                    "prefix_padding_ms": 450,
                    "silence_duration_ms": 760,
                    "create_response": true,
                    "interrupt_response": true
                },
                "transcription": {
                    "model": TRANSCRIPTION_MODEL,
                    "languages": ["ru", "en"],
                    "keywords": ["Codex", "OpenCode", "ChatGPT", "GPT-Realtime", "Python", "GitHub"]
                }
            }
        },
        "tools": [{
            "type":"function","name":"codex_task",
            "description":"Delegate an implementation, file, terminal, debugging, web research or code-writing task to the local Codex agent in the selected workspace. It streams its progress to the UI and returns the verified result. Independent calls can run concurrently.",
            "parameters":{
                "type":"object","properties":{"task":{"type":"string","description":"Complete task with requirements, paths and relevant conversation context."}},
                "required":["task"],"additionalProperties":false
            }
        }],
        "tool_choice": "auto"
    })
}

pub fn ephemeral_from_response(payload: &Value) -> Result<String, SafeError> {
    let key = payload
        .get("value")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            payload
                .get("client_secret")
                .and_then(|secret| secret.get("value"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
    key.map(str::to_owned)
        .ok_or_else(|| SafeError::new("Realtime secret mint response lacks client secret."))
}

pub async fn mint(settings: &Value, bearer: &str) -> Result<String, SafeError> {
    let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {bearer}"))
        .map_err(|_| {
            SafeError::new("Codex OAuth credential is not a valid authorization header.")
        })?;
    authorization.set_sensitive(true);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| SafeError::new("Could not initialize the Realtime TLS client."))?;
    let mut response = client
        .post(MINT_URL)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .json(&json!({"session": settings}))
        .send()
        .await
        .map_err(|_| SafeError::new("Realtime secret mint failed: network/TLS/DNS problem."))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(SafeError::new(format!(
            "Realtime secret mint rejected: HTTP {}. No paid fallback attempted.",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_RESPONSE as u64)
    {
        return Err(SafeError::new("Realtime secret mint response too large."));
    }
    let mut body = Vec::with_capacity(4096);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| SafeError::new("Could not read the Realtime secret mint response."))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_HTTP_RESPONSE {
            return Err(SafeError::new("Realtime secret mint response too large."));
        }
        body.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&body)
        .map_err(|_| SafeError::new("Realtime secret mint returned invalid JSON."))?;
    if !payload.is_object() {
        return Err(SafeError::new(
            "Realtime secret mint returned non-object JSON.",
        ));
    }
    ephemeral_from_response(&payload)
}

pub async fn connect(ephemeral: &str, model: &str) -> Result<ProviderSocket, SafeError> {
    if !allowed_model(model) {
        return Err(SafeError::new("Unsupported Realtime model."));
    }
    let mut request = format!("{WS_URL}?model={model}")
        .into_client_request()
        .map_err(|_| SafeError::new("Could not build the Realtime WebSocket request."))?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {ephemeral}"))
        .map_err(|_| SafeError::new("Invalid Realtime session secret."))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_WS_MESSAGE);
    config.max_frame_size = Some(MAX_WS_MESSAGE);
    let outcome = tokio::time::timeout(
        Duration::from_secs(22),
        connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| SafeError::new("Realtime WebSocket connection timed out."))?;
    match outcome {
        Ok((socket, _)) => Ok(socket),
        Err(WebSocketError::Http(response)) => Err(SafeError::new(format!(
            "Realtime WebSocket rejected: HTTP {}. No paid fallback attempted.",
            response.status().as_u16()
        ))),
        Err(_) => Err(SafeError::new(
            "Realtime WebSocket failed: network/TLS/protocol problem.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_continuous_voice_and_transcription_settings() {
        let session = session_payload(MODEL_DEFAULT);
        let input = &session["audio"]["input"];
        assert_eq!(session["output_modalities"], json!(["text"]));
        assert!(session["audio"].get("output").is_none());
        assert_eq!(input["turn_detection"]["type"], "server_vad");
        assert_eq!(input["turn_detection"]["threshold"], 0.44);
        assert_eq!(input["turn_detection"]["prefix_padding_ms"], 450);
        assert_eq!(input["turn_detection"]["silence_duration_ms"], 760);
        assert_eq!(input["turn_detection"]["create_response"], true);
        assert_eq!(input["turn_detection"]["interrupt_response"], true);
        assert_eq!(input["transcription"]["model"], "gpt-transcribe");
        assert_eq!(input["transcription"]["languages"], json!(["ru", "en"]));
        assert_eq!(input["noise_reduction"]["type"], "near_field");
    }

    #[test]
    fn exposes_only_codex_delegation_tool() {
        let session = session_payload(MODEL_DEFAULT);
        let tools = session["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "codex_task");
        assert_eq!(tools[0]["parameters"]["additionalProperties"], false);
        assert_eq!(tools[0]["parameters"]["required"], json!(["task"]));
    }

    #[test]
    fn accepts_both_supported_mint_shapes() {
        assert_eq!(
            ephemeral_from_response(&json!({"value": "temporary"})).unwrap(),
            "temporary"
        );
        assert_eq!(
            ephemeral_from_response(&json!({"client_secret": {"value": "nested"}})).unwrap(),
            "nested"
        );
        assert_eq!(
            ephemeral_from_response(&json!({"value": "", "client_secret": {"value": "nested"}}))
                .unwrap(),
            "nested"
        );
    }

    #[test]
    fn malformed_mint_shapes_return_safe_errors() {
        for payload in [
            json!({}),
            json!({"value": 5}),
            json!({"value": ""}),
            json!({"client_secret": "private-response"}),
        ] {
            let error = ephemeral_from_response(&payload).unwrap_err().to_string();
            assert!(!error.contains("private-response"));
        }
    }

    #[test]
    fn model_allowlist_prevents_url_injection() {
        assert!(allowed_model(MODEL_DEFAULT));
        assert!(allowed_model("gpt-realtime-1.5"));
        assert!(!allowed_model(""));
        assert!(!allowed_model("gpt-realtime-2.1&other=endpoint"));
        assert!(!allowed_model("gpt-realtime-2.1\r\nAuthorization: leaked"));
    }
}
