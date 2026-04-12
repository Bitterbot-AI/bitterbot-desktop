// Bitterbot Desktop Shell — Tauri 2 entry point
//
// The desktop app is a Tauri window that:
//   1. Serves the Control UI (Vite dev server in dev, static dist in prod)
//   2. Spawns the Bitterbot gateway as a managed child process
//   3. Cleans up the gateway on window close / app exit
//
// The orchestrator (P2P daemon) is spawned by the gateway itself via
// OrchestratorBridge, not by this shell. So the process tree is:
//   tauri main → gateway (node) → orchestrator (rust)
//
// For development: `pnpm tauri:dev` (in desktop/)
//   - Starts Vite on :5173
//   - Starts the Tauri window pointed at :5173
//   - Spawns the gateway as a child
//
// For production: `pnpm tauri:build` → produces AppImage/DMG/exe
//   - Bundles the dist-renderer/ static files
//   - Ships the gateway as a sidecar (requires Node on the system for
//     MVP; future: bun-compiled single executable)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

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
    // In dev mode, the gateway runs from the repo root.
    // In prod, this path would point at the bundled sidecar.
    // For MVP: assume `node` is on PATH and the cwd is the repo root
    // (Tauri sets cwd to the app's resource dir in prod, but in dev
    // it's the project root — which is what we want).
    let repo_root = std::env::current_dir()
        .map_err(|e| format!("cannot resolve cwd: {e}"))?;

    // Walk up from desktop/src-tauri/ to the repo root (two levels up).
    let gateway_root = if repo_root.ends_with("src-tauri") {
        repo_root
            .parent()
            .and_then(|p| p.parent())
            .unwrap_or(&repo_root)
            .to_path_buf()
    } else if repo_root.ends_with("desktop") {
        repo_root
            .parent()
            .unwrap_or(&repo_root)
            .to_path_buf()
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
        .setup(|app| {
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bitterbot desktop");
}
