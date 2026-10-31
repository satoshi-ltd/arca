#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod notifications;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
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
async fn bootstrap(app: tauri::AppHandle) -> Result<Value, String> {
    sweep_update_watchers();
    let resumed = resume_daemon(&app).await.err();
    if !home().join("config.json").exists() {
        let root = home().parent().unwrap_or(&home()).join("arca");
        let name = Command::new("hostname").output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        return Ok(json!({"setup":true,"root":root.to_string_lossy(),"name":name,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH}));
    }
    match request("/v1/status", "GET", None).await {
        Ok(status) => Ok(json!({"setup":false,"status":status})),
        Err(_) => Ok(json!({"setup":false,"stopped":true,"error":resumed})),
    }
}
fn spawn_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let (node, cli) = runtime(app)?;
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
async fn start_daemon(app: tauri::AppHandle) -> Result<(), String> {
    if request("/v1/status", "GET", None).await.is_ok() {
        return Ok(());
    }
    spawn_daemon(&app)
}
const RESTART_MARKER: &str = "restart-daemon";
const LAUNCH_AGENT: &str = "com.soyjavi.arca.daemon";
fn launchd_domain() -> Result<String, String> {
    let uid = Command::new("id").arg("-u").output().map_err(|e| e.to_string())?;
    Ok(format!("gui/{}", String::from_utf8_lossy(&uid.stdout).trim()))
}
fn launchctl(args: &[&str]) -> Result<bool, String> {
    Ok(Command::new("launchctl").args(args).output().map_err(|e| e.to_string())?.status.success())
}
fn launch_agent_loaded() -> Result<bool, String> {
    Ok(cfg!(target_os = "macos") && launchctl(&["print", &format!("{}/{LAUNCH_AGENT}", launchd_domain()?)])?)
}
fn daemon_command(command: &str, home: &str) -> bool {
    command.contains("arca.js")
        && command.split_whitespace().any(|part| part == "daemon")
        && [format!("--home {home}"), format!("--home \"{home}\"")]
            .iter()
            .any(|tail| command.ends_with(tail.as_str()))
}
fn listed_command(listing: std::process::Output) -> Result<Option<String>, String> {
    let command = String::from_utf8_lossy(&listing.stdout).trim().to_string();
    let absent = listing.status.success() || (cfg!(unix) && listing.status.code() == Some(1));
    if command.is_empty() && listing.stderr.is_empty() && absent {
        return Ok(None);
    }
    if !listing.status.success() || command.is_empty() {
        return Err(format!(
            "Could not inspect the local daemon before updating. {}",
            String::from_utf8_lossy(&listing.stderr).trim()
        ));
    }
    Ok(Some(command))
}
fn running_daemon(home: &Path) -> Result<Option<u32>, String> {
    let lock = match fs::read_to_string(home.join("daemon.lock")) {
        Ok(lock) => lock,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let pid = lock
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 1)
        .ok_or("Invalid daemon lock; refusing to stop an unknown process.")?;
    let listing = if cfg!(windows) {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                &format!("$ProgressPreference = 'SilentlyContinue'; (Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"),
            ])
            .output()
    } else {
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
    }
    .map_err(|e| e.to_string())?;
    Ok(listed_command(listing)?
        .filter(|command| daemon_command(command, &home.to_string_lossy()))
        .map(|_| pid))
}
async fn stop_daemon(home: &Path, service: bool) -> Result<(), String> {
    if service && !launchctl(&["bootout", &format!("{}/{LAUNCH_AGENT}", launchd_domain()?)])? {
        return Err("Could not stop the login service before updating.".into());
    }
    if let Some(pid) = running_daemon(home)? {
        let pid = pid.to_string();
        let signalled = if cfg!(windows) {
            Command::new("taskkill").args(["/PID", &pid, "/T", "/F"]).status()
        } else {
            Command::new("kill").args(["-TERM", &pid]).status()
        }
        .map_err(|e| e.to_string())?;
        if !signalled.success() && running_daemon(home)?.is_some() {
            return Err("Could not stop the local daemon before updating.".into());
        }
    }
    for _ in 0..300 {
        if running_daemon(home)?.is_none() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("The local daemon is still finishing its work. Try the update again shortly.".into())
}
async fn daemon_answers() -> bool {
    for _ in 0..100 {
        if request("/v1/status", "GET", None).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}
async fn resume_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let marker = home().join(RESTART_MARKER);
    let mode = match fs::read_to_string(&marker) {
        Ok(mode) => mode,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if request("/v1/status", "GET", None).await.is_err() {
        if mode == "service" {
            if !launchctl(&["bootstrap", &launchd_domain()?, &launch_agent().to_string_lossy()])? {
                return Err("Could not restart the login service after the update.".into());
            }
        } else {
            spawn_daemon(app)?;
        }
        if !daemon_answers().await {
            return Err("The local daemon did not start after the update. The app retries on the next launch.".into());
        }
    }
    let _ = fs::remove_file(&marker);
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
        return Err("This device is already configured".into());
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
async fn open_maps(latitude: f64, longitude: f64) -> Result<(), String> {
    if !latitude.is_finite() || !longitude.is_finite() || latitude.abs() > 90.0 || longitude.abs() > 180.0 {
        return Err("Invalid coordinates".into());
    }
    let url = format!("https://maps.google.com/?q={},{}", latitude, longitude);
    #[cfg(target_os = "macos")] let mut command = Command::new("open");
    #[cfg(target_os = "linux")] let mut command = Command::new("xdg-open");
    #[cfg(target_os = "windows")] let mut command = { let mut c = Command::new("rundll32"); c.arg("url.dll,FileProtocolHandler"); c };
    command.arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_file(volume: String, path: String, reveal: Option<bool>) -> Result<(), String> {
    let status=request("/v1/status","GET",None).await?;
    let root=status["volumes"].as_array().and_then(|vs|vs.iter().find(|v|v["id"].as_str()==Some(&volume))).and_then(|v|v["path"].as_str()).ok_or("Unknown local folder")?;
    let root=fs::canonicalize(root).map_err(|e|e.to_string())?;
    let file=fs::canonicalize(root.join(path)).map_err(|e|e.to_string())?;
    if !file.starts_with(&root)||!file.is_file(){return Err("File is outside the selected folder".into());}
    let reveal=reveal.unwrap_or(false);
    #[cfg(target_os="macos")] let mut command={let mut c=Command::new("open");if reveal{c.arg("-R");}c.arg(&file);c};
    #[cfg(target_os="windows")] let mut command={
        use std::os::windows::process::CommandExt;
        let mut c=Command::new("explorer");
        if reveal{c.raw_arg(select_argument(&file.to_string_lossy()));}else{c.arg(strip_verbatim(&file.to_string_lossy()));}
        c
    };
    #[cfg(target_os="linux")] let mut command={let mut c=Command::new("xdg-open");c.arg(reveal_target(&file,reveal));c};
    command.spawn().map_err(|e|e.to_string())?;Ok(())
}
#[cfg_attr(not(windows),allow(dead_code))]
fn strip_verbatim(path:&str)->String{
    if let Some(rest)=path.strip_prefix(r"\\?\UNC\"){format!(r"\\{}",rest)}
    else if let Some(rest)=path.strip_prefix(r"\\?\"){rest.to_string()}
    else{path.to_string()}
}
#[cfg_attr(not(windows),allow(dead_code))]
fn select_argument(path:&str)->String{format!("/select,\"{}\"",strip_verbatim(path))}
#[cfg_attr(not(target_os="linux"),allow(dead_code))]
fn reveal_target(file:&Path,reveal:bool)->PathBuf{
    if reveal{file.parent().unwrap_or(file).to_path_buf()}else{file.to_path_buf()}
}
#[tauri::command]
async fn save_file(volume: String, path: String) -> Result<bool, String> {
    let status = request("/v1/status", "GET", None).await?;
    let root = status["volumes"].as_array()
        .and_then(|vs| vs.iter().find(|v| v["id"].as_str() == Some(&volume)))
        .and_then(|v| v["path"].as_str()).ok_or("Select this folder before downloading")?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let source = fs::canonicalize(root.join(path)).map_err(|e| e.to_string())?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("File is outside the selected folder".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let name = source.file_name().ok_or("Invalid file name")?.to_string_lossy();
        let destination = rfd::FileDialog::new().set_title("Download photo").set_file_name(name.as_ref()).save_file();
        let Some(destination) = destination else { return Ok(false); };
        if fs::canonicalize(&destination).ok().as_ref() == Some(&source) {
            return Err("Choose a different destination from the original file".into());
        }
        fs::copy(&source, destination).map_err(|e| e.to_string())?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}
fn preferences() -> Value {
    fs::read(home().join("desktop.json")).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or(json!({}))
}
fn save_preferences(value: &Value) -> Result<(), String> {
    fs::create_dir_all(home()).map_err(|e| e.to_string())?;
    fs::write(home().join("desktop.json"), serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn launch_agent() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(format!("Library/LaunchAgents/{LAUNCH_AGENT}.plist"))
}
#[tauri::command]
fn desktop_preferences() -> Value {
    let p = preferences();
    json!({"launchAtLogin":p["launchAtLogin"].as_bool().unwrap_or_else(||launch_agent().exists()),"notifications":p["notifications"].as_bool().unwrap_or(false)})
}
#[tauri::command]
async fn choose_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().set_title("Choose a folder").pick_folder().map(|p|p.to_string_lossy().to_string())).await.map_err(|e|e.to_string())
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
    if enabled {
        let (node,cli)=runtime(&app)?;
        let xml=|value:&str|value.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('\"',"&quot;");
        let args=[node.to_string_lossy().to_string(),cli.to_string_lossy().to_string(),"daemon".into(),"--home".into(),home().to_string_lossy().to_string()];
        let content=format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>{LAUNCH_AGENT}</string><key>ProgramArguments</key><array>{}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",args.iter().map(|a|format!("<string>{}</string>",xml(a))).collect::<String>(),xml(&home().join("service.log").to_string_lossy()),xml(&home().join("service.log").to_string_lossy()));
        let destination=launch_agent();fs::create_dir_all(destination.parent().unwrap()).map_err(|e|e.to_string())?;
        fs::write(destination,content).map_err(|e|e.to_string())?;
    }
    let result=Command::new("launchctl").args([if enabled {"enable"} else {"disable"}, &format!("{}/{LAUNCH_AGENT}", launchd_domain()?)]).output().map_err(|e|e.to_string())?;
    if !result.status.success(){return Err(String::from_utf8_lossy(&result.stderr).to_string());}
    let mut p=preferences();p["launchAtLogin"]=json!(enabled);save_preferences(&p)
}
#[tauri::command]
fn show_main(app: tauri::AppHandle, folder: Option<String>) {
    if let Some(w)=app.get_webview_window("main") { let _=w.show();let _=w.set_focus(); if let Some(folder)=folder {let _=w.emit("open-folder-detail",folder);} }
    if let Some(w)=app.get_webview_window("tray") {let _=w.hide();}
}
#[tauri::command]
fn hide_tray(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("tray") {
        let _ = w.hide();
    }
}
#[cfg(target_os = "macos")]
fn hide_tray_on_outside_click(app: &tauri::AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask};
    let app = app.clone();
    let handler = block2::RcBlock::new(move |_: std::ptr::NonNull<NSEvent>| hide_tray(app.clone()));
    let clicks = NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown;
    std::mem::forget(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(clicks, &handler));
}
static TRAY_ANCHOR: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);
#[derive(Clone, Copy, Debug, PartialEq)]
struct ScreenRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
fn tray_popover_origin(click: (f64, f64), popover: (f64, f64), work: ScreenRect, scale: f64) -> (f64, f64) {
    let fit = |value: f64, start: f64, length: f64, size: f64| value.min(start + length - size).max(start);
    let (width, height) = (popover.0.ceil(), popover.1.ceil());
    let gap = 14.0 * scale;
    let y = if click.1 > work.y + work.height / 2.0 { click.1 - gap - height } else { click.1 + gap };
    (fit(click.0 - width / 2.0, work.x, work.width, width).round(), fit(y, work.y, work.height, height).round())
}
fn scaled(rect: ScreenRect, factor: f64) -> ScreenRect {
    ScreenRect { x: rect.x * factor, y: rect.y * factor, width: rect.width * factor, height: rect.height * factor }
}
fn monitor_under(point: (f64, f64), bounds: &[ScreenRect]) -> Option<usize> {
    bounds.iter().position(|r| point.0 >= r.x && point.0 < r.x + r.width && point.1 >= r.y && point.1 < r.y + r.height)
}
fn tray_point(w: &tauri::WebviewWindow, click: (f64, f64)) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    let point = {
        let primary = w.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
        let cursor = w.cursor_position().map(|p| (p.x, p.y)).unwrap_or(click);
        (cursor.0 / primary, cursor.1 / primary)
    };
    #[cfg(not(target_os = "macos"))]
    let point = {
        let _ = w;
        click
    };
    point
}
fn tray_popover_target(point: (f64, f64), space: f64, scale: f64, work: ScreenRect, popover: (f64, f64)) -> (f64, f64) {
    let origin = tray_popover_origin((point.0 / space, point.1 / space), (popover.0 * scale, popover.1 * scale), work, scale);
    (origin.0 * space, origin.1 * space)
}
fn place_tray(w: &tauri::WebviewWindow, point: (f64, f64), size: tauri::LogicalSize<f64>) -> Result<(), String> {
    let space = |m: &tauri::Monitor| if cfg!(target_os = "macos") { 1.0 / m.scale_factor() } else { 1.0 };
    let monitors = w.available_monitors().map_err(|e| e.to_string())?;
    let bounds: Vec<ScreenRect> = monitors.iter().map(|m| scaled(ScreenRect { x: m.position().x as f64, y: m.position().y as f64, width: m.size().width as f64, height: m.size().height as f64 }, space(m))).collect();
    let monitor = match monitor_under(point, &bounds).and_then(|i| monitors.into_iter().nth(i)) {
        Some(m) => m,
        None => w.primary_monitor().map_err(|e| e.to_string())?.ok_or("No monitor for the tray popover")?,
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let work = ScreenRect { x: area.position.x as f64, y: area.position.y as f64, width: area.size.width as f64, height: area.size.height as f64 };
    let (x, y) = tray_popover_target(point, space(&monitor), scale, work, (size.width, size.height));
    #[cfg(target_os = "macos")]
    let position = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    #[cfg(not(target_os = "macos"))]
    let position = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
    w.set_position(position).map_err(|e| e.to_string())
}
fn show_tray_at(w: &tauri::WebviewWindow, click: (f64, f64)) {
    let factor = w.scale_factor().unwrap_or(1.0);
    let size = w.outer_size().map(|s| tauri::LogicalSize::new(s.width as f64 / factor, s.height as f64 / factor)).unwrap_or(tauri::LogicalSize::new(320.0, 300.0));
    let point = tray_point(w, click);
    if let Ok(mut anchor) = TRAY_ANCHOR.lock() { *anchor = Some(point); }
    if let Err(error) = place_tray(w, point, size) { eprintln!("Unable to place the tray popover: {error}"); }
    let _ = w.show();
    let _ = place_tray(w, point, size);
    let _ = w.set_focus();
}
#[tauri::command]
fn resize_tray(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() { return Err("Invalid tray height".into()); }
    if let Some(w) = app.get_webview_window("tray") {
        let size = tauri::LogicalSize::new(320.0, height.clamp(100.0, 600.0));
        let anchor = TRAY_ANCHOR.lock().ok().and_then(|a| *a).filter(|_| w.is_visible().unwrap_or(false));
        let place = |point: (f64, f64)| if let Err(error) = place_tray(&w, point, size) { eprintln!("Unable to place the tray popover: {error}"); };
        if cfg!(target_os = "macos") {
            w.set_size(size).map_err(|e| e.to_string())?;
            if let Some(point) = anchor { place(point); }
        } else {
            if let Some(point) = anchor { place(point); }
            w.set_size(size).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {app.exit(0);}
fn hub_offline(status: &serde_json::Value) -> bool {
    status["phase"] == "offline" || (status["phase"] == "checking" && status["hubUnavailable"] == true)
}
fn tray_state(status: &serde_json::Value) -> &str {
    let offline = hub_offline(status);
    if status["phase"] != "paused" && (
        status["phase"] == "error" || (!offline && status["error"].as_str().is_some())
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

fn tray_text(status: &serde_json::Value) -> &'static str {
    match status["phase"].as_str().unwrap_or("") {
        "idle" if tray_state(status) == "synced" => "Arca · up to date",
        "idle" => "Arca · not yet verified",
        "unlinked" => "Arca · no hub",
        "needs-folder" => "Arca · choose a shared folder",
        "offline" | "checking" if hub_offline(status) && tray_state(status) == "alert" => "Arca · needs attention",
        "offline" | "checking" if hub_offline(status) => "Arca · offline",
        "checking" => "Arca · checking",
        "syncing" => "Arca · syncing",
        "paused" => "Arca · paused",
        _ => "Arca · needs attention",
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

#[derive(serde::Serialize)]
struct UpdateStatus {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(match update {
        Some(update) => UpdateStatus {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        },
        None => UpdateStatus {
            available: false,
            version: None,
            notes: None,
        },
    })
}

struct UpdateWatcher {
    child: std::process::Child,
    dir: PathBuf,
}
impl UpdateWatcher {
    fn cancel(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn sweep_update_watchers() {
    if !cfg!(windows) {
        return;
    }
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with("arca-update-watch-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}
fn start_update_watcher(app: &tauri::AppHandle) -> Result<UpdateWatcher, String> {
    let (node, cli) = runtime(app)?;
    let dir = std::env::temp_dir().join(format!("arca-update-watch-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let node_copy = dir.join(node.file_name().ok_or("Invalid runtime")?);
    let script = dir.join("watch.mjs");
    fs::copy(&node, &node_copy).map_err(|e| e.to_string())?;
    fs::copy(cli.with_file_name("update-watch.js"), &script).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let options = json!({
        "appPid": std::process::id(),
        "home": home().to_string_lossy(),
        "node": node.to_string_lossy(),
        "cli": cli.to_string_lossy(),
        "appExe": exe.file_name().map(|name| name.to_string_lossy().to_string()),
        "installerNames": [format!("{}*installer*", app.package_info().name)],
        "cleanupDir": dir.to_string_lossy(),
    });
    let mut cmd = Command::new(&node_copy);
    cmd.arg(&script)
        .arg(options.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000200);
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    Ok(UpdateWatcher { child, dir })
}
async fn with_recovery(app: &tauri::AppHandle, error: String) -> String {
    match resume_daemon(app).await {
        Ok(()) => error,
        Err(restart) => format!("{error} {restart}"),
    }
}
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This version is already current.".to_string())?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let state = home();
    let service = launch_agent_loaded()?;
    let running = running_daemon(&state)?.is_some();
    if !service && !running && request("/v1/status", "GET", None).await.is_ok() {
        return Err("A daemon this app did not start is serving this device. Stop it before updating.".into());
    }
    // The daemon executes the runtime inside the installation being replaced.
    if service || running {
        fs::write(state.join(RESTART_MARKER), if service { "service" } else { "process" })
            .map_err(|e| e.to_string())?;
        if let Err(error) = stop_daemon(&state, service).await {
            return Err(with_recovery(&app, error).await);
        }
    }
    let watcher = if cfg!(windows) && (service || running) {
        start_update_watcher(&app).ok()
    } else {
        None
    };
    if let Err(error) = update.install(bytes) {
        if let Some(watcher) = watcher {
            watcher.cancel();
        }
        return Err(with_recovery(&app, error.to_string()).await);
    }
    app.restart();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            api,
            bootstrap,
            setup_info,
            initialize,
            start_daemon,
            open_folder,
            open_file,
            open_maps,
            save_file,
            desktop_preferences,
            set_launch_at_login,
            choose_folder,
            copy_text,
            set_notifications,
            show_main,
            quit_app,
            resize_tray,
            hide_tray,
            check_update,
            install_update
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app,"tray",tauri::WebviewUrl::App("tray.html".into()))
                .title("Arca status").inner_size(320.0,300.0).transparent(true).decorations(false).resizable(false).visible(false).focused(false).always_on_top(true).skip_taskbar(true).build()?;
            let open = MenuItem::with_id(app, "open", "Open Arca", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Quit Arca (sync continues)", true, None::<&str>)?;
            let status_item =
                MenuItem::with_id(app, "status", "Arca · connecting…", false, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause sync", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status_item, &open, &sync, &pause, &quit])?;
            TrayIconBuilder::with_id("arca")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .show_menu_on_left_click(false)
                .tooltip("Arca · your files, on your devices")
                .menu(&menu)
                .on_tray_icon_event(|tray,event| {
                    if let tauri::tray::TrayIconEvent::Click {button:tauri::tray::MouseButton::Left,button_state:tauri::tray::MouseButtonState::Up,position,..}=event {
                        if let Some(w)=tray.app_handle().get_webview_window("tray") {
                            if w.is_visible().unwrap_or(false) {let _=w.hide();}
                            else {show_tray_at(&w,(position.x,position.y));}
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
                        Ok(s) => tray_text(s),
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
            #[cfg(target_os = "macos")]
            hide_tray_on_outside_click(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label()=="tray" && matches!(event,tauri::WindowEvent::Focused(false)) {let _=window.hide();}
            if window.label()=="main" && matches!(event,tauri::WindowEvent::Focused(true)) {hide_tray(window.app_handle().clone());}
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
    #[test]
    fn an_unreachable_hub_reads_offline_but_other_problems_still_raise_the_alert() {
        let mut s = json!({"phase":"offline", "error":"Hub unavailable", "lastSync":"2026-09-07", "volumes":[{"selected":true,"conflicts":0,"sync":{"state":"offline"}}]});
        assert_eq!(tray_state(&s), "default");
        assert_eq!(tray_text(&s), "Arca · offline");
        s["volumes"][0]["conflicts"] = json!(1);
        assert_eq!(tray_state(&s), "alert");
        assert_eq!(tray_text(&s), "Arca · needs attention");
        s["volumes"][0]["conflicts"] = json!(0);
        s["volumes"][0]["sync"]["error"] = json!("disk full");
        assert_eq!(tray_state(&s), "alert");
        s["volumes"][0]["sync"]["error"] = json!(null);
        s["backup"] = json!({"error":"backup stalled"});
        assert_eq!(tray_state(&s), "alert");
        let failing = json!({"phase":"error", "error":"boom"});
        assert_eq!(tray_state(&failing), "alert");
        assert_eq!(tray_text(&failing), "Arca · needs attention");
        let idle_error = json!({"phase":"idle", "error":"boom"});
        assert_eq!(tray_state(&idle_error), "alert");
    }
    #[test]
    fn a_replica_checking_its_hub_after_a_start_reads_checking() {
        let mut s = json!({"phase":"checking", "lastSync":"2026-09-07", "volumes":[{"selected":true,"conflicts":0,"sync":{"state":"idle"}}]});
        assert_eq!(tray_text(&s), "Arca · checking");
        assert_eq!(tray_state(&s), "default");
        s["hubUnavailable"] = json!(true);
        s["error"] = json!("Hub unavailable. Try again when it is reachable.");
        assert_eq!(tray_text(&s), "Arca · offline");
        assert_eq!(tray_state(&s), "default");
        s["hubUnavailable"] = json!(false);
        s["error"] = json!(null);
        assert_eq!(tray_text(&s), "Arca · checking");
        s["hubUnavailable"] = json!(true);
        s["volumes"][0]["conflicts"] = json!(1);
        assert_eq!(tray_state(&s), "alert");
        assert_eq!(tray_text(&s), "Arca · needs attention");
    }
    fn area(x: f64, y: f64, width: f64, height: f64) -> ScreenRect {
        ScreenRect { x, y, width, height }
    }
    #[test]
    fn a_bottom_taskbar_opens_the_popover_above_the_click() {
        let work = area(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(tray_popover_origin((960.0, 1060.0), (320.0, 300.0), work, 1.0), (800.0, 740.0));
        assert_eq!(tray_popover_origin((1900.0, 1065.0), (320.0, 300.0), work, 1.0), (1600.0, 740.0));
        assert_eq!(tray_popover_origin((5.0, 1075.0), (320.0, 300.0), work, 1.0), (0.0, 740.0));
    }
    #[test]
    fn a_top_menu_bar_or_taskbar_opens_the_popover_below_the_click() {
        assert_eq!(tray_popover_origin((1200.0, 12.0), (320.0, 300.0), area(0.0, 25.0, 1440.0, 875.0), 1.0), (1040.0, 26.0));
        let work = area(0.0, 40.0, 1920.0, 1040.0);
        assert_eq!(tray_popover_origin((10.0, 20.0), (320.0, 300.0), work, 1.0), (0.0, 40.0));
        assert_eq!(tray_popover_origin((1910.0, 20.0), (320.0, 300.0), work, 1.0), (1600.0, 40.0));
    }
    #[test]
    fn side_taskbars_keep_the_popover_beside_them() {
        assert_eq!(tray_popover_origin((30.0, 1050.0), (320.0, 300.0), area(60.0, 0.0, 1860.0, 1080.0), 1.0), (60.0, 736.0));
        assert_eq!(tray_popover_origin((1890.0, 1050.0), (320.0, 300.0), area(0.0, 0.0, 1860.0, 1080.0), 1.0), (1540.0, 736.0));
    }
    #[test]
    fn a_scaled_secondary_monitor_uses_its_own_work_area_and_scale() {
        assert_eq!(tray_popover_origin((4760.0, 1584.0), (480.0, 450.0), area(1920.0, 0.0, 2880.0, 1548.0), 1.5), (4320.0, 1098.0));
        assert_eq!(tray_popover_origin((-50.0, 30.0), (480.0, 451.5), area(-2880.0, 72.0, 2880.0, 1548.0), 1.5), (-480.0, 72.0));
        assert_eq!(tray_popover_origin((1500.0, 18.0), (480.0, 450.0), area(0.0, 36.0, 2160.0, 1314.0), 1.5), (1260.0, 39.0));
    }
    #[test]
    fn a_mixed_scale_mac_picks_the_monitor_under_the_click_in_points() {
        let retina = area(0.0, 0.0, 2880.0, 1800.0);
        let external = area(1440.0, 0.0, 1920.0, 1080.0);
        assert_eq!(monitor_under((2000.0, 10.0), &[retina, external]), Some(0), "physical bounds overlap across scales");
        let points = [scaled(retina, 1.0 / 2.0), scaled(external, 1.0)];
        assert_eq!(points[0], area(0.0, 0.0, 1440.0, 900.0));
        assert_eq!(monitor_under((4000.0 / 2.0, 20.0 / 2.0), &points), Some(1));
        assert_eq!(monitor_under((700.0, 10.0), &points), Some(0));
        assert_eq!(monitor_under((5000.0, 10.0), &points), None);
        let anchor = (2000.0 * 1.0, 10.0 * 1.0);
        assert_eq!(tray_popover_origin(anchor, (320.0, 300.0), area(1440.0, 25.0, 1920.0, 1055.0), 1.0), (1840.0, 25.0));
    }
    #[test]
    fn the_target_maps_points_to_monitor_pixels_and_back() {
        assert_eq!(tray_popover_target((700.0, 12.0), 1.0 / 2.0, 2.0, area(0.0, 50.0, 2880.0, 1750.0), (320.0, 300.0)), (540.0, 26.0));
        assert_eq!(tray_popover_target((2000.0, 10.0), 1.0, 1.0, area(1440.0, 25.0, 1920.0, 1055.0), (320.0, 300.0)), (1840.0, 25.0));
        assert_eq!(tray_popover_target((4760.0, 1584.0), 1.0, 1.5, area(1920.0, 0.0, 2880.0, 1548.0), (320.0, 300.0)), (4320.0, 1098.0));
    }
    #[test]
    fn the_popover_never_crosses_the_work_area() {
        for (work, scale) in [(area(0.0, 0.0, 1920.0, 1040.0), 1.0), (area(0.0, 40.0, 1920.0, 1040.0), 1.0), (area(60.0, 0.0, 1860.0, 1080.0), 1.0), (area(0.0, 0.0, 1860.0, 1080.0), 1.0), (area(-2880.0, 72.0, 2880.0, 1548.0), 1.5), (area(1920.0, 0.0, 2880.0, 1548.0), 1.5)] {
            let popover = (320.0 * scale + 0.5, 301.0 * scale);
            for i in 0..=20 {
                for j in 0..=20 {
                    let click = (work.x - 100.0 + (work.width + 200.0) * i as f64 / 20.0, work.y - 100.0 + (work.height + 200.0) * j as f64 / 20.0);
                    let (x, y) = tray_popover_origin(click, popover, work, scale);
                    assert!(x >= work.x && x + popover.0.ceil() <= work.x + work.width, "{click:?} {work:?}");
                    assert!(y >= work.y && y + popover.1.ceil() <= work.y + work.height, "{click:?} {work:?}");
                    if click.1 > work.y + work.height { assert!(y + popover.1.ceil() <= click.1); }
                    if click.1 < work.y { assert!(y >= click.1); }
                }
            }
        }
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::*;
    #[test]
    fn explorer_selects_the_file_and_never_sees_the_verbatim_prefix() {
        assert_eq!(select_argument(r"\\?\C:\Users\a b\Photos\trip.jpg"), "/select,\"C:\\Users\\a b\\Photos\\trip.jpg\"");
        assert_eq!(select_argument(r"\\?\UNC\server\share\a.txt"), "/select,\"\\\\server\\share\\a.txt\"");
        assert_eq!(select_argument(r"C:\plain\a.txt"), "/select,\"C:\\plain\\a.txt\"");
        assert_eq!(strip_verbatim(r"\\?\C:\a.txt"), r"C:\a.txt");
        assert_eq!(strip_verbatim("/home/a/b.txt"), "/home/a/b.txt");
    }
    #[test]
    fn linux_reveals_the_files_own_folder_and_opens_the_file_itself() {
        let file = Path::new("/data/shared/trips/2026/photo.jpg");
        assert_eq!(reveal_target(file, true), PathBuf::from("/data/shared/trips/2026"));
        assert_eq!(reveal_target(file, false), file.to_path_buf());
        assert_eq!(reveal_target(Path::new("/"), true), PathBuf::from("/"));
    }
}

#[cfg(test)]
mod daemon_tests {
    use super::*;
    #[test]
    fn only_a_daemon_for_this_state_directory_matches() {
        let home = "/Users/a b/.arca";
        assert!(daemon_command("/App/runtime/node /App/runtime/packages/cli/arca.js daemon --home /Users/a b/.arca", home));
        assert!(daemon_command(r#""C:\App\node.exe" "C:\App\arca.js" daemon --home "/Users/a b/.arca""#, home));
        assert!(!daemon_command("/App/node /App/arca.js daemon --home /tmp/Users/a b/.arca", home));
        assert!(!daemon_command("/App/node /App/arca.js daemon --home /Users/a b/.arca-test", home));
        assert!(!daemon_command("/App/node /App/arca.js status --home /Users/a b/.arca", home));
        assert!(!daemon_command("/App/node /App/daemon.js --home /Users/a b/.arca", home));
        assert!(!daemon_command("/bin/sleep 30", home));
    }
    #[cfg(unix)]
    #[test]
    fn a_failed_process_listing_never_counts_as_stopped() {
        use std::os::unix::process::ExitStatusExt;
        let listing = |raw: i32, stdout: &str, stderr: &str| std::process::Output {
            status: std::process::ExitStatus::from_raw(raw),
            stdout: stdout.into(),
            stderr: stderr.into(),
        };
        assert_eq!(listed_command(listing(0, "node arca.js daemon --home /h\n", "")), Ok(Some("node arca.js daemon --home /h".into())));
        assert_eq!(listed_command(listing(1 << 8, "", "")), Ok(None));
        assert!(listed_command(listing(1 << 8, "", "ps: illegal option")).is_err());
        assert!(listed_command(listing(2 << 8, "", "")).is_err());
        assert!(listed_command(listing(9, "", "")).is_err());
    }
    #[test]
    fn a_stale_or_foreign_lock_names_no_process_to_stop() {
        let home = std::env::temp_dir().join(format!("arca-lock-foreign-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        assert_eq!(running_daemon(&home), Ok(None));
        fs::write(home.join("daemon.lock"), "not a pid").unwrap();
        assert!(running_daemon(&home).is_err());
        fs::write(home.join("daemon.lock"), std::process::id().to_string()).unwrap();
        assert_eq!(running_daemon(&home), Ok(None));
        fs::remove_dir_all(&home).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn a_live_daemon_for_this_state_directory_is_found() {
        let home = std::env::temp_dir().join(format!("arca-lock-live-{}", std::process::id()));
        let other = std::env::temp_dir().join(format!("arca-lock-other-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&other).unwrap();
        let mut child = Command::new("sh")
            .args(["-c", "sleep 10; :", "arca.js", "daemon", "--home"])
            .arg(&home)
            .spawn()
            .unwrap();
        fs::write(home.join("daemon.lock"), child.id().to_string()).unwrap();
        fs::write(other.join("daemon.lock"), child.id().to_string()).unwrap();
        let found = running_daemon(&home);
        let foreign = running_daemon(&other);
        child.kill().unwrap();
        child.wait().unwrap();
        let exited = running_daemon(&home);
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&other).unwrap();
        assert_eq!(found, Ok(Some(child.id())));
        assert_eq!(foreign, Ok(None));
        assert_eq!(exited, Ok(None));
    }
}
