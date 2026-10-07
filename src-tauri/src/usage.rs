use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub(crate) label: String,
    pub(crate) used_percent: f64,
    pub(crate) resets_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub(crate) account_email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) source: String,
    pub(crate) updated_at: i64,
    pub(crate) windows: Vec<UsageWindow>,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find your home directory.".into())
}

fn config_dir(variable: &str, default: &str) -> Result<PathBuf, String> {
    Ok(std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or(home()?.join(default)))
}

#[tauri::command]
pub async fn codex_usage() -> Result<ProviderUsage, String> {
    tauri::async_runtime::spawn_blocking(super::codex::read_usage)
        .await
        .map_err(|_| "Could not query the Codex account.".to_string())?
}
fn claude_windows(value: &Value) -> Vec<UsageWindow> {
    [
        ("five_hour", "5-hour window"),
        ("seven_day", "Weekly"),
        ("seven_day_sonnet", "Weekly \u{00b7} Sonnet"),
        ("seven_day_opus", "Weekly \u{00b7} Opus"),
    ]
    .iter()
    .filter_map(|(key, label)| {
        let window = &value[key];
        let used = window.get("utilization")?.as_f64()?;
        if !used.is_finite() || !(0.0..=100.0).contains(&used) {
            return None;
        }
        let reset = window
            .get("resets_at")
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp());
        Some(UsageWindow {
            label: (*label).into(),
            used_percent: used,
            resets_at: reset,
        })
    })
    .collect()
}

/// Claude Code keeps its login in a file, except on macOS where it uses the Keychain.
fn claude_credentials() -> Result<String, String> {
    let path = config_dir("CLAUDE_CONFIG_DIR", ".claude")?.join(".credentials.json");
    if let Ok(raw) = fs::read_to_string(path) {
        return Ok(raw);
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                if let Ok(raw) = String::from_utf8(output.stdout) {
                    return Ok(raw.trim().to_owned());
                }
            }
        }
    }
    Err("Claude login not found. Run claude and sign in with your Claude subscription.".into())
}

#[tauri::command]
pub async fn claude_usage() -> Result<ProviderUsage, String> {
    let raw = tauri::async_runtime::spawn_blocking(claude_credentials)
        .await
        .map_err(|_| "Could not read the Claude login.".to_string())??;
    let credentials: Value = serde_json::from_str(&raw)
        .map_err(|_| "Could not read the Claude login file.".to_string())?;
    let oauth = &credentials["claudeAiOauth"];
    let token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("No Claude subscription login found. Sign in through Claude Code first.")?;
    if oauth
        .get("expiresAt")
        .and_then(Value::as_i64)
        .is_some_and(|expiry| expiry <= chrono::Utc::now().timestamp_millis())
    {
        return Err("Claude login expired. Open Claude Code to refresh your login, then refresh this widget.".into());
    }
    // Credentials stay in Rust and are sent only to Anthropic, never to the webview.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize the usage connection.")?;
    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|_| {
            "Could not reach Claude usage. Check your internet connection and try again."
                .to_string()
        })?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => {
            return Err(
                "Claude login was rejected. Sign in again through Claude Code, then refresh."
                    .into(),
            )
        }
        429 => {
            return Err(
                "Claude usage is rate limited. Wait a few minutes before refreshing.".into(),
            )
        }
        status => {
            return Err(format!(
                "Claude usage is unavailable (HTTP {status}). Try again later."
            ))
        }
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Claude returned an unreadable usage response.".to_string())?;
    let windows = claude_windows(&value);
    if windows.is_empty() {
        return Err("Claude did not return subscription limits for this account.".into());
    }
    Ok(ProviderUsage {
        account_email: None,
        plan: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        source: "Claude account".into(),
        updated_at: chrono::Utc::now().timestamp(),
        windows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Reads the installed Codex account and calls Anthropic using the installed Claude login"]
    fn installed_account_readers() {
        let codex =
            super::super::codex::read_usage().expect("Installed Codex usage should be readable");
        assert!(!codex.windows.is_empty());
        let claude = tauri::async_runtime::block_on(claude_usage())
            .expect("Installed Claude usage should be readable");
        assert!(!claude.windows.is_empty());
        println!(
            "Account readers verified: {} Codex windows, {} Claude windows",
            codex.windows.len(),
            claude.windows.len()
        );
    }

    #[test]
    fn claude_preserves_idle_windows_and_optional_model_limits() {
        let value = serde_json::json!({"five_hour":{"utilization":0,"resets_at":null},"seven_day":{"utilization":100,"resets_at":"2026-10-09T03:00:00+00:00"},"seven_day_sonnet":null,"seven_day_opus":{"utilization":42,"resets_at":null}});
        let windows = claude_windows(&value);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].used_percent, 0.0);
        assert_eq!(windows[0].resets_at, None);
        assert_eq!(windows[1].resets_at, Some(1791514800));
        assert!(claude_windows(&serde_json::json!({"five_hour":{"utilization":101}})).is_empty());
    }
}
