mod assistant;
mod audio;
mod audio_commands;
mod clipboard;
mod notifications;
mod state;
mod window_stealth;

use state::{HitRects, OverlayState, RuntimeState, WindowMode};
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
fn get_window_activity(window: WebviewWindow) -> Result<window_stealth::WindowActivity, String> {
    window_stealth::window_activity(&window)
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

/// Reports actual capture state after native audio setup/teardown.
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
async fn set_settings_open(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    open: bool,
) -> Result<RuntimeState, String> {
    if !open {
        window.state::<audio::AudioState>().invalidate_test();
    }
    window_stealth::set_settings_focus(window.app_handle(), &state, open).await
}

#[tauri::command]
async fn set_window_mode(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    mode: WindowMode,
) -> Result<RuntimeState, String> {
    window_stealth::set_window_mode(&window, &state, mode).await
}

#[tauri::command]
async fn start_window_drag(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
) -> Result<(), String> {
    window_stealth::drag_window(&window, &state).await
}

#[tauri::command]
async fn resize_overlay(
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> Result<window_stealth::OverlaySize, String> {
    window_stealth::resize(&window, width, height).await
}

#[tauri::command]
fn update_hit_rects(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    rects: HitRects,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window may publish overlay hit rectangles".into());
    }
    rects.validate()?;
    state.update(|data| data.rects = rects)?;
    Ok(())
}

fn open_settings(app: &AppHandle) -> Result<(), String> {
    // The primary WebView owns settings/audio state and opens the native child.
    app.emit("overlay:settings", SettingsEvent { open: true })
        .map_err(|error| error.to_string())
}

#[derive(Clone, serde::Serialize)]
struct SettingsEvent {
    open: bool,
}

fn retire_webview_session(app: &AppHandle) {
    // Revoke capture immediately, including a start still waiting for the device.
    app.state::<audio::AudioState>().invalidate();
    app.state::<audio::SystemAudioState>().invalidate();
    app.state::<assistant::AssistantState>().invalidate_view();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        handle
            .state::<assistant::AssistantState>()
            .close_stale_view()
            .await;
    });
}

fn toggle_overlay_visibility(window: &WebviewWindow) -> Result<(), String> {
    // Settings and its local microphone check have an independent lifecycle.
    window_stealth::toggle_visibility(window)
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
                    .and_then(|window| toggle_overlay_visibility(&window)),
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
                        toggle_overlay_visibility(&window)?;
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
        .manage(notifications::Notifications::default())
        .manage(assistant::AssistantState::default())
        .manage(audio::AudioState::default())
        .manage(audio::SystemAudioState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if webview.label() == "main" {
                    retire_webview_session(webview.app_handle());
                } else if webview.label() == window_stealth::SETTINGS_LABEL {
                    webview.state::<audio::AudioState>().invalidate_test();
                } else if webview.label() == notifications::LABEL {
                    notifications::page_started(webview.app_handle());
                }
            }
        })
        .on_window_event(|window, event| {
            window_stealth::on_window_activity_event(window, event);
            if window.label() == "main" {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    retire_webview_session(window.app_handle());
                } else if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // A hidden settings child must not keep a closed main app alive.
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            } else if window.label() == window_stealth::SETTINGS_LABEL {
                let close = match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        Some(false)
                    }
                    tauri::WindowEvent::Destroyed => Some(true),
                    tauri::WindowEvent::Focused(false) => {
                        window.state::<audio::AudioState>().invalidate_test();
                        None
                    }
                    _ => None,
                };
                if let Some(destroyed) = close {
                    window.state::<audio::AudioState>().invalidate_test();
                    if let Err(error) =
                        window_stealth::close_settings_from_native(window.app_handle(), destroyed)
                    {
                        report_error(window.app_handle(), error);
                    }
                }
            } else if window.label() == notifications::LABEL {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        notifications::closed_from_native(window.app_handle());
                    }
                    tauri::WindowEvent::Destroyed => {
                        notifications::closed_from_native(window.app_handle())
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            notifications::notification_show,
            notifications::notification_hide,
            notifications::notification_theme,
            notifications::notification_ready,
            notifications::notification_present,
            notifications::notification_dismissed,
            clipboard::clipboard_write_text,
            audio_commands::system_audio_state,
            audio_commands::system_audio_start,
            audio_commands::system_audio_stop,
            audio_commands::audio_input_state,
            audio_commands::audio_start,
            audio_commands::audio_stop,
            audio_commands::audio_set_noise_suppression,
            assistant::assistant_models,
            assistant::assistant_choose_workspace,
            assistant::assistant_workspace_state,
            assistant::assistant_cleanup_workspaces,
            assistant::assistant_status,
            assistant::assistant_connect,
            assistant::assistant_send,
            assistant::assistant_audio,
            assistant::assistant_disconnect,
            get_runtime_state,
            get_window_activity,
            set_microphone_muted,
            sync_audio_state,
            set_screen_capture_enabled,
            reconnect_session,
            set_scroll_locked,
            set_settings_open,
            set_window_mode,
            start_window_drag,
            resize_overlay,
            update_hit_rects
        ])
        .setup(|app| {
            tauri::async_runtime::spawn(async {
                if let Err(error) = assistant::cleanup_stale_workspaces().await {
                    eprintln!("Temporary workspace cleanup deferred: {error}");
                }
            });
            let window = app
                .get_webview_window("main")
                .ok_or("Overlay window was not created")?;
            window_stealth::initialize(&window).map_err(std::io::Error::other)?;
            if let Err(error) = notifications::initialize(app.handle()) {
                report_error(app.handle(), error);
            }
            setup_tray(app)?;
            #[cfg(desktop)]
            setup_shortcuts(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start OpenAssistant");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<notifications::Notifications>().shutdown();
            let audio = handle.state::<audio::AudioState>();
            audio.invalidate();
            let _ = audio.stop(None);
            let system = handle.state::<audio::SystemAudioState>();
            system.invalidate();
            let _ = system.stop(None);
            tauri::async_runtime::block_on(handle.state::<assistant::AssistantState>().shutdown());
        }
    });
}
