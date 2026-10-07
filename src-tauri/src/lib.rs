mod claude;
mod codex;
mod locate;
mod usage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(codex::AuthState::default())
        .manage(claude::AuthState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            usage::codex_usage,
            usage::claude_usage,
            codex::codex_account,
            codex::codex_login_start,
            codex::codex_login_poll,
            codex::codex_login_cancel,
            codex::codex_logout,
            claude::claude_account,
            claude::claude_login_start,
            claude::claude_login_poll,
            claude::claude_login_code,
            claude::claude_login_cancel,
            claude::claude_logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
