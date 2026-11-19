mod state;
mod window_stealth;

use state::{HitRects, OverlayState, RuntimeState};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewWindow,
};

const CAPTURE_UNAVAILABLE: &str =
    "Screen capture is not connected yet. No screen images are being captured or sent.";
const CONNECTION_UNAVAILABLE: &str =
    "Gemini Live is not connected in this foundation build. No audio or screen data is being sent.";

fn publish(app: &AppHandle, state: RuntimeState) -> Result<RuntimeState, String> {
    app.emit("overlay:state", &state)
        .map_err(|error| error.to_string())?;
    Ok(state)
}

fn report_error(app: &AppHandle, error: impl ToString) {
    let message = error.to_string();
    eprintln!("{message}");
    let _ = app.emit("overlay:error", message);
}

#[tauri::command]
fn get_runtime_state(state: State<'_, OverlayState>) -> Result<RuntimeState, String> {
    state.snapshot()
}

#[tauri::command]
fn set_microphone_muted(
    app: AppHandle,
    state: State<'_, OverlayState>,
    muted: bool,
) -> Result<RuntimeState, String> {
    // This is the requested mute preference. audioAvailable stays false until the audio backend exists.
    publish(
        &app,
        state.update(|data| data.runtime.microphone_muted = muted)?,
    )
}

#[tauri::command]
fn set_screen_capture_enabled(
    app: AppHandle,
    state: State<'_, OverlayState>,
    enabled: bool,
) -> Result<RuntimeState, String> {
    if enabled {
        return Err(CAPTURE_UNAVAILABLE.into());
    }
    publish(
        &app,
        state.update(|data| data.runtime.screen_capture_enabled = false)?,
    )
}

#[tauri::command]
fn reconnect_session() -> Result<RuntimeState, String> {
    Err(CONNECTION_UNAVAILABLE.into())
}

#[tauri::command]
fn set_scroll_locked(
    app: AppHandle,
    state: State<'_, OverlayState>,
    locked: bool,
) -> Result<RuntimeState, String> {
    publish(
        &app,
        state.update(|data| data.runtime.scroll_locked = locked)?,
    )
}

#[tauri::command]
fn set_settings_open(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    open: bool,
) -> Result<RuntimeState, String> {
    window_stealth::set_settings_focus(&window, &state, open)?;
    publish(window.app_handle(), state.snapshot()?)
}

#[tauri::command]
fn resize_overlay(
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> Result<window_stealth::OverlaySize, String> {
    window_stealth::resize(&window, width, height)
}

#[tauri::command]
fn update_hit_rects(state: State<'_, OverlayState>, rects: HitRects) -> Result<(), String> {
    rects.validate()?;
    state.update(|data| data.rects = rects)?;
    Ok(())
}

fn open_settings(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Overlay window is unavailable")?;
    let state = app.state::<OverlayState>();
    window_stealth::set_settings_focus(&window, &state, true)?;
    publish(app, state.snapshot()?)?;
    app.emit("overlay:settings", SettingsEvent { open: true })
        .map_err(|error| error.to_string())
}

#[derive(Clone, serde::Serialize)]
struct SettingsEvent {
    open: bool,
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Показать / скрыть", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
    let reconnect = MenuItem::with_id(app, "reconnect", "Переподключиться", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &reconnect, &quit])?;
    // A small neutral icon is generated as RGBA, keeping the shell independent of raster tooling.
    let mut rgba = vec![0_u8; 32 * 32 * 4];
    for y in 4..28 {
        for x in 4..28 {
            let index = (y * 32 + x) * 4;
            let edge = x < 7 || x >= 25 || y < 7 || y >= 25;
            let color = if edge {
                [230, 234, 241, 255]
            } else {
                [32, 35, 41, 255]
            };
            rgba[index..index + 4].copy_from_slice(&color);
        }
    }
    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::image::Image::new_owned(rgba, 32, 32))
        .tooltip("OpenAssistant")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "toggle" => app
                    .get_webview_window("main")
                    .ok_or_else(|| "Overlay window is unavailable".to_owned())
                    .and_then(|window| window_stealth::toggle_visibility(&window)),
                "settings" => open_settings(app),
                "reconnect" => Err(CONNECTION_UNAVAILABLE.to_owned()),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                report_error(app, error);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn setup_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };
    let keys = [Code::Space, Code::KeyM, Code::KeyL, Code::KeyS];
    let shortcuts = keys.map(|key| Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), key));
    let register_shortcuts = shortcuts.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let result = (|| -> Result<(), String> {
                    let state = app.state::<OverlayState>();
                    if shortcut == &shortcuts[0] {
                        let window = app
                            .get_webview_window("main")
                            .ok_or("Overlay window is unavailable")?;
                        window_stealth::toggle_visibility(&window)?;
                    } else if shortcut == &shortcuts[1] {
                        let snapshot = state.update(|data| {
                            data.runtime.microphone_muted = !data.runtime.microphone_muted
                        })?;
                        publish(app, snapshot)?;
                    } else if shortcut == &shortcuts[2] {
                        let snapshot = state.update(|data| {
                            data.runtime.scroll_locked = !data.runtime.scroll_locked
                        })?;
                        publish(app, snapshot)?;
                    } else if shortcut == &shortcuts[3] {
                        return Err(CAPTURE_UNAVAILABLE.into());
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    report_error(app, error);
                }
            })
            .build(),
    )?;
    // A shortcut collision should not make the entire overlay impossible to launch.
    for shortcut in register_shortcuts {
        if let Err(error) = app.global_shortcut().register(shortcut) {
            report_error(app, format!("Could not register global shortcut: {error}"));
        }
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(OverlayState::default())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_runtime_state,
            set_microphone_muted,
            set_screen_capture_enabled,
            reconnect_session,
            set_scroll_locked,
            set_settings_open,
            resize_overlay,
            update_hit_rects
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("Overlay window was not created")?;
            window_stealth::initialize(&window).map_err(std::io::Error::other)?;
            setup_tray(app)?;
            #[cfg(desktop)]
            setup_shortcuts(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start OpenAssistant");
}
