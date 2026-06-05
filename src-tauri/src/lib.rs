use tauri::{async_runtime::spawn, tray::TrayIconBuilder, Emitter, Manager};
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

// The Manifest's fixed location under the user's home (ADR-0007). Kept in Rust so
// the path — not a general filesystem capability — is the webview's only reach.
const MANIFEST_DIR: &str = ".agents";
const MANIFEST_FILE: &str = ".skill-lock.json";

// Reads the Manifest (~/.agents/.skill-lock.json) for the frontend (ADR-0007):
// the webview's one filesystem reach is this command, the path fixed here rather
// than granted as an fs plugin. Ok(None) when the file or its directory is absent
// — the clean "nothing installed" signal the TS cycle maps to no-manifest;
// Ok(Some(contents)) otherwise, with all parsing left to TS. Any other I/O error
// (e.g. permissions, non-UTF-8 contents) surfaces as Err for TS to handle.
#[tauri::command]
fn read_manifest(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(MANIFEST_DIR)
        .join(MANIFEST_FILE);
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// The Keychain item the user stores their GitHub PAT under (ADR-0006). Set
// out-of-band for this slice, e.g.
//   security add-generic-password -s skill-drift -a github-pat -w <PAT>
// get_token reads it; the writer command (set_token) is deferred. Upsert when it
// lands — never delete-then-recreate, which wipes the item's ACL (ADR-0006).
#[cfg(target_os = "macos")]
const TOKEN_SERVICE: &str = "skill-drift";
#[cfg(target_os = "macos")]
const TOKEN_ACCOUNT: &str = "github-pat";

// Registers the macOS login Keychain as keyring-core's default credential store
// (ADR-0006), once at setup before any get_token. keyring-core is the cross-
// platform seam; apple-native-keyring-store is the macOS backend. Registering
// doesn't touch the Keychain (no prompt) — access happens on get_password.
#[cfg(target_os = "macos")]
fn register_keychain_store() -> Result<(), String> {
    let store = apple_native_keyring_store::keychain::Store::new().map_err(|e| e.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

// Reads the user's GitHub PAT from the macOS Keychain for the frontend (ADR-0006):
// Rust owns the secret and hands over bytes, TS only uses it (ADR-0002). Ok(None)
// when no item is stored — the clean "add a token" signal the TS cycle maps to
// no-token; Ok(Some(pat)) otherwise. Any other Keychain failure surfaces as Err.
#[cfg(target_os = "macos")]
#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
    let entry =
        keyring_core::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pat) => Ok(Some(pat)),
        Err(keyring_core::error::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// No Keychain backend off macOS yet (ADR-0006 is macOS-first). Report no token so
// get_token stays infallible and the cycle takes its clean no-token arm, rather
// than the unregistered-store error throwing past it (only the macOS store is
// registered in setup). One arm per future OS, mirroring register_keychain_store.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_badge,
            read_manifest,
            get_token
        ])
        .setup(|app| {
            // Dock-less menu-bar app: no Dock icon, no app menu (ADR-0005).
            // LSUIElement covers the bundled app; this covers tauri dev.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // GitHub PAT store for get_token (ADR-0006), registered before the
            // poll-clock so the first cycle can read a token.
            #[cfg(target_os = "macos")]
            register_keychain_store()?;

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
