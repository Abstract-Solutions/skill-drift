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

// Resolves a GitHub token for the frontend in the ADR-0006 order: the stored
// skill-drift PAT, else the GitHub CLI's token (env GH_TOKEN/GITHUB_TOKEN, else
// `gh auth token` live), else None. Rust owns where the secret lives and hands over
// bytes; TS only uses it (ADR-0002). Ok(None) is the clean "add a token" signal the
// cycle maps to no-token; only a genuine Keychain failure (not a missing item) is
// Err. The gh token is queried live and never copied into our own item — that keeps
// gh users zero-config and the token never stale (ADR-0006).
//
// `(async)` runs the (synchronous) body off the main thread: the gh / login-shell
// spawns below block, and Tauri runs sync commands on the main thread, which would
// freeze the tray + webview for the spawn's duration on every poll.
#[cfg(target_os = "macos")]
#[tauri::command(async)]
fn get_token() -> Result<Option<String>, String> {
    if let Some(pat) = keychain_pat()? {
        return Ok(Some(pat));
    }
    Ok(gh_token())
}

// The stored skill-drift PAT (TOKEN_SERVICE/TOKEN_ACCOUNT). Ok(None) when no item
// exists — the signal to try the gh fallback; any other Keychain failure is Err.
#[cfg(target_os = "macos")]
fn keychain_pat() -> Result<Option<String>, String> {
    let entry =
        keyring_core::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pat) => Ok(Some(pat)),
        Err(keyring_core::error::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// The GitHub CLI fallback (ADR-0006), used when no skill-drift PAT is stored:
// GH_TOKEN/GITHUB_TOKEN from the env, else `gh auth token` queried live. None when
// neither is available — the unchanged no-token outcome.
#[cfg(target_os = "macos")]
fn gh_token() -> Option<String> {
    env_token().or_else(gh_auth_token)
}

// GH_TOKEN, then GITHUB_TOKEN — gh's own precedence. Checked before any spawn, so a
// GUI-launched app with a minimal PATH still resolves these even when `gh` can't be
// found (ADR-0006). The precedence/trim/empty logic lives in env_token_from.
#[cfg(target_os = "macos")]
fn env_token() -> Option<String> {
    env_token_from(|key| std::env::var(key).ok())
}

// First non-empty of GH_TOKEN then GITHUB_TOKEN, trimmed; empty/whitespace counts as
// unset and falls through. The env read is injected as `lookup` so this logic is
// unit-tested without mutating process env, which cargo's parallel tests would race.
#[cfg(target_os = "macos")]
fn env_token_from(lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["GH_TOKEN", "GITHUB_TOKEN"].into_iter().find_map(|key| {
        lookup(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

// Ceiling on the `gh auth token` subprocess (ADR-0006). It's a local Keychain read
// (sub-100ms in practice), so this generous bound never trips a healthy call but
// stops a stalled gh — an unreachable-network refresh or a lingering Keychain prompt
// — from blocking the worker thread indefinitely; the poll degrades to no-token.
#[cfg(target_os = "macos")]
const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(5);

// `gh auth token` queried live (ADR-0006): its output reflects gh's current, refreshed
// token wherever gh keeps it (its own Keychain item, under an ACL we can't read
// directly). None unless gh is found and exits 0 within GH_AUTH_TIMEOUT with a
// non-empty token — a missing, logged-out, or stalled gh is the no-token outcome, not
// an error.
#[cfg(target_os = "macos")]
fn gh_auth_token() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use wait_timeout::ChildExt;

    let gh = resolve_gh()?;
    let mut child = Command::new(gh)
        .args(["auth", "token"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let Some(status) = child.wait_timeout(GH_AUTH_TIMEOUT).ok()? else {
        // Stalled gh: kill it and degrade to no-token instead of blocking.
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    if !status.success() {
        return None;
    }
    let mut token = String::new();
    child.stdout.take()?.read_to_string(&mut token).ok()?;
    let token = token.trim().to_string();
    (!token.is_empty()).then_some(token)
}

// Fixed-location `gh` installs, probed before the login-shell fallback (ADR-0006) to
// skip a shell spawn: Homebrew (Apple Silicon, then Intel) and MacPorts. Installs at
// variable/home-relative paths (Conda, Flox, Spack, Webi, a hand-placed binary) are
// deliberately absent — the fix-path-env fallback resolves those from the user's real
// shell PATH, so this list need only cover the fixed system locations.
#[cfg(target_os = "macos")]
const KNOWN_GH_PATHS: [&str; 3] = [
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/opt/local/bin/gh",
];

// Locate `gh` despite the GUI-launch PATH gotcha (ADR-0006): a Finder-/bundle-
// launched app inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a bare
// `gh` isn't found. Probe the fixed install paths first (common case, no shell
// spawn); else rewrite this process's PATH from a login shell so a bare `gh` resolves
// wherever it lives. `tauri dev` inherits the terminal PATH, so only the bundle needs
// the fallback.
#[cfg(target_os = "macos")]
fn resolve_gh() -> Option<std::path::PathBuf> {
    if let Some(path) = KNOWN_GH_PATHS
        .into_iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.exists())
    {
        return Some(path);
    }
    // fix() spawns a login shell and rewrites PATH; do it at most once per process —
    // Once caps that cost and confines the env mutation to a single call.
    static FIX_PATH: std::sync::Once = std::sync::Once::new();
    FIX_PATH.call_once(|| {
        if let Err(e) = fix_path_env::fix() {
            eprintln!("fix-path-env failed: {e}");
        }
    });
    // Resolved via the now-fixed PATH; Command yields Err (→ None) if gh is absent.
    Some(std::path::PathBuf::from("gh"))
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
            // A dedicated template icon (black + alpha), not bundle.icon's full-
            // colour app icon: drawn at menu-bar size and, as a template
            // (icon_as_template), inverted for light/dark bars. include_image!
            // embeds it at compile time, so a missing asset fails the build.
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::include_image!("icons/tray-icon.png"))
                .icon_as_template(true)
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

// env_token_from precedence + empty-handling (ADR-0006). Injecting the lookup keeps
// the logic off process env, so the tests need no global state and stay parallel-safe.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::env_token_from;

    #[test]
    fn returns_none_when_neither_var_is_set() {
        assert_eq!(env_token_from(|_| None), None);
    }

    #[test]
    fn uses_github_token_when_it_is_the_only_one_set() {
        let env = |k: &str| (k == "GITHUB_TOKEN").then(|| "from-github".to_string());
        assert_eq!(env_token_from(env).as_deref(), Some("from-github"));
    }

    #[test]
    fn gh_token_takes_precedence_over_github_token() {
        let env = |k: &str| match k {
            "GH_TOKEN" => Some("from-gh".to_string()),
            "GITHUB_TOKEN" => Some("from-github".to_string()),
            _ => None,
        };
        assert_eq!(env_token_from(env).as_deref(), Some("from-gh"));
    }

    #[test]
    fn blank_gh_token_falls_through_to_github_token() {
        let env = |k: &str| match k {
            "GH_TOKEN" => Some("   ".to_string()),
            "GITHUB_TOKEN" => Some("from-github".to_string()),
            _ => None,
        };
        assert_eq!(env_token_from(env).as_deref(), Some("from-github"));
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let env = |k: &str| (k == "GH_TOKEN").then(|| "  tok  ".to_string());
        assert_eq!(env_token_from(env).as_deref(), Some("tok"));
    }
}
