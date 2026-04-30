// Computer-use IPC commands.
//
// PLAN-14 Pillar 4: unified `computer_use` tool that delegates browser
// actions to the existing Playwright/CDP layer (Node side) and OS-level
// actions to these Tauri commands. Everything goes through the gateway's
// exec-approval-manager before reaching here, so the user has a chance
// to approve/deny each action.
//
// Why these crates:
//   - `xcap`        cross-platform screen capture (X11 / Wayland / macOS / Windows)
//   - `enigo`       cross-platform input synthesis (mouse + keyboard)
//   - `base64`      transport screenshots over the JSON IPC bridge
//
// Gating: every command checks BITTERBOT_COMPUTER_USE=1. Default off so
// the desktop binary doesn't ship an enabled OS-control surface to users
// who didn't opt in. The gateway side will eventually mediate this through
// session-level capability grants.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use enigo::{Enigo, Keyboard, Mouse, Settings};
use serde::Serialize;
use std::io::Cursor;
use xcap::Monitor;

#[derive(Debug, Serialize)]
pub struct ScreenshotResult {
    /// PNG bytes encoded as base64.
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    /// Index of the monitor captured (0 = primary).
    pub monitor_index: usize,
}

#[derive(Debug, Serialize)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
    pub monitor_index: usize,
}

fn require_enabled() -> Result<(), String> {
    if std::env::var("BITTERBOT_COMPUTER_USE").ok().as_deref() != Some("1") {
        return Err(
            "computer_use disabled. Set BITTERBOT_COMPUTER_USE=1 to enable OS-level control."
                .into(),
        );
    }
    Ok(())
}

fn pick_monitor(index: Option<usize>) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("monitor enumeration failed: {e}"))?;
    if monitors.is_empty() {
        return Err("no monitors detected".into());
    }
    let idx = index.unwrap_or(0);
    monitors
        .into_iter()
        .nth(idx)
        .ok_or_else(|| format!("monitor index {idx} out of range"))
}

#[tauri::command]
pub fn computer_screenshot(monitor_index: Option<usize>) -> Result<ScreenshotResult, String> {
    require_enabled()?;
    let monitor = pick_monitor(monitor_index)?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("capture failed: {e}"))?;
    let width = image.width();
    let height = image.height();

    let mut buf = Vec::with_capacity((width * height * 4) as usize);
    image
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {e}"))?;

    Ok(ScreenshotResult {
        png_base64: B64.encode(&buf),
        width,
        height,
        monitor_index: monitor_index.unwrap_or(0),
    })
}

#[tauri::command]
pub fn computer_screen_size(monitor_index: Option<usize>) -> Result<ScreenSize, String> {
    require_enabled()?;
    let monitor = pick_monitor(monitor_index)?;
    Ok(ScreenSize {
        width: monitor.width(),
        height: monitor.height(),
        monitor_index: monitor_index.unwrap_or(0),
    })
}

#[tauri::command]
pub fn computer_mouse_move(x: i32, y: i32) -> Result<(), String> {
    require_enabled()?;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .move_mouse(x, y, enigo::Coordinate::Abs)
        .map_err(|e| format!("mouse move: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn computer_mouse_click(button: String) -> Result<(), String> {
    require_enabled()?;
    let btn = match button.as_str() {
        "left" => enigo::Button::Left,
        "right" => enigo::Button::Right,
        "middle" => enigo::Button::Middle,
        other => return Err(format!("unknown button: {other}")),
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .button(btn, enigo::Direction::Click)
        .map_err(|e| format!("mouse click: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn computer_type_text(text: String) -> Result<(), String> {
    require_enabled()?;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .text(&text)
        .map_err(|e| format!("type text: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn computer_key(key: String) -> Result<(), String> {
    require_enabled()?;
    let parsed = match key.to_lowercase().as_str() {
        "return" | "enter" => enigo::Key::Return,
        "tab" => enigo::Key::Tab,
        "escape" | "esc" => enigo::Key::Escape,
        "space" => enigo::Key::Space,
        "backspace" => enigo::Key::Backspace,
        "delete" => enigo::Key::Delete,
        "up" => enigo::Key::UpArrow,
        "down" => enigo::Key::DownArrow,
        "left" => enigo::Key::LeftArrow,
        "right" => enigo::Key::RightArrow,
        other => return Err(format!("unknown key: {other}")),
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .key(parsed, enigo::Direction::Click)
        .map_err(|e| format!("key press: {e}"))?;
    Ok(())
}
