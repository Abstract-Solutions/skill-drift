use tauri::tray::TrayIconBuilder;

// Shared with the frontend (TRAY_ID in src/platform.ts), which looks the tray up
// via TrayIcon.getById to attach the menu.
const TRAY_ID: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
                        .expect("default window icon embedded from tauri.conf.json bundle.icon")
                        .clone(),
                )
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
