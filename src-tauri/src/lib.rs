use tauri::{async_runtime::spawn, tray::TrayIconBuilder, Emitter};
use tokio::time::{interval, Duration};

// Shared with the frontend (TRAY_ID in src/platform.ts), which looks the tray up
// via TrayIcon.getById to attach the menu and is the target of set_badge.
const TRAY_ID: &str = "main";

// The launch + cadence signal the frontend listens for (POLL_TICK_EVENT in
// src/platform.ts) to run a Poll Cycle.
const POLL_TICK_EVENT: &str = "poll-tick";

// Background poll cadence (ADR-0005). 30 min keeps Behind state ambiently fresh
// without spending the GitHub rate budget: one request per Watched Repo every
// 30 min stays far under the 5000 req/hr authenticated ceiling, and Skill repos
// don't move faster than a human notices. POLL_SECS overrides it to retune
// without a recompile (the spike's knob); floored at 1 — interval() panics on 0.
const DEFAULT_POLL_SECS: u64 = 30 * 60;

fn poll_interval() -> Duration {
    let secs = std::env::var("POLL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_POLL_SECS)
        .max(1);
    Duration::from_secs(secs)
}

// Writes the Behind count to the tray title — a menu-bar NSStatusItem has no
// native badge, so the count is title text beside the icon (ADR-0005). count 0
// clears the title.
#[tauri::command]
fn set_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| format!("tray \"{TRAY_ID}\" not found"))?;
    let title = (count != 0).then(|| count.to_string());
    tray.set_title(title).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![set_badge])
        .setup(|app| {
            // Dock-less menu-bar app: no Dock icon, no app menu (ADR-0005).
            // LSUIElement covers the bundled app; this covers tauri dev.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Tray lives in setup so it's present at launch, before the hidden
            // webview loads; the menu is attached later from TS via renderMenu.
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(
                    app.default_window_icon()
                        .ok_or("default window icon missing (tauri.conf.json bundle.icon)")?
                        .clone(),
                )
                .build(app)?;

            // Poll-clock (ADR-0005): emit poll-tick on the cadence so the hidden
            // webview runs a Poll Cycle. async_runtime::spawn, not bare
            // tokio::spawn — the latter panics with no runtime in this setup
            // context (tauri#10289). interval()'s first tick fires immediately,
            // giving the once-on-launch emit; the webview's mount poll covers the
            // race where this beats its listen (ADR-0005), events aren't buffered.
            let handle = app.handle().clone();
            spawn(async move {
                let mut ticker = interval(poll_interval());
                loop {
                    ticker.tick().await;
                    if let Err(e) = handle.emit(POLL_TICK_EVENT, ()) {
                        eprintln!("{POLL_TICK_EVENT} emit failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
