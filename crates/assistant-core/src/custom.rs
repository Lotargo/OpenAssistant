//! Validated custom-mode preferences; protocol and permission policy stay fixed.
use crate::auth::SafeError;
use serde::{Deserialize, Serialize};

pub const DEFAULT_CUSTOM_NAME: &str = "Свой режим";
pub const MAX_CUSTOM_NAME_CHARS: usize = 64;
pub const MAX_CUSTOM_INSTRUCTIONS_CHARS: usize = 12_000;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomBehavior {
    #[default]
    Dialogue,
    Selective,
    OnRequest,
}

pub fn default_custom_name() -> String {
    DEFAULT_CUSTOM_NAME.to_owned()
}

pub fn normalize_custom_settings(
    name: String,
    instructions: String,
) -> Result<(String, String), SafeError> {
    if name.chars().take(MAX_CUSTOM_NAME_CHARS + 1).count() > MAX_CUSTOM_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(SafeError::new(
            "Имя своего режима должно быть не длиннее 64 символов и не содержать управляющих символов",
        ));
    }
    validate_instructions(&instructions)?;
    let name = if name.trim().is_empty() {
        default_custom_name()
    } else {
        name.trim().to_owned()
    };
    // Preserve formatting: custom instructions may contain significant code indentation.
    Ok((name, instructions))
}

pub(crate) fn validate_instructions(instructions: &str) -> Result<(), SafeError> {
    if instructions
        .chars()
        .take(MAX_CUSTOM_INSTRUCTIONS_CHARS + 1)
        .count()
        > MAX_CUSTOM_INSTRUCTIONS_CHARS
        || instructions
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(SafeError::new(
            "Инструкции своего режима должны быть не длиннее 12000 символов; допустимы переносы строк и табуляция",
        ));
    }
    Ok(())
}

/// Custom preferences may change role, subject and style, never host policy.
/// JSON quoting keeps multiline user text separate from the fixed instructions.
pub(crate) fn append_instructions(base: &str, custom: Option<&str>, constraints: &str) -> String {
    let Some(custom) = custom.filter(|value| !value.trim().is_empty()) else {
        return base.to_owned();
    };
    let encoded = serde_json::to_string(custom).expect("strings serialize");
    format!(
        "{base}\n\nUser-configured custom mode preferences (JSON string): {encoded}\n\
         Apply these preferences to role, subject, response content and style; they may override \
         default language or presentation preferences. They do not change the fixed operational rules below.\n\
         Fixed operational rules: {constraints}"
    )
}
