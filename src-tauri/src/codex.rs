use crate::usage::{ProviderUsage, UsageWindow};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn executable() -> Result<PathBuf, String> {
    crate::locate::find("CODEX_BINARY", "codex", "openai.chatgpt-", |extension, binary| {
        std::fs::read_dir(extension.join("bin"))
            .ok()?
            .filter_map(Result::ok)
            .filter(|dir| crate::locate::platform_dir(&dir.file_name().to_string_lossy()))
            .map(|dir| dir.path().join(binary))
            .find(|path| path.is_file())
    })
    .ok_or_else(|| {
        "Codex executable not found. Install Codex CLI or set CODEX_BINARY to your codex path."
            .into()
    })
}

fn send(server: &mut Server, message: Value) -> Result<(), String> {
    let stdin = server.0.stdin.as_mut().ok_or("Codex connection closed.")?;
    writeln!(stdin, "{message}")
        .and_then(|_| stdin.flush())
        .map_err(|_| "Could not query Codex.".into())
}

fn response(receiver: &Receiver<Value>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let wait = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Codex usage request timed out. Try refreshing again.")?;
        let message = receiver.recv_timeout(wait).map_err(|_| {
            "Codex usage request timed out or the connection closed. Try refreshing again."
        })?;
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if message.get("error").is_some() {
            return Err("Codex could not return account usage. Check your ChatGPT login in Codex, then refresh.".into());
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex returned an unreadable response.".into());
    }
}

fn parse_usage(account: &Value, result: &Value) -> Result<ProviderUsage, String> {
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Sign in to Codex with ChatGPT to identify your account.")?;
    let limits = result
        .pointer("/rateLimitsByLimitId/codex")
        .or_else(|| result.get("rateLimits"))
        .ok_or("Codex did not return subscription limits.")?;
    if limits
        .get("limitId")
        .and_then(Value::as_str)
        .is_some_and(|id| id != "codex")
    {
        return Err("Codex did not return its main subscription limit bucket.".into());
    }
    let windows: Vec<_> = [("primary", "Session"), ("secondary", "Weekly")]
        .iter()
        .filter_map(|(key, fallback)| {
            let value = &limits[key];
            let used_percent = value.get("usedPercent")?.as_f64()?;
            if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
                return None;
            }
            let label = match value.get("windowDurationMins").and_then(Value::as_u64) {
                Some(10080) => "Weekly".into(),
                Some(m) if m % 60 == 0 => format!("{}-hour window", m / 60),
                Some(m) => format!("{m}-minute window"),
                None => (*fallback).into(),
            };
            Some(UsageWindow {
                label,
                used_percent,
                resets_at: value.get("resetsAt").and_then(Value::as_i64),
            })
        })
        .collect();
    if windows.is_empty() {
        return Err("Codex did not return subscription limits for this account.".into());
    }
    Ok(ProviderUsage {
        account_email: Some(email.to_owned()),
        plan: account
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        source: "Codex account".into(),
        updated_at: chrono::Utc::now().timestamp(),
        windows,
    })
}

fn start_server() -> Result<(Server, Receiver<Value>), String> {
    let path = executable()?;
    let mut command = Command::new(&path);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = crate::locate::child_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // Keep the background helper's console hidden.
    }
    let mut server = Server(
        command
            .spawn()
            .map_err(|error| format!("Could not start Codex ({}): {error}", path.display()))?,
    );
    let stdout = server
        .0
        .stdout
        .take()
        .ok_or("Could not connect to Codex.")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(25);
    let initialized = send(
        &mut server,
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"usage_widget","version":"0.1.0"}}}),
    )
    .and_then(|_| response(&receiver, 1, deadline))
    .and_then(|_| send(&mut server, json!({"method":"initialized","params":{}})));
    if let Err(error) = initialized {
        // Old Codex versions lack `app-server` and exit immediately.
        if let Ok(Some(status)) = server.0.try_wait() {
            return Err(format!(
                "Codex ({}) stopped before connecting ({status}). Update Codex to the latest version, then refresh.",
                path.display()
            ));
        }
        return Err(error);
    }
    Ok((server, receiver))
}

