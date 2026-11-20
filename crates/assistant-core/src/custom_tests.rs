//! Offline custom-mode contracts. No credentials, microphone or model requests.
use super::*;
use crate::interview::{Interview, Source};

fn config() -> SessionConfig {
    serde_json::from_value(json!({
        "workspace":std::env::temp_dir(),
        "model":null,"effort":null,"web_search":true,"parallel":true,
        "realtime":true,"realtime_model":provider::MODEL_DEFAULT
    }))
    .unwrap()
}

#[test]
fn legacy_configs_default_to_assistant_and_custom_values_have_strict_enums() {
    let config = config();
    assert_eq!(config.scenario, Scenario::Assistant);
    assert_eq!(config.custom_name, DEFAULT_CUSTOM_NAME);
    assert_eq!(config.custom_instructions, "");
    assert_eq!(config.custom_behavior, CustomBehavior::Dialogue);
    let mut value = serde_json::to_value(config).unwrap();
    value["scenario"] = json!("custom");
    value["custom_behavior"] = json!("on_request");
    let custom: SessionConfig = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(custom.scenario, Scenario::Custom);
    assert_eq!(custom.custom_behavior, CustomBehavior::OnRequest);
    value["custom_behavior"] = json!("unrestricted");
    assert!(serde_json::from_value::<SessionConfig>(value.clone()).is_err());
    value["custom_behavior"] = json!("dialogue");
    value["scenario"] = json!("unknown");
    assert!(serde_json::from_value::<SessionConfig>(value).is_err());
}

#[test]
fn custom_limits_count_unicode_characters_and_preserve_multiline_instructions() {
    let (name, instructions) =
        normalize_custom_settings("🧪".repeat(64), "  Строка 1\n\tСтрока 2\r\n  ".into()).unwrap();
    assert_eq!(name.chars().count(), 64);
    assert_eq!(instructions, "  Строка 1\n\tСтрока 2\r\n  ");
    assert_eq!(
        normalize_custom_settings("   ".into(), "".into())
            .unwrap()
            .0,
        DEFAULT_CUSTOM_NAME
    );
    assert!(normalize_custom_settings("🧪".repeat(65), "".into()).is_err());
    assert!(normalize_custom_settings("name\n".into(), "".into()).is_err());
    assert!(normalize_custom_settings("name".into(), "ж".repeat(12_000)).is_ok());
    assert!(normalize_custom_settings("name".into(), "ж".repeat(12_001)).is_err());
    assert!(normalize_custom_settings("name".into(), "secret\0".into()).is_err());
    let mut direct = config();
    direct.custom_instructions = "x".repeat(12_001);
    assert!(
        direct.validate().is_err(),
        "direct core callers must be validated too"
    );
}

#[test]
fn custom_instruction_whitespace_survives_validation_and_provider_prompts() {
    let original = "  Example:\n\tfn demo() {\r\n    println!(\"ok\");\n}\n  ";
    let mut config = config();
    config.scenario = Scenario::Custom;
    config.custom_instructions = original.into();
    let config = config.validate().unwrap();
    assert_eq!(config.custom_instructions.as_bytes(), original.as_bytes());
    assert_eq!(
        config.agent().custom_instructions.as_deref(),
        Some(original)
    );
    let encoded = serde_json::to_string(original).unwrap();
    assert!(
        voice_payload(&config)["instructions"]
            .as_str()
            .unwrap()
            .contains(&encoded)
    );
}

#[test]
fn custom_routing_and_prompt_apply_only_to_custom_scenario() {
    let marker = "CUSTOM_TEST: explain using diagrams";
    for (scenario, behavior, meeting, on_request) in [
        (Scenario::Assistant, CustomBehavior::OnRequest, false, false),
        (Scenario::Interview, CustomBehavior::Dialogue, true, false),
        (Scenario::Interview, CustomBehavior::OnRequest, true, false),
        (Scenario::Custom, CustomBehavior::Dialogue, false, false),
        (Scenario::Custom, CustomBehavior::Selective, true, false),
        (Scenario::Custom, CustomBehavior::OnRequest, true, true),
    ] {
        let mut config = config();
        config.scenario = scenario;
        config.custom_behavior = behavior;
        config.custom_instructions = marker.into();
        let config = config.validate().unwrap();
        assert_eq!(config.uses_meeting_audio(), meeting);
        assert_eq!(config.requires_explicit_help(), on_request);
        assert_eq!(
            config.agent().custom_instructions.as_deref(),
            (scenario == Scenario::Custom).then_some(marker)
        );
        let payload = voice_payload(&config);
        assert_eq!(
            payload["instructions"].as_str().unwrap().contains(marker),
            scenario == Scenario::Custom
        );
        // Preferences must not change tools, VAD or allowed Realtime model.
        let base = provider::session_payload(&config.realtime_model);
        for field in [
            "type",
            "model",
            "tools",
            "tool_choice",
            "audio",
            "output_modalities",
        ] {
            assert_eq!(payload[field], base[field]);
        }
    }
}

