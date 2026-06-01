use tauri::{async_runtime::spawn, Emitter};
use tokio::time::{interval, Duration};

// Spike-only: the hidden webview has no viewable console, so it ships fetch
// results here to print to the dev terminal.
#[tauri::command]
fn log(line: &str) {
    println!("{line}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![log])
        .setup(|app| {
            let handle = app.handle().clone();
            // async_runtime::spawn, not bare tokio::spawn — the latter panics
            // with no runtime in this context (tauri#10289).
            spawn(async move {
                // POLL_SECS env var (default 60) — retune cadence without a recompile.
                let secs: u64 = std::env::var("POLL_SECS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(60)
                    .max(1); // interval() panics on a zero period
                let mut ticker = interval(Duration::from_secs(secs));
                let mut n: u64 = 0;
                loop {
                    ticker.tick().await;
                    n += 1;
                    println!("[rust] tick {n} emitted");
                    if let Err(e) = handle.emit("poll-tick", ()) {
                        eprintln!("[rust] emit poll-tick failed: {e}");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