pub(crate) fn read_usage() -> Result<ProviderUsage, String> {
    let (mut server, receiver) = start_server()?;
    let deadline = Instant::now() + Duration::from_secs(25);
    send(
        &mut server,
        json!({"id":2,"method":"account/read","params":{"refreshToken":false}}),
    )?;
    let identity = response(&receiver, 2, deadline)?;
    let account = &identity["account"];
    if account.get("email").and_then(Value::as_str).is_none() {
        return Err("Sign in to Codex with your ChatGPT account, then refresh.".into());
    }
    send(
        &mut server,
        json!({"id":3,"method":"account/rateLimits/read"}),
    )?;
    let limits = response(&receiver, 3, deadline)?;
    parse_usage(account, &limits)
}

struct Login {
    server: Server,
    receiver: Receiver<Value>,
    id: String,
    auth_url: String,
    expires: Instant,
}

#[derive(Default)]
pub(crate) struct AuthState(Arc<Mutex<Option<Login>>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginStart {
    login_id: String,
    auth_url: String,
}

fn login_completion(message: &Value, id: &str) -> Option<Result<(), String>> {
    if message["method"] != "account/login/completed"
        || message["params"]["loginId"].as_str() != Some(id)
    {
        return None;
    }
    Some(if message["params"]["success"] == true {
        Ok(())
    } else {
        Err("Codex sign-in was not completed. Try connecting again.".into())
    })
}

#[tauri::command]
pub(crate) async fn codex_login_start(
    state: tauri::State<'_, AuthState>,
) -> Result<LoginStart, String> {
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || start_login(&shared))
        .await
        .map_err(|_| "Could not start Codex sign-in.".to_owned())?
}

fn start_login(state: &Arc<Mutex<Option<Login>>>) -> Result<LoginStart, String> {
    let mut pending = state
        .lock()
        .map_err(|_| "Could not access sign-in state.")?;
    if let Some(login) = pending.as_ref() {
        if Instant::now() < login.expires {
            // Recover a pending sign-in after the webview is reloaded.
            return Ok(LoginStart {
                login_id: login.id.clone(),
                auth_url: login.auth_url.clone(),
            });
        }
    }
    *pending = None;
    let (mut server, receiver) = start_server()?;
    send(
        &mut server,
        json!({"id":2,"method":"account/login/start","params":{"type":"chatgpt"}}),
    )?;
    let result = response(&receiver, 2, Instant::now() + Duration::from_secs(25))?;
    let id = result["loginId"]
        .as_str()
        .ok_or("Codex did not return a login identifier.")?
        .to_owned();
    let url = result["authUrl"]
        .as_str()
        .ok_or("Codex did not return a sign-in URL.")?
        .to_owned();
    // Only official HTTPS authentication pages may be opened by the frontend.
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid Codex sign-in URL.")?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("auth.openai.com" | "chatgpt.com"))
    {
        return Err("Codex returned an unexpected sign-in URL.".into());
    }
    *pending = Some(Login {
        server,
        receiver,
        id: id.clone(),
        auth_url: url.clone(),
        expires: Instant::now() + Duration::from_secs(300),
    });
    let weak = Arc::downgrade(state);
    let expired_id = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(300));
        if let Some(state) = weak.upgrade() {
            if let Ok(mut pending) = state.lock() {
                if pending
                    .as_ref()
                    .is_some_and(|login| login.id == expired_id && Instant::now() >= login.expires)
                {
                    *pending = None;
                }
            }
        }
    });
    Ok(LoginStart {
        login_id: id,
        auth_url: url,
    })
}

