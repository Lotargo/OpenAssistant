//! Read-only Codex OAuth credentials. Raw credentials never enter an error.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use std::{
    fmt,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_AUTH_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SafeError(String);

impl SafeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub struct Credential {
    pub access_token: String,
    pub expires_at: u64,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("access_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn resolve_path(
    override_home: Option<&Path>,
    env_home: Option<&Path>,
    user_home: Option<&Path>,
) -> Result<PathBuf, SafeError> {
    let specified = override_home
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| env_home.filter(|path| !path.as_os_str().is_empty()));
    let directory = if let Some(path) = specified {
        let text = path.to_string_lossy();
        if text == "~" || text.starts_with("~/") || text.starts_with("~\\") {
            let home = user_home.ok_or_else(|| {
                SafeError::new("Cannot locate the home directory for Codex OAuth.")
            })?;
            if text == "~" {
                home.to_path_buf()
            } else {
                home.join(&text[2..])
            }
        } else {
            path.to_path_buf()
        }
    } else {
        user_home
            .ok_or_else(|| SafeError::new("Cannot locate the home directory for Codex OAuth."))?
            .join(".codex")
    };
    Ok(directory.join("auth.json"))
}

pub fn credential_path(codex_home: Option<&Path>) -> Result<PathBuf, SafeError> {
    let environment = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    let home = dirs::home_dir();
    resolve_path(codex_home, environment.as_deref(), home.as_deref())
}

pub fn load_credential(codex_home: Option<&Path>) -> Result<Credential, SafeError> {
    let path = credential_path(codex_home)?;
    let file = File::open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SafeError::new(
                "Codex OAuth auth.json not found. Run 'codex login' and check CODEX_HOME.",
            )
        } else {
            SafeError::new("Cannot read valid Codex auth.json; no credentials sent.")
        }
    })?;
    let modified = file
        .metadata()
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());
    let mut raw = Vec::new();
    file.take(MAX_AUTH_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| SafeError::new("Cannot read valid Codex auth.json; no credentials sent."))?;
    if raw.len() as u64 > MAX_AUTH_BYTES {
        return Err(SafeError::new("Codex auth store is too large."));
    }
    parse_credential(&raw, modified, now_seconds())
}

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    claims.is_object().then_some(claims)
}

