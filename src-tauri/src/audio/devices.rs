use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct InputState {
    pub devices: Vec<InputDevice>,
    pub available: bool,
    pub error: Option<String>,
}

pub fn input_state() -> InputState {
    match devices() {
        Ok(devices) => InputState {
            available: !devices.is_empty(),
            devices,
            error: None,
        },
        Err(error) => InputState {
            available: false,
            devices: vec![],
            error: Some(error),
        },
    }
}

fn devices() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default = host
        .default_input_device()
        .and_then(|device| device.id().ok());
    let mut devices = Vec::new();
    for device in host
        .input_devices()
        .map_err(|error| format!("Не удалось получить список микрофонов Windows: {error}"))?
    {
        let id = match device.id() {
            Ok(id) => id,
            Err(_) => continue,
        };
        devices.push(InputDevice {
            is_default: default.as_ref() == Some(&id),
            id: id.to_string(),
            name: device
                .description()
                .map(|d| d.name().to_owned())
                .unwrap_or_else(|_| "Микрофон".into()),
        });
    }
    devices.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then(a.name.cmp(&b.name))
            .then(a.id.cmp(&b.id))
    });
    Ok(devices)
}

pub(super) fn resolve(selected: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    match selected {
        Some(value) => {
            let id: cpal::DeviceId = value
                .parse()
                .map_err(|_| "Сохранённый микрофон недоступен. Выбери устройство заново.")?;
            host.input_devices()
                .map_err(|error| format!("Не удалось проверить микрофон: {error}"))?
                .find(|device| device.id().is_ok_and(|found| found == id))
                .ok_or_else(|| {
                    "Выбранный микрофон отключён или недоступен. Подключи его или выбери другой."
                        .into()
                })
        }
        None => host
            .default_input_device()
            .ok_or_else(|| "Системный микрофон Windows не найден.".into()),
    }
}

pub(super) fn connected(id: &str) -> bool {
    cpal::default_host()
        .input_devices()
        .is_ok_and(|mut devices| {
            devices.any(|device| device.id().is_ok_and(|value| value.to_string() == id))
        })
}
