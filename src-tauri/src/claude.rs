use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

fn executable() -> Result<PathBuf, String> {
    crate::locate::find("CLAUDE_BINARY", "claude", "anthropic.claude-code-", |extension, binary| {
        Some(extension.join("resources/native-binary").join(binary))
    })
    .ok_or_else(|| "Claude Code executable not found. Install Claude Code or set CLAUDE_BINARY to your claude path.".into())
}

fn command(args: &[&str]) -> Result<Command, String> {
    let mut command = Command::new(executable()?);
    command
        .args(args)
        .stdin(Stdio::null())
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
    Ok(command)
}

/// Only a Claude subscription login has subscription usage to monitor.
fn signed_in_email(status: &Value) -> Option<String> {
    if status["loggedIn"] != true || status["authMethod"] != "claude.ai" {
        return None;
    }
    status["email"]
        .as_str()
        .filter(|s| s.contains('@'))
        .map(str::to_owned)
}

fn read_account() -> Result<Option<String>, String> {
    let output = command(&["auth", "status", "--json"])?
        .output()
        .map_err(|_| "Could not start the installed Claude Code CLI.".to_string())?;
    // A signed-out CLI may exit with an error but still reports its status as JSON.
    let status: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Claude Code returned an unreadable sign-in status.".to_string())?;
    Ok(signed_in_email(&status))
}

#[tauri::command]
pub(crate) async fn claude_account() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(read_account)
        .await
        .map_err(|_| "Could not read the Claude account.".to_owned())?
}

#[tauri::command]
pub(crate) async fn claude_logout(expected_email: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !read_account()?.is_some_and(|email| email.eq_ignore_ascii_case(&expected_email)) {
            return Err("The signed-in Claude account changed. Refresh and select it again before disconnecting.".into());
        }
        command(&["auth", "logout"])?
            .output()
            .map_err(|_| "Could not start the installed Claude Code CLI.".to_string())?;
        if read_account()?.is_some() {
            return Err("Claude Code is still signed in. Try disconnecting again.".into());
        }
        Ok(())
    })
    .await
    .map_err(|_| "Could not disconnect Claude.".to_owned())?
}

struct Login {
    child: Child,
    stdin: ChildStdin,
    id: String,
    auth_url: String,
    expires: Instant,
}

impl Drop for Login {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub(crate) struct AuthState(Arc<Mutex<Option<Login>>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginStart {
    login_id: String,
    auth_url: String,
}

/// The CLI prints a manual sign-in URL whose page shows a code to paste back.
fn sign_in_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url = line[start..].split_whitespace().next()?;
    let parsed = reqwest::Url::parse(url).ok()?;
    (parsed.scheme() == "https" && matches!(parsed.host_str(), Some("claude.com" | "claude.ai")))
        .then(|| url.to_owned())
}

fn forward_lines(stream: impl Read + Send + 'static, sender: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        // Keep draining after the URL is found so the CLI never blocks on a full pipe.
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
}

#[tauri::command]
pub(crate) async fn claude_login_start(
    state: tauri::State<'_, AuthState>,
) -> Result<LoginStart, String> {
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || start_login(&shared))
        .await
        .map_err(|_| "Could not start Claude sign-in.".to_owned())?
}

fn start_login(state: &Arc<Mutex<Option<Login>>>) -> Result<LoginStart, String> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
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
    // The CLI opens the browser itself and completes automatically through a local callback.
    let mut child = command(&["auth", "login", "--claudeai"])?
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start the installed Claude Code CLI.".to_string())?;
    let (sender, receiver) = mpsc::channel();
    forward_lines(child.stdout.take().ok_or("Could not connect to Claude Code.")?, sender.clone());
    forward_lines(child.stderr.take().ok_or("Could not connect to Claude Code.")?, sender);
    let stdin = child.stdin.take().ok_or("Could not connect to Claude Code.")?;
    let deadline = Instant::now() + Duration::from_secs(25);
    let url = loop {
        let wait = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Claude sign-in did not start in time. Try again.")?;
        match receiver.recv_timeout(wait) {
            Ok(line) => {
                if let Some(url) = sign_in_url(&line) {
                    break url;
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude Code did not return a sign-in URL. Try again.".into());
            }
        }
    };
    let id = format!(
        "claude-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    *pending = Some(Login {
        child,
        stdin,
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

fn active_login<'a>(
    pending: &'a mut Option<Login>,
    login_id: &str,
) -> Result<&'a mut Login, String> {
    let login = pending.as_mut().ok_or("No Claude sign-in is pending.")?;
    if login.id != login_id {
        return Err("This sign-in attempt is no longer active.".into());
    }
    Ok(login)
}

#[tauri::command]
pub(crate) fn claude_login_poll(
    state: tauri::State<'_, AuthState>,
    login_id: String,
) -> Result<bool, String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Could not access sign-in state.")?;
    let login = active_login(&mut pending, &login_id)?;
    if Instant::now() >= login.expires {
        *pending = None;
        return Err("Sign-in timed out. Sign in again to retry.".into());
    }
    match login.child.try_wait() {
        Ok(None) => Ok(false),
        Ok(Some(status)) => {
            *pending = None;
            if status.success() {
                Ok(true)
            } else {
                Err("Claude sign-in was not completed. Try signing in again.".into())
            }
        }
        Err(_) => {
            *pending = None;
            Err("Claude sign-in connection closed. Try signing in again.".into())
        }
    }
}

#[tauri::command]
pub(crate) fn claude_login_code(
    state: tauri::State<'_, AuthState>,
    login_id: String,
    code: String,
) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() || code.len() > 1024 || code.chars().any(char::is_control) {
        return Err("Paste the code shown after signing in.".into());
    }
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Could not access sign-in state.")?;
    let login = active_login(&mut pending, &login_id)?;
    writeln!(login.stdin, "{code}")
        .and_then(|_| login.stdin.flush())
        .map_err(|_| "Claude sign-in connection closed. Try signing in again.".into())
}

#[tauri::command]
pub(crate) fn claude_login_cancel(
    state: tauri::State<'_, AuthState>,
    login_id: String,
) -> Result<(), String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Could not access sign-in state.")?;
    if pending.as_ref().is_some_and(|login| login.id != login_id) {
        return Err("This sign-in attempt is no longer active.".into());
    }
    *pending = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_subscription_logins_identify_an_account() {
        let status = |method: &str| json!({"loggedIn":true,"authMethod":method,"email":"work@example.com"});
        assert_eq!(signed_in_email(&status("claude.ai")).as_deref(), Some("work@example.com"));
        assert!(signed_in_email(&status("api_key")).is_none());
        assert!(signed_in_email(&json!({"loggedIn":false,"authMethod":"claude.ai","email":"work@example.com"})).is_none());
        assert!(signed_in_email(&json!({"loggedIn":true,"authMethod":"claude.ai"})).is_none());
    }

    #[test]
    #[ignore = "Runs the installed Claude Code CLI"]
    fn installed_cli_reports_the_account() {
        let email = read_account().expect("Installed Claude Code status should be readable");
        println!("Claude Code signed in: {}", email.is_some());
    }

    #[test]
    fn sign_in_url_must_be_an_official_https_page() {
        assert_eq!(
            sign_in_url("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x").as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&state=x")
        );
        assert!(sign_in_url("Opening browser to sign in…").is_none());
        assert!(sign_in_url("visit: https://claude.com.evil.example/oauth").is_none());
        assert!(sign_in_url("visit: http://claude.com/oauth").is_none());
    }
}