fn parse_credential(raw: &[u8], modified: Option<u64>, now: u64) -> Result<Credential, SafeError> {
    let object: Value = serde_json::from_slice(raw)
        .map_err(|_| SafeError::new("Cannot read valid Codex auth.json; no credentials sent."))?;
    let object = object
        .as_object()
        .ok_or_else(|| SafeError::new("Codex auth store format is invalid."))?;
    let mode = match object.get("auth_mode") {
        None => String::new(),
        Some(Value::String(mode)) => mode.trim().to_ascii_lowercase(),
        Some(_) => {
            return Err(SafeError::new(
                "Codex auth.json is not in ChatGPT OAuth mode.",
            ));
        }
    };
    if !mode.is_empty() && mode != "chatgpt" && mode != "chatgptauthtokens" {
        return Err(SafeError::new(
            "Codex auth.json is not in ChatGPT OAuth mode.",
        ));
    }
    if mode.is_empty() && object.get("OPENAI_API_KEY").is_some_and(Value::is_string) {
        return Err(SafeError::new(
            "Codex auth.json appears to use API-key mode, not ChatGPT OAuth.",
        ));
    }
    let access = object
        .get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| SafeError::new("No ChatGPT OAuth access token in Codex auth store."))?;
    let claims = jwt_claims(access);
    if access.bytes().filter(|byte| *byte == b'.').count() >= 2 && claims.is_none() {
        return Err(SafeError::new(
            "Codex OAuth access token has an invalid JWT payload.",
        ));
    }
    let numeric_expiry = claims
        .as_ref()
        .and_then(|claims| claims.get("exp"))
        .and_then(Value::as_f64);
    let expires_at = match numeric_expiry {
        Some(expiry) if expiry.is_finite() => {
            if expiry <= now.saturating_add(60) as f64 {
                return Err(SafeError::new(
                    "Codex OAuth access token expired or expires soon. Refresh with Codex CLI; no token refresh attempted here.",
                ));
            }
            expiry as u64
        }
        _ => modified
            .map(|value| value.saturating_add(3600))
            .ok_or_else(|| SafeError::new("Cannot determine Codex OAuth token lifetime."))?,
    };
    if expires_at <= now.saturating_add(60) {
        return Err(SafeError::new(
            "Codex OAuth access token expired or expires soon. Refresh with Codex CLI; no token refresh attempted here.",
        ));
    }
    Ok(Credential {
        access_token: access.to_owned(),
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(claims: Value) -> String {
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    fn store(access: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "auth_mode": "chatgpt",
            "tokens": {"access_token": access, "refresh_token": "never-used"}
        }))
        .unwrap()
    }

    #[test]
    fn reads_valid_oauth_and_redacts_debug() {
        let access = token(json!({"exp": 4000}));
        let credential = parse_credential(&store(&access), Some(900), 1000).unwrap();
        assert_eq!(credential.expires_at, 4000);
        assert_eq!(credential.access_token, access);
        assert!(!format!("{credential:?}").contains(&access));
        assert!(!format!("{credential:?}").contains("never-used"));
    }

    #[test]
    fn rejects_expired_and_about_to_expire() {
        for expiry in [0, 999, 1060] {
            let error = parse_credential(&store(&token(json!({"exp": expiry}))), Some(1000), 1000)
                .unwrap_err();
            assert!(error.to_string().contains("expired"));
        }
        assert!(parse_credential(&store(&token(json!({"exp": 1061}))), Some(1000), 1000).is_ok());
    }

    #[test]
    fn rejects_api_key_mode_even_when_oauth_token_is_present() {
        let mut object: Value = serde_json::from_slice(&store("opaque")).unwrap();
        object["auth_mode"] = json!("apikey");
        assert!(parse_credential(&serde_json::to_vec(&object).unwrap(), Some(1000), 1000).is_err());
        object.as_object_mut().unwrap().remove("auth_mode");
        object["OPENAI_API_KEY"] = json!("not-a-real-key");
        assert!(parse_credential(&serde_json::to_vec(&object).unwrap(), Some(1000), 1000).is_err());
    }

    #[test]
    fn opaque_and_missing_expiry_use_bounded_file_age() {
        for access in ["opaque".to_owned(), token(json!({"sub": "fake"}))] {
            assert_eq!(
                parse_credential(&store(&access), Some(1000), 1000)
                    .unwrap()
                    .expires_at,
                4600
            );
            assert!(parse_credential(&store(&access), Some(1000), 4600).is_err());
            assert!(parse_credential(&store(&access), None, 1000).is_err());
        }
    }

    #[test]
    fn malformed_stores_do_not_echo_input() {
        for raw in [b"secret-invalid-json".as_slice(), b"[]", b"null", b"{}"] {
            let error = parse_credential(raw, Some(1000), 1000)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("secret-invalid-json"));
        }
        assert!(parse_credential(&store("header.%%%%.signature"), Some(1000), 1000).is_err());
        assert!(parse_credential(&store("   "), Some(1000), 1000).is_err());
    }

    #[test]
    fn explicit_home_overrides_environment_and_tilde_expands() {
        let home = Path::new("user");
        assert_eq!(
            resolve_path(None, None, Some(home)).unwrap(),
            home.join(".codex/auth.json")
        );
        assert_eq!(
            resolve_path(
                Some(Path::new("custom")),
                Some(Path::new("environment")),
                Some(home)
            )
            .unwrap(),
            Path::new("custom").join("auth.json")
        );
        assert_eq!(
            resolve_path(None, Some(Path::new("~/codex")), Some(home)).unwrap(),
            home.join("codex/auth.json")
        );
        assert_eq!(
            resolve_path(Some(Path::new("~")), None, Some(home)).unwrap(),
            home.join("auth.json")
        );
    }
}
