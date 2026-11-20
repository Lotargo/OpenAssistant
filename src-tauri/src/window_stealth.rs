use crate::state::{OverlayState, RuntimeState, WindowMode, WindowRect};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

pub const SETTINGS_LABEL: &str = "settings";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowPolicy {
    protected: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    focusable: bool,
}
impl WindowPolicy {
    fn new(mode: WindowMode, settings_window: bool) -> Self {
        let overlay = mode == WindowMode::Overlay;
        Self {
            protected: overlay,
            always_on_top: overlay,
            skip_taskbar: overlay,
            focusable: !overlay || settings_window,
        }
    }
}

fn content_protection(window: &WebviewWindow, protected: bool) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    window
        .set_content_protected(protected)
        .map_err(|error| error.to_string())?;
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (window, protected);
    Ok(())
}

fn apply_policy(window: &WebviewWindow, policy: WindowPolicy) -> Result<(), String> {
    #[cfg(windows)]
    if window.label() == "main" {
        windows::clear_interception();
    }
    if policy.protected {
        content_protection(window, true)?;
    }
    window
        .set_always_on_top(policy.always_on_top)
        .map_err(|e| e.to_string())?;
    window
        .set_skip_taskbar(policy.skip_taskbar)
        .map_err(|e| e.to_string())?;
    window
        .set_focusable(policy.focusable)
        .map_err(|e| e.to_string())?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    if !policy.protected {
        content_protection(window, false)?;
    }
    Ok(())
}

pub fn protect(window: &WebviewWindow) -> Result<(), String> {
    content_protection(
        window,
        window.state::<OverlayState>().snapshot()?.window_mode == WindowMode::Overlay,
    )
}

#[cfg(windows)]
fn restore_external_focus(own: isize, previous: Option<isize>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsWindow, SetForegroundWindow,
    };
    if let Some(previous) = previous.filter(|target| *target != 0 && *target != own) {
        unsafe {
            if GetForegroundWindow() as isize == own && IsWindow(previous as _) != 0 {
                SetForegroundWindow(previous as _);
            }
        }
    }
}

pub async fn set_window_mode(
    window: &WebviewWindow,
    state: &OverlayState,
    mode: WindowMode,
) -> Result<RuntimeState, String> {
    let _operation = state.window_operation().await;
    let app = window.app_handle().clone();
    let worker_app = app.clone();
    let worker_state = state.clone();
    let runtime = tauri::async_runtime::spawn_blocking(move || {
        apply_window_mode(&worker_app, &worker_state, mode)
    })
    .await
    .map_err(|e| format!("Window operation failed: {e}"))??;
    app.emit("overlay:state", &runtime)
        .map_err(|e| e.to_string())?;
    Ok(runtime)
}

