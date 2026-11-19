use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub revision: u64,
    pub microphone_muted: bool,
    pub screen_capture_enabled: bool,
    pub scroll_locked: bool,
    pub settings_open: bool,
    pub connection_status: &'static str,
    pub platform: &'static str,
    pub native_window: bool,
    pub native_wheel_routing: bool,
    pub audio_available: bool,
    pub screen_capture_available: bool,
    pub live_available: bool,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            revision: 0,
            microphone_muted: true,
            screen_capture_enabled: false,
            scroll_locked: false,
            settings_open: false,
            connection_status: "unavailable",
            platform: std::env::consts::OS,
            native_window: true,
            native_wheel_routing: false,
            audio_available: false,
            screen_capture_available: false,
            live_available: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            && self.width >= 0.0
            && self.height >= 0.0
            && self.width <= 32_768.0
            && self.height <= 32_768.0
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        self.width > 0.0
            && self.height > 0.0
            && x >= self.x
            && x < self.x + self.width
            && y >= self.y
            && y < self.y + self.height
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HitRects {
    pub toolbar: Option<Rect>,
    pub text: Option<Rect>,
    pub code: Option<Rect>,
    pub notes: Option<Rect>,
    pub modal: Option<Rect>,
    pub drag: Option<Rect>,
    pub scrollbars: Vec<Rect>,
}

impl HitRects {
    pub fn validate(&self) -> Result<(), String> {
        if self.scrollbars.len() > 6 {
            return Err("At most six scrollbar rectangles are supported".into());
        }
        if [
            self.toolbar,
            self.text,
            self.code,
            self.notes,
            self.modal,
            self.drag,
        ]
        .into_iter()
        .flatten()
        .chain(self.scrollbars.iter().copied())
        .all(|rect| rect.valid())
        {
            Ok(())
        } else {
            Err("Panel coordinates must be finite and have nonnegative sizes".into())
        }
    }

    pub fn interactive_at(&self, x: f64, y: f64) -> bool {
        [self.toolbar, self.drag]
            .into_iter()
            .flatten()
            .chain(self.scrollbars.iter().copied())
            .any(|rect| rect.contains(x, y))
    }

    pub fn panel_at(&self, x: f64, y: f64) -> Option<&'static str> {
        [
            ("text", self.text),
            ("code", self.code),
            ("notes", self.notes),
        ]
        .into_iter()
        .find(|(_, rect)| rect.is_some_and(|rect| rect.contains(x, y)))
        .map(|(name, _)| name)
    }
}

#[derive(Clone, Copy)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
pub struct OverlayData {
    pub runtime: RuntimeState,
    pub rects: HitRects,
    pub before_settings: Option<WindowRect>,
    #[cfg(windows)]
    pub previous_focus: Option<isize>,
}

#[derive(Clone, Default)]
pub struct OverlayState(pub Arc<Mutex<OverlayData>>);

impl OverlayState {
    pub fn snapshot(&self) -> Result<RuntimeState, String> {
        self.0
            .lock()
            .map(|data| data.runtime.clone())
            .map_err(|_| "Overlay state is unavailable".into())
    }

    pub fn update(&self, update: impl FnOnce(&mut OverlayData)) -> Result<RuntimeState, String> {
        let mut data = self.0.lock().map_err(|_| "Overlay state is unavailable")?;
        update(&mut data);
        data.runtime.revision = data.runtime.revision.saturating_add(1);
        Ok(data.runtime.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_order_concurrent_updates_without_mutating_snapshots() {
        let state = OverlayState::default();
        assert_eq!(state.snapshot().unwrap().revision, 0);
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                std::thread::spawn(move || {
                    state
                        .update(|data| data.runtime.scroll_locked = !data.runtime.scroll_locked)
                        .unwrap()
                        .revision
                })
            })
            .collect();
        let mut revisions: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        revisions.sort_unstable();
        assert_eq!(revisions, (1..=8).collect::<Vec<_>>());
        assert_eq!(state.snapshot().unwrap().revision, 8);
        assert_eq!(state.snapshot().unwrap().revision, 8);
        assert!(!state.snapshot().unwrap().scroll_locked);
    }

    #[test]
    fn adjacent_panels_have_unambiguous_edges() {
        let rects = HitRects {
            code: Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
            notes: Some(Rect {
                x: 100.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
            ..Default::default()
        };
        assert_eq!(rects.panel_at(99.9, 10.0), Some("code"));
        assert_eq!(rects.panel_at(100.0, 10.0), Some("notes"));
        assert_eq!(rects.panel_at(200.0, 10.0), None);
        assert_eq!(rects.panel_at(10.0, 100.0), None);
    }

    #[test]
    fn rejects_invalid_geometry() {
        let mut rects = HitRects::default();
        rects.text = Some(Rect {
            x: f64::NAN,
            ..Default::default()
        });
        assert!(rects.validate().is_err());
        rects.text = Some(Rect {
            width: -1.0,
            ..Default::default()
        });
        assert!(rects.validate().is_err());
    }

    #[test]
    fn only_explicit_scrollbar_tracks_receive_pointer_input() {
        let mut rects = HitRects {
            code: Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            }),
            scrollbars: vec![Rect {
                x: 192.0,
                y: 0.0,
                width: 8.0,
                height: 100.0,
            }],
            ..Default::default()
        };
        assert!(rects.validate().is_ok());
        assert!(!rects.interactive_at(50.0, 50.0));
        assert!(rects.interactive_at(195.0, 50.0));
        rects.scrollbars = vec![Rect::default(); 7];
        assert!(rects.validate().is_err());
        rects.scrollbars = vec![Rect {
            width: f64::INFINITY,
            ..Default::default()
        }];
        assert!(rects.validate().is_err());
    }
}
