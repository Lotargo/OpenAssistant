use crate::state::OverlayState;
use serde::Serialize;
#[cfg(windows)]
use tauri::{Emitter, Manager};
use tauri::{LogicalSize, PhysicalPosition, WebviewWindow};

pub fn protect(window: &WebviewWindow) -> Result<(), String> {
    // Linux does not implement exclusion from capture. Do not imply protection there.
    #[cfg(any(windows, target_os = "macos"))]
    window
        .set_content_protected(true)
        .map_err(|error| error.to_string())?;
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = window;
    Ok(())
}

pub fn show(window: &WebviewWindow) -> Result<(), String> {
    protect(window)?;
    window.show().map_err(|error| error.to_string())?;
    protect(window)
}

pub fn toggle_visibility(window: &WebviewWindow) -> Result<(), String> {
    if window.is_visible().map_err(|error| error.to_string())? {
        window.hide().map_err(|error| error.to_string())?;
        protect(window)
    } else {
        show(window)
    }
}

pub fn set_settings_focus(
    window: &WebviewWindow,
    state: &OverlayState,
    open: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    if open && !state.snapshot()?.settings_open {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        // A handle is kept only to return focus after the explicitly focused modal closes.
        let foreground = unsafe { GetForegroundWindow() } as isize;
        state.update(|data| data.previous_focus = Some(foreground))?;
    }

    window
        .set_focusable(open)
        .map_err(|error| error.to_string())?;
    if open {
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        show(window)?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    state.update(|data| data.runtime.settings_open = open)?;

    #[cfg(windows)]
    if !open {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, IsWindow, SetForegroundWindow,
        };
        let own = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let previous = state
            .0
            .lock()
            .map_err(|_| "Overlay state is unavailable")?
            .previous_focus
            .take();
        if let Some(previous) = previous.filter(|previous| *previous != 0 && *previous != own) {
            // Do not steal focus back if the user switched to another app while settings were open.
            unsafe {
                if GetForegroundWindow() as isize == own && IsWindow(previous as _) != 0 {
                    SetForegroundWindow(previous as _);
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySize {
    pub width: f64,
    pub height: f64,
}

pub fn resize(window: &WebviewWindow, width: f64, height: f64) -> Result<OverlaySize, String> {
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
    protect(window)?;
    window
        .set_focusable(false)
        .map_err(|error| error.to_string())?;
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
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_MOUSEWHEEL,
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
        thread::Builder::new()
            .name("overlay-scroll-events".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
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
                loop {
                    let Ok(visible) = window.is_visible() else {
                        break;
                    };
                    let snapshot = state
                        .0
                        .lock()
                        .ok()
                        .map(|data| (data.runtime.clone(), data.rects.clone()));
                    if let Some((runtime, rects)) = snapshot {
                        if let (Ok(cursor), Ok(origin), Ok(scale)) = (
                            window.cursor_position(),
                            window.inner_position(),
                            window.scale_factor(),
                        ) {
                            let x = (cursor.x - origin.x as f64) / scale;
                            let y = (cursor.y - origin.y as f64) / scale;
                            // Start interactive until the frontend provides geometry, avoiding an inaccessible first frame.
                            let interactive = runtime.settings_open
                                || rects.toolbar.is_none()
                                || [rects.toolbar, rects.drag]
                                    .into_iter()
                                    .flatten()
                                    .any(|rect| rect.contains(x, y));
                            let ignore = visible && !interactive;
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
                                        && !runtime.settings_open
                                        && !runtime.scroll_locked,
                                };
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
