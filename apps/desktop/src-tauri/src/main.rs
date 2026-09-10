#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod notifications;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, Emitter,
};

fn home() -> PathBuf {
    std::env::var_os("ARCA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .unwrap_or_default(),
            )
            .join(".arca")
        })
}
fn config() -> Result<Value, String> {
    serde_json::from_slice(&fs::read(home().join("config.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn runtime(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let base = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("runtime")
    };
    Ok((
        base.join(if cfg!(windows) { "node.exe" } else { "node" }),
        base.join("packages/cli/arca.js"),
    ))
}
async fn request(route: &str, method: &str, body: Option<Value>) -> Result<Value, String> {
    if !route.starts_with("/v1/") || route.contains('#') {
        return Err("Invalid API route".into());
    }
    let c = config()?;
    let port = c["port"].as_u64().ok_or("Invalid daemon port")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .request(
            if method == "POST" {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            format!("http://127.0.0.1:{port}{route}"),
        )
        .bearer_auth(c["adminToken"].as_str().ok_or("Missing local credential")?);
    if let Some(data) = body {
        req = req.json(&data);
    }
    let response = req
        .send()
        .await
        .map_err(|_| "The daemon is unavailable. Use Start service.".to_string())?;
    let status = response.status();
    let result: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(result["error"].as_str().unwrap_or("API error").to_string());
    }
    Ok(result)
}
#[tauri::command]
async fn api(app: tauri::AppHandle, route: String, method: Option<String>, body: Option<Value>) -> Result<Value, String> {
    let result = request(&route, method.as_deref().unwrap_or("GET"), body).await?;
    if route == "/v1/status" || route == "/v1/pause" {
        update_tray_icon(&app, &result)?;
    }
    Ok(result)
}
#[tauri::command]
async fn bootstrap() -> Result<Value, String> {
    if !home().join("config.json").exists() {
        let root = home().parent().unwrap_or(&home()).join("arca");
        let name = Command::new("hostname").output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        return Ok(json!({"setup":true,"root":root.to_string_lossy(),"name":name,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH}));
    }
    match request("/v1/status", "GET", None).await {
        Ok(status) => Ok(json!({"setup":false,"status":status})),
        Err(_) => Ok(json!({"setup":false,"stopped":true})),
    }
}
#[tauri::command]
async fn start_daemon(app: tauri::AppHandle) -> Result<(), String> {
    if request("/v1/status", "GET", None).await.is_ok() {
        return Ok(());
    }
    let (node, cli) = runtime(&app)?;
    fs::create_dir_all(home()).map_err(|e| e.to_string())?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home().join("daemon.log"))
        .map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.arg(cli)
        .arg("daemon")
        .arg("--home")
        .arg(home())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn initialize(
    app: tauri::AppHandle,
    name: String,
    role: String,
    root: String,
) -> Result<(), String> {
    if home().join("config.json").exists() {
        if config()?["needsSetup"].as_bool() == Some(true) {
            request("/v1/setup", "POST", Some(json!({"name":name,"role":role,"root":root,"onboarding":true}))).await?;
            return Ok(());
        }
        return Err("Arca is already configured".into());
    }
    if !["hub", "replica", "backup"].contains(&role.as_str()) {
        return Err("Invalid role".into());
    }
    let (node, cli) = runtime(&app)?;
    let output = Command::new(node)
        .arg(cli)
        .args([
            "init", "--name", &name, "--role", &role, "--root", &root, "--onboarding", "true", "--home",
        ])
        .arg(home())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    start_daemon(app).await
}
#[tauri::command]
async fn setup_info(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    let (node, cli) = runtime(&app)?;
    let output = Command::new(node).arg(cli).args(["setup-info", "--root", &root, "--home"]).arg(home()).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}
#[tauri::command]
async fn open_folder(id: String) -> Result<(), String> {
    let status = request("/v1/status", "GET", None).await?;
    let folder = status["volumes"]
        .as_array()
        .and_then(|vs| vs.iter().find(|v| v["id"].as_str() == Some(&id)))
        .and_then(|v| v["path"].as_str())
        .ok_or("Unknown folder")?;
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    command.arg(folder).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_file(volume: String, path: String, reveal: Option<bool>) -> Result<(), String> {
    let status=request("/v1/status","GET",None).await?;
    let root=status["volumes"].as_array().and_then(|vs|vs.iter().find(|v|v["id"].as_str()==Some(&volume))).and_then(|v|v["path"].as_str()).ok_or("Unknown local folder")?;
    let root=fs::canonicalize(root).map_err(|e|e.to_string())?;
    let file=fs::canonicalize(root.join(path)).map_err(|e|e.to_string())?;
    if !file.starts_with(&root)||!file.is_file(){return Err("File is outside the selected folder".into());}
    #[cfg(target_os="macos")] let mut command=Command::new("open");
    #[cfg(target_os="windows")] let mut command=Command::new("explorer");
    #[cfg(target_os="linux")] let mut command=Command::new("xdg-open");
    if reveal.unwrap_or(false) {
        #[cfg(target_os="macos")] command.arg("-R");
        #[cfg(not(target_os="macos"))] return Err("Reveal in Finder is only available on macOS".into());
    }
    command.arg(file).spawn().map_err(|e|e.to_string())?;Ok(())
}
fn preferences() -> Value {
    fs::read(home().join("desktop.json")).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or(json!({}))
}
fn save_preferences(value: &Value) -> Result<(), String> {
    fs::create_dir_all(home()).map_err(|e| e.to_string())?;
    fs::write(home().join("desktop.json"), serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn launch_agent() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/LaunchAgents/com.soyjavi.arca.daemon.plist")
}
#[tauri::command]
fn desktop_preferences() -> Value {
    let p = preferences();
    json!({"launchAtLogin":p["launchAtLogin"].as_bool().unwrap_or_else(||launch_agent().exists()),"notifications":p["notifications"].as_bool().unwrap_or(false)})
}
#[tauri::command]
async fn choose_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().set_title("Choose an Arca folder").pick_folder().map(|p|p.to_string_lossy().to_string())).await.map_err(|e|e.to_string())
}
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new().map_err(|e|e.to_string())?.set_text(text).map_err(|e|e.to_string())
}
#[tauri::command]
fn set_notifications(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    if enabled {
        let permission = app.notification().request_permission().map_err(|e|e.to_string())?;
        if permission != tauri_plugin_notification::PermissionState::Granted { return Err("Notification permission was not granted".into()); }
    }
    let mut p=preferences();p["notifications"]=json!(enabled);save_preferences(&p)
}
#[tauri::command]
fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if !cfg!(target_os="macos") { return Err("Launch at login is currently supported on macOS".into()); }
    let uid=Command::new("id").arg("-u").output().map_err(|e|e.to_string())?;
    let uid=String::from_utf8_lossy(&uid.stdout).trim().to_string();
    if enabled {
        let (node,cli)=runtime(&app)?;
        let xml=|value:&str|value.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('\"',"&quot;");
        let args=[node.to_string_lossy().to_string(),cli.to_string_lossy().to_string(),"daemon".into(),"--home".into(),home().to_string_lossy().to_string()];
        let content=format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>com.soyjavi.arca.daemon</string><key>ProgramArguments</key><array>{}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",args.iter().map(|a|format!("<string>{}</string>",xml(a))).collect::<String>(),xml(&home().join("service.log").to_string_lossy()),xml(&home().join("service.log").to_string_lossy()));
        let destination=launch_agent();fs::create_dir_all(destination.parent().unwrap()).map_err(|e|e.to_string())?;
        fs::write(destination,content).map_err(|e|e.to_string())?;
    }
    let result=Command::new("launchctl").args([if enabled {"enable"} else {"disable"}, &format!("gui/{uid}/com.soyjavi.arca.daemon")]).output().map_err(|e|e.to_string())?;
    if !result.status.success(){return Err(String::from_utf8_lossy(&result.stderr).to_string());}
    let mut p=preferences();p["launchAtLogin"]=json!(enabled);save_preferences(&p)
}
#[tauri::command]
fn show_main(app: tauri::AppHandle, folder: Option<String>) {
    if let Some(w)=app.get_webview_window("main") { let _=w.show();let _=w.set_focus(); if let Some(folder)=folder {let _=w.emit("open-folder-detail",folder);} }
    if let Some(w)=app.get_webview_window("tray") {let _=w.hide();}
}
#[tauri::command]
fn resize_tray(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() { return Err("Invalid tray height".into()); }
    if let Some(w) = app.get_webview_window("tray") {
        w.set_size(tauri::LogicalSize::new(320.0, height.clamp(100.0, 600.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {app.exit(0);}
fn tray_state(status: &serde_json::Value) -> &str {
    if status["phase"] != "paused" && (
        status["phase"] == "error" || status["error"].as_str().is_some()
        || status["backup"]["error"].as_str().is_some()
        || status["volumes"].as_array().map(|v| v.iter().any(|f|
            f["conflicts"].as_u64().unwrap_or(0) > 0 || f["sync"]["error"].as_str().is_some()
        )).unwrap_or(false)
    ) { return "alert"; }
    match status["phase"].as_str().unwrap_or("") {
        "paused" => "paused",
        "syncing" => "syncing",
        "idle" if status["lastSync"].as_str().is_some()
            && status["error"].is_null()
            && status["backup"]["error"].is_null()
            && status["volumes"].as_array().map(|volumes| {
                !volumes.is_empty() && volumes.iter().all(|v| {
                    v["conflicts"].as_u64().unwrap_or(0) == 0
                        && v["sync"]["error"].is_null()
                        && (!v["selected"].as_bool().unwrap_or(false)
                            || v["sync"]["state"] == "synced")
                })
            }).unwrap_or(false) => "synced",
        _ => "default",
    }
}

fn update_tray_icon(app: &tauri::AppHandle, status: &Value) -> Result<(), String> {
    let image = match tray_state(status) {
        "syncing" => include_bytes!("../icons/tray-syncing.png").as_slice(),
        "alert" => include_bytes!("../icons/tray-alert.png").as_slice(),
        "synced" => include_bytes!("../icons/tray-synced.png").as_slice(),
        "paused" => include_bytes!("../icons/tray-paused.png").as_slice(),
        _ => include_bytes!("../icons/tray.png").as_slice(),
    };
    let icon = tauri::image::Image::from_bytes(image).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("arca") {
        tray.set_icon_with_as_template(Some(icon), true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            api,
            bootstrap,
            setup_info,
            initialize,
            start_daemon,
            open_folder,
            open_file,
            desktop_preferences,
            set_launch_at_login,
            choose_folder,
            copy_text,
            set_notifications,
            show_main,
            quit_app,
            resize_tray
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app,"tray",tauri::WebviewUrl::App("tray.html".into()))
                .title("Arca status").inner_size(320.0,300.0).transparent(true).decorations(false).resizable(false).visible(false).focused(false).always_on_top(true).skip_taskbar(true).build()?;
            let open = MenuItem::with_id(app, "open", "Open Arca", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Quit app (sync continues)", true, None::<&str>)?;
            let status_item =
                MenuItem::with_id(app, "status", "Arca · connecting…", false, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause sync", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status_item, &open, &sync, &pause, &quit])?;
            TrayIconBuilder::with_id("arca")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .show_menu_on_left_click(false)
                .tooltip("Arca · your files, on your machines")
                .menu(&menu)
                .on_tray_icon_event(|tray,event| {
                    if let tauri::tray::TrayIconEvent::Click {button:tauri::tray::MouseButton::Left,button_state:tauri::tray::MouseButtonState::Up,position,..}=event {
                        if let Some(w)=tray.app_handle().get_webview_window("tray") {
                            if w.is_visible().unwrap_or(false) {let _=w.hide();}
                            else {let scale=w.scale_factor().unwrap_or(1.0);let _=w.set_position(tauri::PhysicalPosition::new((position.x-160.0*scale).max(0.0) as i32,(position.y+14.0*scale) as i32));let _=w.show();let _=w.set_focus();}
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "sync" => {
                        tauri::async_runtime::spawn(async {
                            let _ = request("/v1/sync", "POST", Some(json!({}))).await;
                        });
                    }
                    "pause" => {
                        tauri::async_runtime::spawn(async {
                            if let Ok(status) = request("/v1/status", "GET", None).await {
                                let _ = request(
                                    "/v1/pause",
                                    "POST",
                                    Some(json!({"paused": status["phase"] != "paused"})),
                                )
                                .await;
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut notice_state: std::collections::HashMap<String, (std::time::Instant, String)> = std::collections::HashMap::new();
                loop {
                    let _ = request("/v1/client", "POST", Some(json!({"kind":"desktop"}))).await;
                    let status = request("/v1/status", "GET", None).await;
                    let text = match &status {
                        Ok(s) => match s["phase"].as_str().unwrap_or("") {
                            "idle" if tray_state(s) == "synced" => "Arca · up to date",
                            "idle" => "Arca · not yet verified",
                            "unlinked" => "Arca · no hub",
                            "needs-folder" => "Arca · choose a shared folder",
                            "syncing" => "Arca · syncing",
                            "paused" => "Arca · paused",
                            _ => "Arca · needs attention",
                        },
                        Err(_) => "Arca · service stopped",
                    };
                    if let Ok(s) = &status {
                        let notices = s["notices"].as_array().cloned().unwrap_or_default();
                        notice_state.retain(|id, _| notices.iter().any(|n| n["id"].as_str() == Some(id.as_str())));
                        let focused = ["main", "tray"].iter().any(|label| handle.get_webview_window(label).map(|w| w.is_focused().unwrap_or(false)).unwrap_or(false));
                        for notice in notices {
                            let id = notice["id"].as_str().unwrap_or("").to_string();
                            let state = notice_state.entry(id).or_insert((std::time::Instant::now(), String::new()));
                            let signature = notice["incident"].to_string();
                            let delayed = notice["offline"].as_bool().unwrap_or(false) && state.0.elapsed().as_secs() < 60;
                            if !focused && !delayed && state.1 != signature && preferences()["notifications"].as_bool().unwrap_or(false) {
                                if notifications::show(handle.clone(), notice.clone()).is_ok() { state.1 = signature; }
                            }
                        }
                    }
                    let _ = status_item.set_text(text);
                    let paused = status
                        .as_ref()
                        .map(|s| s["phase"] == "paused")
                        .unwrap_or(false);
                    let _ = pause.set_text(if paused { "Resume sync" } else { "Pause sync" });
                    if let Some(tray) = handle.tray_by_id("arca") {
                        let _ = tray.set_tooltip(Some(text));
                        let current = status.as_ref().cloned().unwrap_or(json!({"phase":"error"}));
                        if let Err(error) = update_tray_icon(&handle, &current) {
                            eprintln!("Unable to update tray icon: {error}");
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label()=="tray" && matches!(event,tauri::WindowEvent::Focused(false)) {let _=window.hide();}
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to launch Arca");
}

#[cfg(test)]
mod tray_tests {
    use super::*;
    #[test]
    fn all_tray_assets_decode() {
        for bytes in [include_bytes!("../icons/tray-syncing.png").as_slice(), include_bytes!("../icons/tray-alert.png").as_slice(), include_bytes!("../icons/tray.png").as_slice(), include_bytes!("../icons/tray-paused.png").as_slice(), include_bytes!("../icons/tray-synced.png").as_slice()] {
            let icon = tauri::image::Image::from_bytes(bytes).unwrap();
            assert_eq!((icon.width(), icon.height()), (48, 36));
        }
    }
    #[test]
    fn check_requires_completed_sync_without_pending_folders_or_conflicts() {
        let mut s = json!({"phase":"idle", "lastSync":"2026-09-07", "volumes":[{"selected":true,"conflicts":0,"sync":{"state":"synced"}}]});
        assert_eq!(tray_state(&s), "synced");
        s["volumes"][0]["sync"]["state"] = json!("pending");
        assert_eq!(tray_state(&s), "default");
        s["phase"] = json!("paused");
        assert_eq!(tray_state(&s), "paused");
        s["phase"] = json!("syncing");
        assert_eq!(tray_state(&s), "syncing");
        s["phase"] = json!("idle");
        s["volumes"][0]["sync"]["state"] = json!("synced");
        s["volumes"][0]["conflicts"] = json!(1);
        assert_eq!(tray_state(&s), "alert");
        s["volumes"][0]["conflicts"] = json!(0);
        s["lastSync"] = json!(null);
        assert_eq!(tray_state(&s), "default");
    }
}