fn done(id: u64) -> Value {
    json!({"type":"response.done","response":{
        "metadata":{"gate_id":id.to_string()},"status":"completed","output":[{
            "type":"function_call","name":"interview_decision","status":"completed",
            "arguments":json!({"help":true,"target":"self","reason":"offline","task":"Explain the current question"}).to_string()
        }]
    }})
}

#[test]
fn on_request_keeps_remote_context_but_only_local_help_can_trigger_and_repeat() {
    let mut policy = Interview::configured(true, Some("CUSTOM_GATE: focus on SQL".into()));
    policy.start();
    policy.observe(Source::System, "Помоги: покажите left join", None);
    assert!(
        policy.evaluate().is_none(),
        "remote help words must stay context"
    );
    policy.observe(Source::Microphone, "Я объясняю свой ответ", None);
    assert!(
        policy.evaluate().is_none(),
        "ordinary local speech must stay silent"
    );
    policy.observe(Source::Microphone, "Подскажи", None);
    let first = policy.evaluate().unwrap();
    assert!(
        first.request["response"]["instructions"]
            .as_str()
            .unwrap()
            .contains("CUSTOM_GATE")
    );
    let context: Value = serde_json::from_str(
        first.request["response"]["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(context["transcript"][0]["source"], "system");
    assert!(
        context["transcript"][0]["text"]
            .as_str()
            .unwrap()
            .contains("left join")
    );
    assert!(policy.complete(&first, &done(first.id)).unwrap().is_some());
    assert!(policy.complete(&first, &done(first.id)).unwrap().is_none());

    policy.observe(Source::System, "Теперь объясните group by", None);
    assert!(policy.evaluate().is_none());
    policy.observe(Source::Microphone, "Подскажи", None);
    let second = policy
        .evaluate()
        .expect("same local help words must work for a new question");
    assert_ne!(first.id, second.id);
    assert!(
        policy
            .complete(&second, &done(second.id))
            .unwrap()
            .is_some()
    );
}

#[test]
fn on_request_stale_decision_cannot_answer_after_context_changes_or_stop() {
    let mut policy = Interview::configured(true, None);
    policy.start();
    policy.observe(Source::System, "First question", None);
    policy.observe(Source::Microphone, "Помоги", None);
    let old = policy.evaluate().unwrap();
    policy.observe(Source::System, "Clarification of the question", None);
    assert!(policy.complete(&old, &done(old.id)).unwrap().is_none());
    let current = policy.evaluate().unwrap();
    policy.stop();
    assert!(
        policy
            .complete(&current, &done(current.id))
            .unwrap()
            .is_none()
    );
    policy.start();
    policy.observe(Source::System, "A remote question after restart", None);
    assert!(
        policy.evaluate().is_none(),
        "a previous local request cannot cross listening periods"
    );
}

#[test]
fn selective_uses_custom_semantics_without_changing_gate_protocol() {
    let mut custom = Interview::configured(false, Some("CUSTOM_GATE: focus on debugging".into()));
    custom.start();
    custom.observe(Source::System, "Why is this SQL query slow?", None);
    let request = custom.evaluate().unwrap().request;
    assert!(
        request["response"]["instructions"]
            .as_str()
            .unwrap()
            .contains("CUSTOM_GATE")
    );
    assert_eq!(request["response"]["conversation"], "none");
    assert_eq!(
        request["response"]["tool_choice"],
        json!({"type":"function","name":"interview_decision"})
    );
    assert_eq!(request["response"]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(request["response"]["output_modalities"], json!(["text"]));
}