#[tauri::command]
pub(crate) fn codex_login_poll(
    state: tauri::State<'_, AuthState>,
    login_id: String,
) -> Result<bool, String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Could not access sign-in state.")?;
    let login = pending.as_mut().ok_or("No Codex sign-in is pending.")?;
    if login.id != login_id {
        return Err("This sign-in attempt is no longer active.".into());
    }
    if Instant::now() >= login.expires {
        *pending = None;
        return Err("Sign-in timed out. Connect again to retry.".into());
    }
    loop {
        match login.receiver.try_recv() {
            Ok(message) => {
                if let Some(result) = login_completion(&message, &login_id) {
                    *pending = None;
                    return result.map(|_| true);
                }
            }
            Err(mpsc::TryRecvError::Empty) => return Ok(false),
            Err(mpsc::TryRecvError::Disconnected) => {
                *pending = None;
                return Err("Codex sign-in connection closed. Try connecting again.".into());
            }
        }
    }
}

#[tauri::command]
pub(crate) fn codex_login_cancel(
    state: tauri::State<'_, AuthState>,
    login_id: String,
) -> Result<(), String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Could not access sign-in state.")?;
    if let Some(login) = pending.as_mut() {
        if login.id != login_id {
            return Err("This sign-in attempt is no longer active.".into());
        }
        let _ = send(
            &mut login.server,
            json!({"id":3,"method":"account/login/cancel","params":{"loginId":login_id}}),
        );
    }
    *pending = None;
    Ok(())
}

#[tauri::command]
pub(crate) async fn codex_account() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (mut server, receiver) = start_server()?;
        send(
            &mut server,
            json!({"id":2,"method":"account/read","params":{"refreshToken":false}}),
        )?;
        let result = response(&receiver, 2, Instant::now() + Duration::from_secs(25))?;
        Ok(result["account"]["email"].as_str().map(str::to_owned))
    })
    .await
    .map_err(|_| "Could not read the Codex account.".to_owned())?
}

#[tauri::command]
pub(crate) async fn codex_logout(expected_email: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut server, receiver) = start_server()?;
        let deadline = Instant::now() + Duration::from_secs(25);
        send(&mut server, json!({"id":2,"method":"account/read","params":{"refreshToken":false}}))?;
        let account = response(&receiver, 2, deadline)?;
        if !account["account"]["email"].as_str().is_some_and(|email| email.eq_ignore_ascii_case(&expected_email)) {
            return Err("The signed-in Codex account changed. Refresh and select it again before disconnecting.".into());
        }
        send(&mut server, json!({"id":3,"method":"account/logout"}))?;
        response(&receiver, 3, deadline)?;
        Ok(())
    })
    .await
    .map_err(|_| "Could not disconnect Codex.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_notifications_must_match_the_pending_attempt() {
        assert!(login_completion(&json!({"method":"account/updated"}), "a").is_none());
        assert!(login_completion(
            &json!({"method":"account/login/completed","params":{"loginId":"b","success":true}}),
            "a"
        )
        .is_none());
        assert!(login_completion(
            &json!({"method":"account/login/completed","params":{"loginId":"a","success":true}}),
            "a"
        )
        .unwrap()
        .is_ok());
        assert!(login_completion(&json!({"method":"account/login/completed","params":{"loginId":"a","success":false,"error":"secret"}}), "a").unwrap().is_err());
    }

    #[test]
    fn usage_is_associated_with_the_server_account() {
        let limits = json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":72,"windowDurationMins":300,"resetsAt":1791356400},"secondary":{"usedPercent":10,"windowDurationMins":10080}}}});
        for email in ["work@example.com", "personal@example.com"] {
            let reading = parse_usage(&json!({"email":email,"planType":"plus"}), &limits).unwrap();
            assert_eq!(reading.account_email.as_deref(), Some(email));
            assert_eq!(reading.windows[0].used_percent, 72.0);
            assert_eq!(reading.windows[0].label, "5-hour window");
            assert_eq!(reading.windows[1].resets_at, None);
        }
        assert!(parse_usage(&json!({"type":"apiKey"}), &limits).is_err());
        assert!(parse_usage(
            &json!({"email":"work@example.com"}),
            &json!({"rateLimits":{"primary":{"usedPercent":101}}})
        )
        .is_err());
    }
}