fn apply_window_mode(
    app: &AppHandle,
    state: &OverlayState,
    mode: WindowMode,
) -> Result<RuntimeState, String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    let settings = app.get_webview_window(SETTINGS_LABEL);
    let windows: Vec<_> = std::iter::once(main.clone())
        .chain(settings.clone())
        .collect();
    // All getters happen outside the state mutex. They may wait for the UI thread.
    let main_visible = main.is_visible().map_err(|e| e.to_string())?;
    let settings_visible = settings
        .as_ref()
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    #[cfg(windows)]
    let own = main.hwnd().map_err(|e| e.to_string())?.0 as isize;
    #[cfg(windows)]
    let settings_own = settings
        .as_ref()
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as isize);
    #[cfg(windows)]
    let foreground =
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } as isize;
    let mut data = state.0.lock().map_err(|_| "Overlay state is unavailable")?;
    let previous_mode = data.runtime.window_mode;
    #[cfg(windows)]
    let is_external = |target: isize| target != 0 && target != own && Some(target) != settings_own;
    #[cfg(windows)]
    let focus_before_standard = if is_external(foreground) {
        Some(foreground)
    } else {
        data.previous_focus.filter(|target| is_external(*target))
    };
    let applied = (|| {
        for window in &windows {
            apply_policy(
                window,
                WindowPolicy::new(mode, window.label() == SETTINGS_LABEL),
            )?;
        }
        if mode == WindowMode::Standard {
            #[cfg(windows)]
            let focus_settings = settings_visible && Some(foreground) == settings_own;
            #[cfg(not(windows))]
            let focus_settings = settings_visible;
            if focus_settings {
                if let Some(settings) = &settings {
                    settings.set_focus().map_err(|e| e.to_string())?;
                }
            } else if main_visible {
                main.set_focus().map_err(|e| e.to_string())?;
            }
        }
        #[cfg(windows)]
        if mode == WindowMode::Overlay && settings_visible && foreground == own {
            if let Some(settings) = &settings {
                settings.set_focus().map_err(|e| e.to_string())?;
            }
        }
        Ok::<(), String>(())
    })();
    data.pointer_generation = data.pointer_generation.wrapping_add(1);
    if let Err(error) = applied {
        let rollback: Vec<_> = windows
            .iter()
            .filter_map(|window| {
                apply_policy(
                    window,
                    WindowPolicy::new(previous_mode, window.label() == SETTINGS_LABEL),
                )
                .err()
            })
            .collect();
        return if rollback.is_empty() {
            Err(format!("Could not change window mode: {error}"))
        } else {
            Err(format!(
                "Could not change window mode: {error}. Restore failed: {}",
                rollback.join("; ")
            ))
        };
    }
    #[cfg(windows)]
    let mut return_focus = None;
    if previous_mode != mode {
        #[cfg(windows)]
        if mode == WindowMode::Standard {
            data.before_standard_focus = focus_before_standard;
        } else {
            let previous = data.before_standard_focus.take();
            if settings_visible {
                if data
                    .previous_focus
                    .is_none_or(|target| !is_external(target))
                {
                    data.previous_focus = previous;
                }
            } else {
                return_focus = previous;
            }
        }
        data.runtime.window_mode = mode;
        data.runtime.revision = data.runtime.revision.saturating_add(1);
    }
    let runtime = data.runtime.clone();
    drop(data);
    #[cfg(windows)]
    restore_external_focus(own, return_focus);
    Ok(runtime)
}

pub fn show(window: &WebviewWindow) -> Result<(), String> {
    protect(window)?;
    window.show().map_err(|e| e.to_string())?;
    protect(window)?;
    if window.label() == SETTINGS_LABEL
        || window.state::<OverlayState>().snapshot()?.window_mode == WindowMode::Standard
    {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn toggle_visibility(window: &WebviewWindow) -> Result<(), String> {
    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())?;
        protect(window)
    } else {
        show(window)
    }
}

fn clamp_to_work_area(mut rect: WindowRect, area: WindowRect) -> WindowRect {
    if area.width == 0 || area.height == 0 {
        return rect;
    }
    rect.width = rect.width.min(area.width);
    rect.height = rect.height.min(area.height);
    let clamp_axis = |position: i32, origin: i32, available: u32, size: u32| {
        (position as i64)
            .clamp(
                origin as i64,
                origin as i64 + available as i64 - size as i64,
            )
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32
    };
    rect.x = clamp_axis(rect.x, area.x, area.width, rect.width);
    rect.y = clamp_axis(rect.y, area.y, area.height, rect.height);
    rect
}

fn current_work_area(window: &WebviewWindow) -> Result<Option<WindowRect>, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?);
    Ok(monitor.map(|monitor| {
        let area = monitor.work_area();
        WindowRect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        }
    }))
}

fn initial_settings_rect(area: WindowRect, scale: f64) -> WindowRect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = ((860.0 * scale).round() as u32).min(area.width).max(1);
    let height = ((690.0 * scale).round() as u32).min(area.height).max(1);
    WindowRect {
        x: (area.x as i64 + area.width.saturating_sub(width) as i64 / 2)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        y: (area.y as i64 + area.height.saturating_sub(height) as i64 / 2)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        width,
        height,
    }
}

