//! One non-activating notification surface. The main WebView owns messages;
//! the child owns rendering, while native identity/deadlines own its visibility.
use crate::{
    state::{OverlayState, WindowRect},
    window_stealth,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::{sync::Notify, time::Instant};

pub const LABEL: &str = "notification";
const READY_GRACE: Duration = Duration::from_secs(5);
const EXIT_GRACE: Duration = Duration::from_millis(750);
const WIDTH: f64 = 420.0;
const MAX_HEIGHT: f64 = 200.0;
const MARGIN: f64 = 20.0;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationTheme {
    panel_color: String,
    text_color: String,
    accent_color: String,
    opacity: u8,
    font_size: u8,
}
impl NotificationTheme {
    fn validate(&self) -> Result<(), String> {
        let color = |s: &str| {
            s.len() == 7
                && s.starts_with('#')
                && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        };
        if ![&self.panel_color, &self.text_color, &self.accent_color]
            .into_iter()
            .all(|s| color(s))
            || self.opacity > 100
            || !(12..=22).contains(&self.font_size)
        {
            return Err("Invalid notification appearance".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NotificationKind {
    Info,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Notification {
    id: String,
    message: String,
    kind: NotificationKind,
    timeout: u64,
    theme: NotificationTheme,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 80 && !id.chars().any(char::is_control)
}
impl Notification {
    fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id)
            || self.message.trim().is_empty()
            || self.message.chars().count() > 2000
            || self
                .message
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
            || !(500..=30_000).contains(&self.timeout)
        {
            return Err("Invalid notification id, message or timeout".into());
        }
        self.theme.validate()
    }
}
struct Entry {
    notification: Notification,
    generation: u64,
    presented: bool,
    dismissing: bool,
    deadline: Instant,
}
#[derive(Default)]
struct Data {
    latest: Option<Entry>,
    recent_ids: VecDeque<String>,
    sequence: u64,
    view_epoch: u64,
    ready: bool,
    closed: bool,
}
impl Data {
    fn replace(&mut self, notification: Notification, now: Instant) -> Result<bool, String> {
        if self.closed {
            return Err("Notification window is closed".into());
        }
        if self
            .latest
            .as_ref()
            .is_some_and(|entry| entry.notification.id == notification.id)
        {
            return Ok(false); // An IPC retry cannot renew the timeout.
        }
        if self.recent_ids.contains(&notification.id) {
            return Err("Use a fresh notification id".into());
        }
        self.recent_ids.push_back(notification.id.clone());
        while self.recent_ids.len() > 64 {
            self.recent_ids.pop_front();
        }
        self.sequence = self.sequence.wrapping_add(1);
        self.latest = Some(Entry {
            notification,
            generation: self.sequence,
            presented: false,
            dismissing: false,
            deadline: now + READY_GRACE,
        });
        Ok(true)
    }
    fn snapshot(&self, now: Instant) -> Snapshot {
        Snapshot {
            notification: self
                .latest
                .as_ref()
                .filter(|entry| !entry.dismissing && entry.deadline > now)
                .map(|entry| entry.notification.clone()),
        }
    }
    fn presentable(&self, id: &str, epoch: u64, now: Instant) -> Option<u64> {
        if !self.ready || self.closed || epoch != self.view_epoch {
            return None;
        }
        self.latest
            .as_ref()
            .filter(|entry| {
                entry.notification.id == id && !entry.dismissing && entry.deadline > now
            })
            .map(|entry| entry.generation)
    }
    fn presented(&mut self, generation: u64, now: Instant) {
        if let Some(entry) = self
            .latest
            .as_mut()
            .filter(|entry| entry.generation == generation)
        {
            if !entry.presented {
                entry.presented = true;
                entry.deadline =
                    now + Duration::from_millis(entry.notification.timeout) + EXIT_GRACE;
            }
        }
    }
    fn request_hide(&mut self, id: Option<&str>, now: Instant) -> Option<String> {
        let entry = self
            .latest
            .as_mut()
            .filter(|entry| id.is_none_or(|id| entry.notification.id == id))?;
        if !entry.dismissing {
            entry.dismissing = true;
            entry.deadline = now + EXIT_GRACE;
        }
        Some(entry.notification.id.clone())
    }
    fn matches(&self, id: &str, epoch: u64) -> bool {
        epoch == self.view_epoch
            && self
                .latest
                .as_ref()
                .is_some_and(|entry| entry.notification.id == id)
    }
    fn expire(&mut self, generation: u64, now: Instant) -> bool {
        if self
            .latest
            .as_ref()
            .is_some_and(|entry| entry.generation == generation && entry.deadline <= now)
        {
            self.latest = None;
            true
        } else {
            false
        }
    }
    fn page_started(&mut self) {
        self.view_epoch = self.view_epoch.wrapping_add(1);
        self.ready = false;
        // Keep an early first-show request. Reloading a previously shown card must
        // never renew its timeout or replay a stale dismissal into a new document.
        if self
            .latest
            .as_ref()
            .is_some_and(|entry| entry.presented || entry.dismissing)
        {
            self.latest = None;
        }
    }
}
#[derive(Clone, Default)]
pub struct Notifications {
    data: Arc<Mutex<Data>>,
    wake: Arc<Notify>,
}
impl Notifications {
    fn epoch(&self) -> Result<u64, String> {
        self.data
            .lock()
            .map(|data| data.view_epoch)
            .map_err(|_| "Notification state is unavailable".into())
    }
    pub fn shutdown(&self) {
        if let Ok(mut data) = self.data.lock() {
            data.closed = true;
            data.latest = None;
        }
        self.wake.notify_one();
    }
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    notification: Option<Notification>,
}
#[derive(Clone, Copy, Default, Serialize)]
pub struct Presentation {
    shown: bool,
    width: f64,
    height: f64,
    x: i32,
    y: i32,
}
#[derive(Clone, Copy)]
enum Role {
    Main,
    Child,
}
fn check_role(label: &str, role: Role) -> Result<(), String> {
    let expected = match role {
        Role::Main => "main",
        Role::Child => LABEL,
    };
    if label == expected {
        Ok(())
    } else {
        Err("This window does not own notification operations".into())
    }
}
async fn on_ui<T, F>(app: AppHandle, action: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(action(&target));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Notification window operation was cancelled".to_owned())?
}
fn show_native(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        // Tao removes the initial focused(false) marker after creation and its
        // later show() uses SW_SHOW. This private popup keeps visibility under
        // Win32 ownership so showing it can never activate it.
        let shown = unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        if shown == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    window.show().map_err(|error| error.to_string())
}
fn hide_native(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                IsWindowVisible, ShowWindow, SW_HIDE,
            };
            let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
            }
            if unsafe { IsWindowVisible(hwnd) } != 0 {
                return Err("Could not hide notification window".into());
            }
        }
        #[cfg(not(windows))]
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn notification_rect(area: WindowRect, scale: f64, height: f64) -> Result<WindowRect, String> {
    if !scale.is_finite()
        || scale <= 0.0
        || !height.is_finite()
        || height <= 0.0
        || area.width == 0
        || area.height == 0
    {
        return Err("Notification monitor geometry is unavailable".into());
    }
    let margin_x = (MARGIN * scale)
        .round()
        .min(area.width.saturating_sub(1) as f64 / 2.0) as u32;
    let margin_y = (MARGIN * scale)
        .round()
        .min(area.height.saturating_sub(1) as f64 / 2.0) as u32;
    let width = ((WIDTH * scale).round() as u32)
        .min(area.width - 2 * margin_x)
        .max(1);
    let height = ((height.clamp(40.0, MAX_HEIGHT) * scale).round() as u32)
        .min(area.height - 2 * margin_y)
        .max(1);
    let x = (area.x as i64 + area.width as i64 - margin_x as i64 - width as i64)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let y = (area.y as i64 + area.height as i64 - margin_y as i64 - height as i64)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    Ok(WindowRect {
        x,
        y,
        width,
        height,
    })
}

#[tauri::command]
pub async fn notification_show(
    window: WebviewWindow,
    notification: Notification,
) -> Result<(), String> {
    check_role(window.label(), Role::Main)?;
    notification.validate()?;
    on_ui(window.app_handle().clone(), move |app| {
        if app.get_webview_window(LABEL).is_none() {
            return Err("Notification window is unavailable".into());
        }
        let state = app.state::<Notifications>();
        let ready = {
            let mut data = state
                .data
                .lock()
                .map_err(|_| "Notification state is unavailable")?;
            if !data.replace(notification.clone(), Instant::now())? {
                return Ok(());
            }
            data.ready
        };
        state.wake.notify_one();
        if ready {
            app.emit_to(LABEL, "notification:update", notification)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn notification_hide(window: WebviewWindow, id: Option<String>) -> Result<(), String> {
    check_role(window.label(), Role::Main)?;
    if id.as_ref().is_some_and(|id| !valid_id(id)) {
        return Err("Invalid notification id".into());
    }
    on_ui(window.app_handle().clone(), move |app| {
        let state = app.state::<Notifications>();
        let current = state
            .data
            .lock()
            .map_err(|_| "Notification state is unavailable")?
            .request_hide(id.as_deref(), Instant::now());
        state.wake.notify_one();
        if let Some(id) = current {
            app.emit_to(LABEL, "notification:hide", serde_json::json!({"id":id}))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn notification_theme(
    window: WebviewWindow,
    theme: NotificationTheme,
) -> Result<(), String> {
    check_role(window.label(), Role::Main)?;
    theme.validate()?;
    on_ui(window.app_handle().clone(), move |app| {
        let state = app.state::<Notifications>();
        let ready = {
            let mut data = state
                .data
                .lock()
                .map_err(|_| "Notification state is unavailable")?;
            if let Some(entry) = &mut data.latest {
                entry.notification.theme = theme.clone();
            }
            data.ready
        };
        if ready {
            app.emit_to(
                LABEL,
                "notification:theme",
                serde_json::json!({"theme":theme}),
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn notification_ready(
    window: WebviewWindow,
    state: State<'_, Notifications>,
) -> Result<Snapshot, String> {
    check_role(window.label(), Role::Child)?;
    let epoch = state.epoch()?;
    on_ui(window.app_handle().clone(), move |app| {
        let state = app.state::<Notifications>();
        let mut data = state
            .data
            .lock()
            .map_err(|_| "Notification state is unavailable")?;
        if data.view_epoch != epoch || data.closed {
            return Ok(Snapshot { notification: None });
        }
        data.ready = true;
        Ok(data.snapshot(Instant::now()))
    })
    .await
}
#[tauri::command]
pub async fn notification_present(
    window: WebviewWindow,
    state: State<'_, Notifications>,
    overlay: State<'_, OverlayState>,
    id: String,
    height: Option<f64>,
) -> Result<Presentation, String> {
    check_role(window.label(), Role::Child)?;
    if !valid_id(&id) {
        return Err("Invalid notification id".into());
    }
    let epoch = state.epoch()?;
    // Same lock as a mode change. Privacy cannot be overtaken between its snapshot
    // and show; no data mutex is held while waiting for the UI thread.
    let _operation = overlay.window_operation().await;
    on_ui(window.app_handle().clone(), move |app| {
        let state = app.state::<Notifications>();
        let generation = state
            .data
            .lock()
            .map_err(|_| "Notification state is unavailable")?
            .presentable(&id, epoch, Instant::now());
        let Some(generation) = generation else {
            return Ok(Presentation::default());
        };
        let mode = app.state::<OverlayState>().snapshot()?.window_mode;
        let main = app
            .get_webview_window("main")
            .ok_or("Main window is unavailable")?;
        let area =
            window_stealth::current_work_area(&main)?.ok_or("Monitor work area is unavailable")?;
        let scale = main.scale_factor().map_err(|error| error.to_string())?;
        let rect = notification_rect(area, scale, height.unwrap_or(120.0))?;
        let child = app
            .get_webview_window(LABEL)
            .ok_or("Notification window is unavailable")?;
        let result = (|| {
            window_stealth::apply_notification_policy(&child, mode)?;
            child
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|error| error.to_string())?;
            child
                .set_size(PhysicalSize::new(rect.width, rect.height))
                .map_err(|error| error.to_string())?;
            show_native(&child)?;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let _ = hide_native(app);
            return Err(error);
        }
        state
            .data
            .lock()
            .map_err(|_| "Notification state is unavailable")?
            .presented(generation, Instant::now());
        state.wake.notify_one();
        Ok(Presentation {
            shown: true,
            width: rect.width as f64 / scale,
            height: rect.height as f64 / scale,
            x: rect.x,
            y: rect.y,
        })
    })
    .await
}
#[tauri::command]
pub async fn notification_dismissed(
    window: WebviewWindow,
    state: State<'_, Notifications>,
    id: String,
) -> Result<bool, String> {
    check_role(window.label(), Role::Child)?;
    if !valid_id(&id) {
        return Err("Invalid notification id".into());
    }
    let epoch = state.epoch()?;
    on_ui(window.app_handle().clone(), move |app| {
        let state = app.state::<Notifications>();
        if !state
            .data
            .lock()
            .map_err(|_| "Notification state is unavailable")?
            .matches(&id, epoch)
        {
            return Ok(false);
        }
        hide_native(app)?;
        state
            .data
            .lock()
            .map_err(|_| "Notification state is unavailable")?
            .latest = None;
        state.wake.notify_one();
        Ok(true)
    })
    .await
}

pub fn page_started(app: &AppHandle) {
    let state = app.state::<Notifications>();
    if let Ok(mut data) = state.data.lock() {
        data.page_started();
    }
    let _ = hide_native(app);
    state.wake.notify_one();
}
pub fn closed_from_native(app: &AppHandle) {
    let state = app.state::<Notifications>();
    if let Ok(mut data) = state.data.lock() {
        data.latest = None;
    }
    let _ = hide_native(app);
    state.wake.notify_one();
}
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let mode = app.state::<OverlayState>().snapshot()?.window_mode;
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notification.html".into()))
        .title("OpenAssistant Notification")
        .inner_size(WIDTH, 120.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .background_color(tauri::utils::config::Color(0, 0, 0, 0))
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .content_protected(mode == crate::state::WindowMode::Overlay)
        .build()
        .map_err(|error| error.to_string())?;
    window_stealth::apply_notification_policy(&window, mode)?;
    let state = app.state::<Notifications>().inner().clone();
    let app = app.clone();
    // One worker and one latest entry, regardless of notification frequency.
    tauri::async_runtime::spawn(async move {
        loop {
            let wake = state.wake.notified();
            let next = match state.data.lock() {
                Ok(data) if !data.closed => data
                    .latest
                    .as_ref()
                    .map(|entry| (entry.generation, entry.deadline)),
                _ => break,
            };
            if let Some((generation, deadline)) = next {
                tokio::select! {
                    _ = wake => continue,
                    _ = tokio::time::sleep_until(deadline) => {},
                }
                let result = on_ui(app.clone(), move |app| {
                    let state = app.state::<Notifications>();
                    let expired = {
                        let data = state
                            .data
                            .lock()
                            .map_err(|_| "Notification state is unavailable")?;
                        data.latest.as_ref().is_some_and(|entry| {
                            entry.generation == generation && entry.deadline <= Instant::now()
                        })
                    };
                    if !expired {
                        return Ok(());
                    }
                    if let Err(error) = hide_native(app) {
                        if let Ok(mut data) = state.data.lock() {
                            if let Some(entry) = data
                                .latest
                                .as_mut()
                                .filter(|entry| entry.generation == generation)
                            {
                                entry.deadline = Instant::now() + EXIT_GRACE;
                            }
                        }
                        return Err(error);
                    }
                    state
                        .data
                        .lock()
                        .map_err(|_| "Notification state is unavailable")?
                        .expire(generation, Instant::now());
                    Ok(())
                })
                .await;
                if let Err(error) = result {
                    eprintln!("Notification cleanup failed: {error}");
                }
            } else {
                wake.await;
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notification(id: &str) -> Notification {
        Notification {
            id: id.into(),
            message: "A bounded notification".into(),
            kind: NotificationKind::Info,
            timeout: 3000,
            theme: NotificationTheme {
                panel_color: "#18181b".into(),
                text_color: "#eeeeee".into(),
                accent_color: "#5f93ff".into(),
                opacity: 75,
                font_size: 14,
            },
        }
    }
    #[test]
    fn first_ready_delivers_only_latest_and_old_identity_cannot_hide_or_expire_it() {
        let now = Instant::now();
        let mut data = Data::default();
        data.replace(notification("first"), now).unwrap();
        let old_generation = data.latest.as_ref().unwrap().generation;
        data.page_started(); // First page creation may race the initial main request.
        data.replace(notification("second"), now).unwrap();
        data.ready = true;
        assert_eq!(data.snapshot(now).notification.unwrap().id, "second");
        assert!(data.presentable("first", data.view_epoch, now).is_none());
        assert!(!data.matches("first", data.view_epoch));
        assert!(data.request_hide(Some("first"), now).is_none());
        assert!(!data.expire(old_generation, now + Duration::from_secs(90)));
        assert_eq!(data.latest.as_ref().unwrap().notification.id, "second");
    }
    #[test]
    fn theme_resize_retry_and_replacement_never_renew_an_existing_timeout() {
        let now = Instant::now();
        let mut data = Data {
            ready: true,
            ..Default::default()
        };
        data.replace(notification("one"), now).unwrap();
        let generation = data.presentable("one", 0, now).unwrap();
        data.presented(generation, now);
        let deadline = data.latest.as_ref().unwrap().deadline;
        data.latest.as_mut().unwrap().notification.theme.opacity = 10;
        data.presented(generation, now + Duration::from_secs(2));
        assert!(!data
            .replace(notification("one"), now + Duration::from_secs(2))
            .unwrap());
        assert_eq!(data.latest.as_ref().unwrap().deadline, deadline);
        data.replace(notification("two"), now + Duration::from_secs(2))
            .unwrap();
        assert!(!data.expire(generation, deadline));
        assert_eq!(data.latest.as_ref().unwrap().notification.id, "two");
    }
    #[test]
    fn hide_invalidates_pending_present_and_fallback_is_bounded_without_child_ack() {
        let now = Instant::now();
        let mut data = Data {
            ready: true,
            ..Default::default()
        };
        data.replace(notification("one"), now).unwrap();
        let generation = data.latest.as_ref().unwrap().generation;
        assert_eq!(data.request_hide(None, now).unwrap(), "one");
        assert!(data.presentable("one", 0, now).is_none());
        assert!(data.snapshot(now).notification.is_none());
        assert!(!data.expire(generation, now + EXIT_GRACE - Duration::from_millis(1)));
        assert!(data.expire(generation, now + EXIT_GRACE));
        assert!(data.latest.is_none());
        data.replace(notification("unready"), now).unwrap();
        let generation = data.latest.as_ref().unwrap().generation;
        assert!(data.expire(generation, now + READY_GRACE));
    }
    #[test]
    fn page_reload_fences_old_commands_and_does_not_replay_a_visible_card() {
        let now = Instant::now();
        let mut data = Data {
            ready: true,
            ..Default::default()
        };
        data.replace(notification("one"), now).unwrap();
        let epoch = data.view_epoch;
        let generation = data.presentable("one", epoch, now).unwrap();
        data.presented(generation, now);
        data.page_started();
        assert!(!data.ready);
        assert!(data.latest.is_none());
        data.replace(notification("two"), now).unwrap();
        data.ready = true;
        assert!(data.presentable("two", epoch, now).is_none());
        assert!(!data.matches("two", epoch));
        assert!(data.presentable("two", data.view_epoch, now).is_some());
    }
    #[test]
    fn notification_memory_is_latest_only_with_bounded_recent_identity_history() {
        let now = Instant::now();
        let mut data = Data::default();
        for id in 0..1000 {
            data.replace(notification(&format!("toast-{id}")), now)
                .unwrap();
        }
        assert_eq!(data.recent_ids.len(), 64);
        assert_eq!(data.latest.as_ref().unwrap().notification.id, "toast-999");
        assert!(data.replace(notification("toast-998"), now).is_err());
    }
    #[test]
    fn geometry_uses_work_area_dpi_and_clamps_small_or_negative_monitors() {
        let area = WindowRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            notification_rect(area, 1.0, 120.0).unwrap(),
            WindowRect {
                x: 1480,
                y: 900,
                width: 420,
                height: 120
            }
        );
        let left = WindowRect {
            x: -2560,
            y: 100,
            width: 2560,
            height: 1400,
        };
        assert_eq!(
            notification_rect(left, 1.5, 120.0).unwrap(),
            WindowRect {
                x: -660,
                y: 1290,
                width: 630,
                height: 180
            }
        );
        let small = WindowRect {
            x: -100,
            y: -100,
            width: 200,
            height: 100,
        };
        let rect = notification_rect(small, 2.0, 10000.0).unwrap();
        assert!(rect.x >= small.x && rect.y >= small.y);
        assert!(rect.x as i64 + rect.width as i64 <= small.x as i64 + small.width as i64);
        assert!(rect.y as i64 + rect.height as i64 <= small.y as i64 + small.height as i64);
        assert!(notification_rect(area, f64::NAN, 100.0).is_err());
        assert!(notification_rect(area, 1.0, f64::INFINITY).is_err());
    }
    #[test]
    fn only_main_publishes_and_only_the_notification_child_acknowledges() {
        assert!(check_role("main", Role::Main).is_ok());
        assert!(check_role(LABEL, Role::Child).is_ok());
        for label in ["settings", "other", LABEL] {
            assert!(check_role(label, Role::Main).is_err());
        }
        for label in ["main", "settings", "other"] {
            assert!(check_role(label, Role::Child).is_err());
        }
    }
    #[test]
    fn untrusted_lengths_timeouts_and_css_values_are_rejected() {
        let mut value = notification("valid");
        assert!(value.validate().is_ok());
        value.theme.panel_color = "url(https://example.invalid)".into();
        assert!(value.validate().is_err());
        value = notification("valid");
        value.timeout = 30001;
        assert!(value.validate().is_err());
        value.timeout = 499;
        assert!(value.validate().is_err());
        value = notification("valid");
        value.message = "x".repeat(2001);
        assert!(value.validate().is_err());
        assert!(!valid_id(&"x".repeat(81)));
        assert!(!valid_id("bad\nid"));
    }
}
