use serde_json::{json, Value};
use tauri::{Emitter, Manager};

fn activate(app: &tauri::AppHandle, notice: &Value, execute: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit(
            "notice-action",
            json!({"action": notice["action"], "volume": notice["volume"], "execute": execute}),
        );
    }
}

// OS-owned chrome, with one explicit action and the same content as the app.
#[cfg(target_os = "macos")]
pub fn show(app: tauri::AppHandle, notice: Value) -> Result<(), String> {
    std::thread::Builder::new()
        .name("arca-notice".into())
        .spawn(move || {
            use mac_notification_sys::{MainButton, Notification, NotificationResponse};
            let identifier = if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                &app.config().identifier
            };
            if mac_notification_sys::set_application(identifier).is_err() {
                return;
            }
            let title = notice["title"].as_str().unwrap_or("Arca");
            let body = notice["body"].as_str().unwrap_or("");
            let label = notice["actionLabel"].as_str().unwrap_or("Review");
            let response = Notification::new()
                .title(title)
                .message(body)
                .main_button(MainButton::SingleAction(label))
                .close_button("Later")
                .wait_for_click(true)
                .send();
            match response {
                Ok(NotificationResponse::Click) => activate(&app, &notice, false),
                Ok(NotificationResponse::ActionButton(_)) => activate(&app, &notice, true),
                _ => {}
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
pub fn show(app: tauri::AppHandle, notice: Value) -> Result<(), String> {
    use tauri_winrt_notification::Toast;
    let identifier = if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID
    } else {
        &app.config().identifier
    };
    let callback_notice = notice.clone();
    Toast::new(identifier)
        .title(notice["title"].as_str().unwrap_or("Arca"))
        .text1(notice["body"].as_str().unwrap_or(""))
        .add_button(notice["actionLabel"].as_str().unwrap_or("Review"), "open")
        .on_activated(move |action| {
            activate(&app, &callback_notice, action.as_deref() == Some("open"));
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn show(app: tauri::AppHandle, notice: Value) -> Result<(), String> {
    let body = notice["body"]
        .as_str()
        .unwrap_or("")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let handle = notify_rust::Notification::new()
        .appname("Arca")
        .icon("arca")
        .summary(notice["title"].as_str().unwrap_or("Arca"))
        .body(&body)
        .action("default", "")
        .action("open", notice["actionLabel"].as_str().unwrap_or("Review"))
        .show()
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action == "default" || action == "open" {
                activate(&app, &notice, action == "open");
            }
        })
    });
    Ok(())
}