fn ensure_settings_window(app: &AppHandle, state: &OverlayState) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        return Ok(window);
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    let mode = state.snapshot()?.window_mode;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let area = current_work_area(&main)?.unwrap_or(WindowRect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    });
    let rect = initial_settings_rect(area, scale);
    // Called only on a blocking worker under the async window-operation lock.
    // WebView2 creation in a synchronous IPC/event callback can deadlock Windows.
    let window =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("settings.html".into()))
            .title("OpenAssistant — Настройки")
            .inner_size(860.0, 690.0)
            .decorations(false)
            .transparent(false)
            .shadow(false)
            .resizable(false)
            .background_color(tauri::utils::config::Color(24, 24, 27, 255))
            .visible(false)
            .focused(false)
            .focusable(true)
            .always_on_top(mode == WindowMode::Overlay)
            .content_protected(mode == WindowMode::Overlay)
            .skip_taskbar(mode == WindowMode::Overlay)
            .build()
            .map_err(|e| e.to_string())?;
    state.update(|data| data.settings_generation = data.settings_generation.wrapping_add(1))?;
    window
        .set_size(PhysicalSize::new(rect.width, rect.height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    Ok(window)
}

fn set_settings_visibility(
    app: &AppHandle,
    state: &OverlayState,
    open: bool,
    destroyed: bool,
) -> Result<RuntimeState, String> {
    let runtime = state.snapshot()?;
    if open {
        let window = ensure_settings_window(app, state)?;
        let was_visible = window.is_visible().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let previous_focus = state
            .0
            .lock()
            .map_err(|_| "Overlay state is unavailable")?
            .previous_focus;
        let opened = (|| -> Result<RuntimeState, String> {
            if !was_visible {
                #[cfg(windows)]
                {
                    let previous = unsafe {
                        windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow()
                    } as isize;
                    state.update(|data| data.previous_focus = Some(previous))?;
                }
                let position = window.outer_position().map_err(|e| e.to_string())?;
                let size = window.outer_size().map_err(|e| e.to_string())?;
                let original = WindowRect {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                };
                if let Some(area) = current_work_area(&window)? {
                    let rect = clamp_to_work_area(original, area);
                    if rect != original {
                        window
                            .set_size(PhysicalSize::new(rect.width, rect.height))
                            .map_err(|e| e.to_string())?;
                        window
                            .set_position(PhysicalPosition::new(rect.x, rect.y))
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            apply_policy(&window, WindowPolicy::new(runtime.window_mode, true))?;
            show(&window)?;

            if runtime.settings_open {
                state.snapshot()
            } else {
                state.update(|data| data.runtime.settings_open = true)
            }
        })();
        return match opened {
            Ok(runtime) => Ok(runtime),
            Err(error) => {
                // A failed focus/protection step after show must not leave a new
                // visible popup behind a rejected opening request. An already
                // visible settings window is left in place.
                let rollback = if !was_visible {
                    window.hide().map_err(|e| e.to_string())
                } else {
                    Ok(())
                };
                let visible = window
                    .is_visible()
                    .unwrap_or(was_visible || rollback.is_err());
                let reconciled = state.update(|data| {
                    data.runtime.settings_open = visible;
                    #[cfg(windows)]
                    {
                        data.previous_focus = previous_focus;
                    }
                })?;
                let message = match rollback {
                    Ok(()) => error,
                    Err(rollback) => {
                        format!("{error}. Could not hide settings after failed opening: {rollback}")
                    }
                };
                if visible != was_visible {
                    // If the OS refused rollback, report the actual visible state
                    // so the host renders the popup instead of rolling back to an
                    // empty hidden-dialog view in a still-visible native window.
                    let _ = app.emit("overlay:error", &message);
                    Ok(reconciled)
                } else {
                    Err(message)
                }
            }
        };
    } else if !destroyed {
        if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
            #[cfg(windows)]
            {
                let own = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
                let previous = if runtime.window_mode == WindowMode::Standard {
                    app.get_webview_window("main")
                        .and_then(|main| main.hwnd().ok())
                        .map(|handle| handle.0 as isize)
                } else {
                    state
                        .0
                        .lock()
                        .map_err(|_| "Overlay state is unavailable")?
                        .previous_focus
                };
                // Check ownership before hide, which may itself change foreground.
                restore_external_focus(own, previous);
            }
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    if runtime.settings_open == open {
        if !open {
            #[cfg(windows)]
            {
                state
                    .0
                    .lock()
                    .map_err(|_| "Overlay state is unavailable")?
                    .previous_focus = None;
            }
        }
        return state.snapshot();
    }
    state.update(|data| {
        data.runtime.settings_open = open;
        #[cfg(windows)]
        if !open {
            data.previous_focus = None;
        }
    })
}

pub async fn set_settings_focus(
    app: &AppHandle,
    state: &OverlayState,
    open: bool,
) -> Result<RuntimeState, String> {
    change_settings_visibility(app, state, open, None).await
}

async fn change_settings_visibility(
    app: &AppHandle,
    state: &OverlayState,
    open: bool,
    native_close: Option<(u64, bool)>,
) -> Result<RuntimeState, String> {
    let _operation = state.window_operation().await;
    if let Some((generation, _)) = native_close {
        if state
            .0
            .lock()
            .map_err(|_| "Overlay state is unavailable")?
            .settings_generation
            != generation
        {
            return state.snapshot();
        }
    }
    let worker_app = app.clone();
    let worker_state = state.clone();
    let destroyed = native_close.is_some_and(|(_, destroyed)| destroyed);
    let runtime = tauri::async_runtime::spawn_blocking(move || {
        set_settings_visibility(&worker_app, &worker_state, open, destroyed)
    })
    .await
    .map_err(|e| format!("Settings window operation failed: {e}"))??;
    // Publish the actual visibility while holding the operation lock. The main
    // host reacts to this snapshot; do not echo a second close request.
    if let Err(error) = app.emit("overlay:state", &runtime) {
        // The IPC result still carries the authoritative state. Rejecting a
        // successful show here would make the host hide its UI while the native
        // window stays visible. Native-close cleanup is already complete too.
        eprintln!("Could not broadcast settings visibility: {error}");
    }
    Ok(runtime)
}

pub fn close_settings_from_native(app: &AppHandle, destroyed: bool) -> Result<(), String> {
    let state = app.state::<OverlayState>().inner().clone();
    let generation = state
        .0
        .lock()
        .map_err(|_| "Overlay state is unavailable")?
        .settings_generation;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            change_settings_visibility(&app, &state, false, Some((generation, destroyed))).await
        {
            let _ = app.emit("overlay:error", error);
        }
    });
    Ok(())
}

pub fn drag_window(window: &WebviewWindow, state: &OverlayState) -> Result<(), String> {
    if !matches!(window.label(), "main" | SETTINGS_LABEL) {
        return Err("Window dragging is unavailable".into());
    }
    if window.label() == "main" {
        state.update(|data| data.pointer_generation = data.pointer_generation.wrapping_add(1))?;
    }
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    window.start_dragging().map_err(|e| e.to_string())
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySize {
    pub width: f64,
    pub height: f64,
}

pub fn resize(window: &WebviewWindow, width: f64, height: f64) -> Result<OverlaySize, String> {
    if window.label() != "main" {
        return Err("Only the main overlay can use content resizing".into());
    }
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Overlay dimensions must be finite and positive".into());
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let current_size = window.outer_size().map_err(|error| error.to_string())?;
    let current_pos = window.outer_position().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?);
    let (left, top, max_width, max_height) = monitor
        .map(|monitor| {
            let area = monitor.work_area();
            (
                area.position.x as f64,
                area.position.y as f64,
                area.size.width as f64,
                area.size.height as f64,
            )
        })
        .unwrap_or((0.0, 0.0, 1920.0 * scale, 1080.0 * scale));
    let actual_width = width.clamp(320.0_f64.min(max_width / scale), max_width / scale);
    let actual_height = height.clamp(120.0_f64.min(max_height / scale), max_height / scale);
    let physical_width = actual_width * scale;
    let physical_height = actual_height * scale;
    let center = current_pos.x as f64 + current_size.width as f64 / 2.0;
    let bottom = current_pos.y as f64 + current_size.height as f64;
    let x = (center - physical_width / 2.0).clamp(left, left + max_width - physical_width);
    let y = (bottom - physical_height).clamp(top, top + max_height - physical_height);
    window
        .set_size(LogicalSize::new(actual_width, actual_height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| error.to_string())?;
    Ok(OverlaySize {
        width: actual_width,
        height: actual_height,
    })
}

pub fn initialize(window: &WebviewWindow) -> Result<(), String> {
    let runtime = window.state::<OverlayState>().snapshot()?;
    apply_policy(window, WindowPolicy::new(runtime.window_mode, false))?;
    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        let state = window.state::<OverlayState>();
        match windows::start(window.clone(), state.inner().clone()) {
            Ok(()) => {
                state.update(|data| data.runtime.native_wheel_routing = true)?;
            }
            Err(error) => {
                // Keep the shell operable with ordinary DOM input if the OS refuses the hook.
                window
                    .set_ignore_cursor_events(false)
                    .map_err(|error| error.to_string())?;
                let message = format!(
                    "Native mouse routing is unavailable; using ordinary window input: {error}"
                );
                eprintln!("{message}");
                let _ = window.emit("overlay:error", message);
            }
        }
    }
    // Other platforms use ordinary DOM wheel/interaction until their native routing is implemented.
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::state::HitRects;
    use std::{
        ptr::null_mut,
        sync::{
            mpsc::{sync_channel, SyncSender},
            Arc, Mutex, OnceLock,
        },
        thread,
        time::Duration,
    };
    use tauri::Emitter;
    use windows_sys::Win32::{
        Foundation::{LPARAM, LRESULT, POINT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
        UI::WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, SetWindowsHookExW,
            TranslateMessage, UnhookWindowsHookEx, WindowFromPoint, GA_ROOT, MSG, MSLLHOOKSTRUCT,
            WH_MOUSE_LL, WM_MOUSEWHEEL,
        },
    };

    #[derive(Clone, Default)]
    struct PointerSnapshot {
        rects: HitRects,
        origin_x: f64,
        origin_y: f64,
        scale: f64,
        intercept: bool,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ScrollEvent {
        target: &'static str,
        delta_y: f64,
    }

    struct HookContext {
        pointer: Arc<Mutex<PointerSnapshot>>,
        sender: SyncSender<ScrollEvent>,
    }

    static HOOK: OnceLock<HookContext> = OnceLock::new();

    pub fn clear_interception() {
        if let Some(context) = HOOK.get() {
            if let Ok(mut pointer) = context.pointer.lock() {
                pointer.intercept = false;
            }
        }
    }

    unsafe extern "system" fn wheel_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam == WM_MOUSEWHEEL as WPARAM {
            if let Some(context) = HOOK.get() {
                // Never block a low-level hook or call into the WebView from it.
                if let Ok(snapshot) = context.pointer.try_lock() {
                    if snapshot.intercept && snapshot.scale > 0.0 {
                        let event = &*(lparam as *const MSLLHOOKSTRUCT);
                        let x = (event.pt.x as f64 - snapshot.origin_x) / snapshot.scale;
                        let y = (event.pt.y as f64 - snapshot.origin_y) / snapshot.scale;
                        if let Some(target) = snapshot.rects.panel_at(x, y) {
                            let wheel = (event.mouseData >> 16) as i16;
                            let payload = ScrollEvent {
                                target,
                                delta_y: -(wheel as f64) / 120.0 * 60.0,
                            };
                            if context.sender.try_send(payload).is_ok() {
                                return 1;
                            }
                        }
                    }
                }
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }

    pub fn start(window: WebviewWindow, state: OverlayState) -> Result<(), String> {
        let pointer = Arc::new(Mutex::new(PointerSnapshot::default()));
        let (sender, receiver) = sync_channel(128);
        HOOK.set(HookContext {
            pointer: pointer.clone(),
            sender,
        })
        .map_err(|_| "Mouse routing is already running")?;
        let (ready_sender, ready_receiver) = sync_channel(1);
        thread::Builder::new()
            .name("overlay-wheel-hook".into())
            .spawn(move || unsafe {
                let hook = SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(wheel_hook),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                );
                if hook.is_null() {
                    let _ = ready_sender.send(Err(std::io::Error::last_os_error().to_string()));
                    return;
                }
                let _ = ready_sender.send(Ok(()));
                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                UnhookWindowsHookEx(hook);
            })
            .map_err(|error| error.to_string())?;
        ready_receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())??;

        let events_window = window.clone();
        let events_state = state.clone();
        thread::Builder::new()
            .name("overlay-scroll-events".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    let Ok(data) = events_state.0.lock() else {
                        break;
                    };
                    if data.runtime.window_mode != WindowMode::Overlay || data.runtime.scroll_locked
                    {
                        continue;
                    }
                    if events_window.emit("overlay:scroll", event).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        thread::Builder::new()
            .name("overlay-pointer-routing".into())
            .spawn(move || {
                let mut last_ignore = None;
                let mut last_generation = None;
                let mut left_was_down = false;
                let mut pointer_drag = false;
                loop {
                    let Ok(visible) = window.is_visible() else {
                        break;
                    };
                    let snapshot = state.0.lock().ok().map(|data| {
                        (
                            data.runtime.clone(),
                            data.rects.clone(),
                            data.pointer_generation,
                        )
                    });
                    if let Some((runtime, rects, generation)) = snapshot {
                        if last_generation != Some(generation) {
                            last_ignore = None;
                            last_generation = Some(generation);
                        }
                        if let (Ok(cursor), Ok(origin), Ok(scale)) = (
                            window.cursor_position(),
                            window.inner_position(),
                            window.scale_factor(),
                        ) {
                            let x = (cursor.x - origin.x as f64) / scale;
                            let y = (cursor.y - origin.y as f64) / scale;
                            // Start interactive until the frontend provides geometry, avoiding an inaccessible first frame.
                            let over_interactive = runtime.window_mode == WindowMode::Standard
                                || rects.toolbar.is_none()
                                || rects.interactive_at(x, y);
                            let left_down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0;
                            if left_down && !left_was_down {
                                pointer_drag = over_interactive;
                            }
                            if !left_down {
                                pointer_drag = false;
                            }
                            left_was_down = left_down;
                            // A scrollbar drag remains interactive until release, even
                            // after the cursor leaves its narrow track. A drag begun in
                            // the application underneath must remain click-through.
                            let interactive = if runtime.window_mode == WindowMode::Standard {
                                true
                            } else if left_down {
                                pointer_drag
                            } else {
                                over_interactive
                            };
                            let ignore = visible && !interactive;
                            // Do not intercept wheel messages over the independent settings
                            // WebView, including its child HWNDs. Main input stays active.
                            let over_settings = if runtime.settings_open {
                                window
                                    .app_handle()
                                    .get_webview_window(SETTINGS_LABEL)
                                    .and_then(|settings| settings.hwnd().ok())
                                    .is_some_and(|settings| unsafe {
                                        let pointed = WindowFromPoint(POINT {
                                            x: cursor.x.round() as i32,
                                            y: cursor.y.round() as i32,
                                        });
                                        GetAncestor(pointed, GA_ROOT) as isize
                                            == settings.0 as isize
                                    })
                            } else {
                                false
                            };
                            // Only publish the snapshot while its native policy is current.
                            // Mode transitions hold this same lock while changing OS flags.
                            if let Ok(data) = state.0.lock() {
                                if data.pointer_generation == generation {
                                    if last_ignore != Some(ignore)
                                        && window.set_ignore_cursor_events(ignore).is_ok()
                                    {
                                        last_ignore = Some(ignore);
                                    }
                                    if let Ok(mut pointer) = pointer.lock() {
                                        *pointer = PointerSnapshot {
                                            rects,
                                            origin_x: origin.x as f64,
                                            origin_y: origin.y as f64,
                                            scale,
                                            intercept: visible
                                                && runtime.window_mode == WindowMode::Overlay
                                                && !over_settings
                                                && !runtime.scroll_locked,
                                        };
                                    }
                                }
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_has_own_focus_while_main_keeps_the_selected_window_policy() {
        let standard = WindowPolicy {
            protected: false,
            always_on_top: false,
            skip_taskbar: false,
            focusable: true,
        };
        assert_eq!(WindowPolicy::new(WindowMode::Standard, false), standard);
        assert_eq!(WindowPolicy::new(WindowMode::Standard, true), standard);
        let overlay = WindowPolicy::new(WindowMode::Overlay, false);
        assert!(overlay.protected && overlay.always_on_top && overlay.skip_taskbar);
        assert!(!overlay.focusable);
        assert_eq!(
            WindowPolicy::new(WindowMode::Overlay, true),
            WindowPolicy {
                focusable: true,
                ..overlay
            }
        );
    }

    #[test]
    fn reopened_settings_keeps_position_unless_outside_the_current_work_area() {
        let area = WindowRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let moved = WindowRect {
            x: -1700,
            y: 850,
            width: 1200,
            height: 700,
        };
        assert_eq!(
            clamp_to_work_area(moved, area),
            WindowRect { y: 340, ..moved }
        );
        let beyond_edge = WindowRect {
            x: 400,
            y: -200,
            ..moved
        };
        assert_eq!(
            clamp_to_work_area(beyond_edge, area),
            WindowRect {
                x: -1200,
                y: 0,
                ..moved
            }
        );
        let oversized = WindowRect {
            x: -5000,
            y: 9000,
            width: 4000,
            height: 3000,
        };
        assert_eq!(clamp_to_work_area(oversized, area), area);
    }

    #[test]
    fn initial_settings_geometry_is_independent_and_capped_in_physical_pixels() {
        let area = WindowRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            initial_settings_rect(area, 1.0),
            WindowRect {
                x: 530,
                y: 175,
                width: 860,
                height: 690,
            }
        );
        let left_monitor = WindowRect { x: -1920, ..area };
        assert_eq!(
            initial_settings_rect(left_monitor, 1.0),
            WindowRect {
                x: -1390,
                y: 175,
                width: 860,
                height: 690,
            }
        );
        let small = WindowRect {
            x: 0,
            y: 0,
            width: 1600,
            height: 900,
        };
        assert_eq!(
            initial_settings_rect(small, 1.5),
            WindowRect {
                x: 155,
                y: 0,
                width: 1290,
                height: 900,
            }
        );
        assert_eq!(
            initial_settings_rect(area, f64::NAN),
            initial_settings_rect(area, 1.0)
        );
        let moved = WindowRect {
            x: 200,
            y: 100,
            width: 860,
            height: 690,
        };
        assert_eq!(clamp_to_work_area(moved, area), moved);
    }
}
