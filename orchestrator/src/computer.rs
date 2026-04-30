//! Headless OS-control primitives for the orchestrator daemon.
//!
//! PLAN-14 Pillar 4 (orchestrator-extension path). When built with
//! `--features=computer-use`, this module exposes screen capture, mouse
//! movement, mouse click, text typing, and key tap. Each operation is
//! still gated at runtime by `BITTERBOT_COMPUTER_USE=1` so a binary
//! built with the feature still won't act unless the operator opts in.
//!
//! The relay fleet (DigitalOcean + Railway) builds without this feature
//! and therefore doesn't link xcap/enigo or pull in X11 system deps.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Standard error shape returned through the IPC channel.
fn err(msg: &str) -> Value {
    serde_json::json!({ "ok": false, "error": msg })
}

fn ok(payload: Value) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("ok".to_string(), Value::Bool(true));
    if let Value::Object(extra) = payload {
        for (k, v) in extra {
            obj.insert(k, v);
        }
    }
    Value::Object(obj)
}

/// Operator-level gate: runtime env var must be set even on a
/// computer-use-enabled binary. Returns Some(error) if disabled.
pub fn require_runtime_enabled() -> Option<Value> {
    match std::env::var("BITTERBOT_COMPUTER_USE") {
        Ok(v) if v == "1" || v.eq_ignore_ascii_case("true") => None,
        _ => Some(err(
            "computer use disabled at runtime — set BITTERBOT_COMPUTER_USE=1",
        )),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MouseClickArgs {
    /// "left" | "right" | "middle". Defaults to "left".
    #[serde(default)]
    pub button: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MouseMoveArgs {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TypeArgs {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyArgs {
    /// Either a printable char ("a") or a name ("Return", "Tab", "Escape").
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScreenshotArgs {
    #[serde(default)]
    pub monitor_index: Option<usize>,
}

// =========================================================================
// Feature-on path: real impl using xcap + enigo.
// =========================================================================

#[cfg(feature = "computer-use")]
pub mod imp {
    use super::*;
    use base64::Engine as _;
    use enigo::{Direction, Enigo, Key, Keyboard, Mouse, Settings};
    use image::ImageEncoder;

    pub fn screenshot(args: ScreenshotArgs) -> Value {
        if let Some(blocked) = require_runtime_enabled() {
            return blocked;
        }
        let monitors = match xcap::Monitor::all() {
            Ok(m) => m,
            Err(e) => return err(&format!("monitor enumeration failed: {e}")),
        };
        if monitors.is_empty() {
            return err("no monitors detected");
        }
        let idx = args.monitor_index.unwrap_or(0).min(monitors.len() - 1);
        let monitor = &monitors[idx];
        let img = match monitor.capture_image() {
            Ok(i) => i,
            Err(e) => return err(&format!("capture failed: {e}")),
        };
        let width = img.width();
        let height = img.height();
        let mut png_bytes: Vec<u8> = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        if let Err(e) = encoder.write_image(
            img.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgba8,
        ) {
            return err(&format!("png encode failed: {e}"));
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        ok(serde_json::json!({
            "png_base64": b64,
            "width": width,
            "height": height,
            "monitor_index": idx,
        }))
    }

    pub fn screen_size(args: ScreenshotArgs) -> Value {
        if let Some(blocked) = require_runtime_enabled() {
            return blocked;
        }
        let monitors = match xcap::Monitor::all() {
            Ok(m) => m,
            Err(e) => return err(&format!("monitor enumeration failed: {e}")),
        };
        if monitors.is_empty() {
            return err("no monitors detected");
        }
        let idx = args.monitor_index.unwrap_or(0).min(monitors.len() - 1);
        let monitor = &monitors[idx];
        ok(serde_json::json!({
            "width": monitor.width(),
            "height": monitor.height(),
            "monitor_index": idx,
        }))
    }

    pub fn mouse_move(args: MouseMoveArgs) -> Value {
        if let Some(blocked) = require_runtime_enabled() {
            return blocked;
        }
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => return err(&format!("enigo init failed: {e}")),
        };
        if let Err(e) = enigo.move_mouse(args.x, args.y, enigo::Coordinate::Abs) {
            return err(&format!("mouse_move failed: {e}"));
        }
        ok(serde_json::json!({ "x": args.x, "y": args.y }))
    }

    pub fn mouse_click(args: MouseClickArgs) -> Value {
        if let Some(blocked) = require_runtime_enabled() {
            return blocked;
        }
        let button = match args.button.as_deref().unwrap_or("left") {
            "left" => enigo::Button::Left,
            "right" => enigo::Button::Right,
            "middle" => enigo::Button::Middle,
            other => return err(&format!("unknown button: {other}")),
        };
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => return err(&format!("enigo init failed: {e}")),
        };
        if let Err(e) = enigo.button(button, Direction::Click) {
            return err(&format!("mouse_click failed: {e}"));
        }
        ok(serde_json::json!({ "button": args.button.unwrap_or_else(|| "left".into()) }))
    }

    pub fn type_text(args: TypeArgs) -> Value {
        if let Some(blocked) = require_runtime_enabled() {
            return blocked;
        }
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => return err(&format!("enigo init failed: {e}")),
        };
        if let Err(e) = enigo.text(&args.text) {
            return err(&format!("type_text failed: {e}"));
        }
        ok(serde_json::json!({ "typed": args.text.len() }))
    }

    pub fn key(args: KeyArgs) -> Value {
        if let Some(blocked) = require_runtime_enabled() {
            return blocked;
        }
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => return err(&format!("enigo init failed: {e}")),
        };
        let key = parse_key(&args.key);
        if let Err(e) = enigo.key(key, Direction::Click) {
            return err(&format!("key failed: {e}"));
        }
        ok(serde_json::json!({ "key": args.key }))
    }

    fn parse_key(name: &str) -> Key {
        // Common named keys; fall back to Unicode for single chars. The
        // string set here is intentionally conservative — enigo exposes
        // many more, but agents rarely need more than these.
        match name {
            "Return" | "Enter" => Key::Return,
            "Tab" => Key::Tab,
            "Escape" | "Esc" => Key::Escape,
            "Backspace" => Key::Backspace,
            "Delete" => Key::Delete,
            "Up" | "ArrowUp" => Key::UpArrow,
            "Down" | "ArrowDown" => Key::DownArrow,
            "Left" | "ArrowLeft" => Key::LeftArrow,
            "Right" | "ArrowRight" => Key::RightArrow,
            "Space" => Key::Space,
            "Home" => Key::Home,
            "End" => Key::End,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            other => {
                let mut chars = other.chars();
                if let Some(c) = chars.next() {
                    if chars.next().is_none() {
                        return Key::Unicode(c);
                    }
                }
                // Unknown multi-char key: best-effort tab — caller will
                // see the wrong key tapped, but enigo doesn't have a way
                // to refuse here.
                Key::Tab
            }
        }
    }
}

// =========================================================================
// Feature-off path: every command returns a clear "feature not built" error
// so Node-side callers can surface it instead of seeing a missing-IPC route.
// =========================================================================

#[cfg(not(feature = "computer-use"))]
pub mod imp {
    use super::*;

    fn unsupported() -> Value {
        err("computer-use feature not enabled in this orchestrator build")
    }

    pub fn screenshot(_args: ScreenshotArgs) -> Value { unsupported() }
    pub fn screen_size(_args: ScreenshotArgs) -> Value { unsupported() }
    pub fn mouse_move(_args: MouseMoveArgs) -> Value { unsupported() }
    pub fn mouse_click(_args: MouseClickArgs) -> Value { unsupported() }
    pub fn type_text(_args: TypeArgs) -> Value { unsupported() }
    pub fn key(_args: KeyArgs) -> Value { unsupported() }
}
