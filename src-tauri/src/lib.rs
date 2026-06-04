use std::time::Duration;
use tauri::{tray::TrayIconBuilder, Emitter, Manager};

// Shared with the frontend (TRAY_ID in src/platform.ts), which looks the tray up
// via TrayIcon.getById to attach the menu.
const TRAY_ID: &str = "main";
const POLL_TICK_EVENT: &str = "poll-tick";
const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);

#[tauri::command]
fn set_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| format!("tray \"{TRAY_ID}\" not found"))?;

    let title = (count > 0).then(|| count.to_string());
    tray.set_title(title.as_deref()).map_err(|e| e.to_string())
}

fn emit_poll_tick(app: &tauri::AppHandle) {
    if let Err(err) = app.emit(POLL_TICK_EVENT, ()) {
        eprintln!("failed to emit {POLL_TICK_EVENT}: {err}");
    }
}

fn spawn_poll_clock(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        emit_poll_tick(&app); // launch tick

        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.tick().await; // consume the immediate first tick
        loop {
            ticker.tick().await;
            emit_poll_tick(&app);
        }
    });
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

            spawn_poll_clock(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
