// Bitterbot Desktop Shell — Tauri 2 entry point
//
// The desktop app is a Tauri window that:
//   1. Serves the Control UI (Vite dev server in dev, static dist in prod)
//   2. Spawns the Bitterbot gateway as a managed child process
//   3. Cleans up the gateway on window close / app exit
//   4. Hosts a tray icon so closing the window minimizes instead of quitting
//   5. Checks for updates via tauri-plugin-updater (see renderer/src/lib/updater.ts)
//
// The orchestrator (P2P daemon) is spawned by the gateway itself via
// OrchestratorBridge, not by this shell. So the process tree is:
//   tauri main → gateway (node / SEA binary) → orchestrator (rust)
//
// For development: `pnpm tauri:dev` (in desktop/)
//   - Starts Vite on :5173
//   - Starts the Tauri window pointed at :5173
//   - Spawns the gateway as a child (currently via `node scripts/run-node.mjs`;
//     production path uses the SEA-compiled sidecar — see TODO below)
//
// For production: `pnpm tauri:build` → produces AppImage/DMG/exe
//   - Bundles the dist-renderer/ static files
//   - Ships the gateway as a sidecar (requires Node at runtime today;
//     SEA-compiled sidecar is wired up but requires `node scripts/build-sea.mjs`
//     to have populated desktop/src-tauri/binaries/ before bundling)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

struct GatewayChild(Mutex<Option<Child>>);

impl Drop for GatewayChild {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(ref mut child) = *guard {
                log::info!("Shutting down gateway child process");
                #[cfg(unix)]
                {
                    // Graceful SIGINT first, then SIGKILL if it hangs.
                    unsafe {
                        libc::kill(child.id() as i32, libc::SIGINT);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let _ = child.kill();
                }
                #[cfg(not(unix))]
                {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
    }
}

fn spawn_gateway() -> Result<Child, String> {
    // TODO(SEA-sidecar): once scripts/build-sea.mjs reliably produces a
    // desktop/src-tauri/binaries/bitterbot-gateway-<target>[.exe], swap
    // this to use app.shell().sidecar("bitterbot-gateway") instead. That
    // removes the Node-on-PATH dependency for end users. Left as a
    // subprocess call today so `pnpm tauri:dev` keeps working against
    // the existing scripts/run-node.mjs during Phase 1 rollout.
    //
    // In dev mode, the gateway runs from the repo root.
    // In prod, this path would point at the bundled sidecar.
    // For MVP: assume `node` is on PATH and the cwd is the repo root
    // (Tauri sets cwd to the app's resource dir in prod, but in dev
    // it's the project root — which is what we want).
    let repo_root =
        std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?;

    // Walk up from desktop/src-tauri/ to the repo root (two levels up).
    let gateway_root = if repo_root.ends_with("src-tauri") {
        repo_root
            .parent()
            .and_then(|p| p.parent())
            .unwrap_or(&repo_root)
            .to_path_buf()
    } else if repo_root.ends_with("desktop") {
        repo_root.parent().unwrap_or(&repo_root).to_path_buf()
    } else {
        repo_root
    };

    log::info!("Starting gateway from {}", gateway_root.display());

    Command::new("node")
        .args(["scripts/run-node.mjs", "gateway"])
        .current_dir(&gateway_root)
        .spawn()
        .map_err(|e| format!("failed to spawn gateway: {e}"))
}

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 1. Gateway child process lifecycle.
            match spawn_gateway() {
                Ok(child) => {
                    log::info!("Gateway started (pid {})", child.id());
                    app.manage(GatewayChild(Mutex::new(Some(child))));
                }
                Err(e) => {
                    log::error!("Gateway failed to start: {e}");
                    // Don't abort — the UI can still render (with a
                    // FirstRun/Disconnected screen). The user can
                    // start the gateway manually.
                    app.manage(GatewayChild(Mutex::new(None)));
                }
            }

            // 2. Tray icon with show/quit menu.
            let show_item =
                MenuItem::with_id(app, "show", "Show Bitterbot", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                    // Fallback: an empty 1x1 icon if no default is bundled.
                    // Prevents setup panic when icons/ is not yet populated.
                    tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1)
                }))
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) =
                            tray.app_handle().get_webview_window("main")
                        {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // 3. Intercept window close to hide instead of destroy.
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bitterbot desktop");
}
