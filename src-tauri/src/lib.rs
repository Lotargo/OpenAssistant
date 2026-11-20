mod assistant;
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
    app.emit(
        "overlay:action",
        serde_json::json!({"action":"microphone","muted":muted}),
    )
    .map_err(|error| error.to_string())?;
    state.snapshot()
}

/// Reports actual capture state after WebView audio setup/teardown.
#[tauri::command]
fn sync_audio_state(
    app: AppHandle,
    state: State<'_, OverlayState>,
    muted: bool,
    available: bool,
) -> Result<RuntimeState, String> {
    let current = state.snapshot()?;
    if current.microphone_muted == muted && current.audio_available == available {
        return Ok(current);
    }
    publish(
        &app,
        state.update(|data| {
            data.runtime.microphone_muted = muted;
            data.runtime.audio_available = available;
        })?,
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
fn reconnect_session(
    app: AppHandle,
    state: State<'_, OverlayState>,
) -> Result<RuntimeState, String> {
    app.emit("overlay:action", serde_json::json!({"action":"reconnect"}))
        .map_err(|error| error.to_string())?;
    state.snapshot()
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

fn retire_webview_session(app: &AppHandle) {
    app.state::<assistant::AssistantState>().invalidate_view();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        handle
            .state::<assistant::AssistantState>()
            .close_stale_view()
            .await;
    });
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
            let edge = !(7..25).contains(&x) || !(7..25).contains(&y);
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
                "reconnect" => app
                    .emit("overlay:action", serde_json::json!({"action":"reconnect"}))
                    .map_err(|error| error.to_string()),
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
    let register_shortcuts = shortcuts;
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
                        let muted = !state.snapshot()?.microphone_muted;
                        app.emit(
                            "overlay:action",
                            serde_json::json!({"action":"microphone","muted":muted}),
                        )
                        .map_err(|error| error.to_string())?;
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
    let app = tauri::Builder::default()
        .manage(OverlayState::default())
        .manage(assistant::AssistantState::default())
        .plugin(tauri_plugin_store::Builder::default().build())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                retire_webview_session(webview.app_handle());
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                retire_webview_session(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            assistant::assistant_status,
            assistant::assistant_connect,
            assistant::assistant_send,
            assistant::assistant_audio,
            assistant::assistant_disconnect,
            get_runtime_state,
            set_microphone_muted,
            sync_audio_state,
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
        .build(tauri::generate_context!())
        .expect("could not start OpenAssistant");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            tauri::async_runtime::block_on(handle.state::<assistant::AssistantState>().shutdown());
        }
    });
}
