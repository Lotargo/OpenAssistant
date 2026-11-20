use super::CaptureSource;
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
    device_state(CaptureSource::Microphone)
}

pub fn system_state() -> InputState {
    device_state(CaptureSource::System)
}

fn supported(source: CaptureSource) -> Result<(), String> {
    if source == CaptureSource::System && !cfg!(windows) {
        Err("Захват системного звука доступен только через WASAPI в Windows.".into())
    } else {
        Ok(())
    }
}

fn device_state(source: CaptureSource) -> InputState {
    match devices(source) {
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

fn default_device(host: &cpal::Host, source: CaptureSource) -> Option<cpal::Device> {
    match source {
        CaptureSource::Microphone => host.default_input_device(),
        CaptureSource::System => host.default_output_device(),
    }
}

fn candidates(host: &cpal::Host, source: CaptureSource) -> Result<Vec<cpal::Device>, String> {
    supported(source)?;
    let devices = match source {
        CaptureSource::Microphone => host.input_devices(),
        CaptureSource::System => host.output_devices(),
    }
    .map_err(|error| {
        format!(
            "Не удалось получить список аудиоустройств ({}): {error}",
            source.label()
        )
    })?;
    Ok(devices.collect())
}

fn devices(source: CaptureSource) -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default = default_device(&host, source).and_then(|device| device.id().ok());
    let mut devices = Vec::new();
    for device in candidates(&host, source)? {
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
                .unwrap_or_else(|_| source.label().into()),
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

pub(super) fn resolve(
    source: CaptureSource,
    selected: Option<&str>,
) -> Result<cpal::Device, String> {
    supported(source)?;
    let host = cpal::default_host();
    match selected {
        Some(value) => {
            let id: cpal::DeviceId = value
                .parse()
                .map_err(|_| "Сохранённое аудиоустройство недоступно. Выбери источник заново.")?;
            candidates(&host, source)?.into_iter()
                .find(|device| device.id().is_ok_and(|found| found == id))
                .ok_or_else(|| format!("Выбранный источник ({}) отключён или недоступен. Подключи его или выбери другой.", source.label()))
        }
        None => default_device(&host, source)
            .ok_or_else(|| format!("Устройство по умолчанию ({}) не найдено.", source.label())),
    }
}

pub(super) fn connected(source: CaptureSource, id: &str) -> bool {
    candidates(&cpal::default_host(), source).is_ok_and(|devices| {
        devices
            .into_iter()
            .any(|device| device.id().is_ok_and(|value| value.to_string() == id))
    })
}
