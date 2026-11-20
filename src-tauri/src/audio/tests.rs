use super::*;
fn fake_worker(id: u64, mode: CaptureMode) -> Arc<Worker> {
    let control = Arc::new(Control::default());
    control.live.store(true, Ordering::Release);
    let worker_control = control.clone();
    let thread = thread::spawn(move || {
        while worker_control.stop.load(Ordering::Acquire) == 0 {
            thread::sleep(Duration::from_millis(1));
        }
        worker_control.live.store(false, Ordering::Release);
    });
    Arc::new(Worker {
        id,
        mode,
        control,
        thread: Mutex::new(Some(thread)),
    })
}

#[test]
fn stale_stop_does_not_stop_new_capture_and_test_invalidation_preserves_stream() {
    let state = AudioState::default();
    let stream = fake_worker(100, CaptureMode::Stream);
    let test = fake_worker(101, CaptureMode::Test);
    {
        let mut slots = lock(&state.inner.slots);
        slots.current = Some(stream.clone());
        slots.starting = Some(test.clone());
    }
    state.stop(Some(99)).unwrap();
    assert_eq!(stream.control.stop.load(Ordering::Acquire), 0);
    state.invalidate_test();
    test.join().unwrap();
    assert!(!test.control.live.load(Ordering::Acquire));
    assert_eq!(stream.control.stop.load(Ordering::Acquire), 0);
    assert_eq!(lock(&state.inner.slots).current.as_ref().unwrap().id, 100);
    state.stop(Some(100)).unwrap();
    assert!(!stream.control.live.load(Ordering::Acquire));
    state.stop(None).unwrap();
}

#[test]
fn full_invalidation_cancels_current_and_pending_before_join() {
    let state = AudioState::default();
    let current = fake_worker(200, CaptureMode::Stream);
    let pending = fake_worker(201, CaptureMode::Stream);
    {
        let mut slots = lock(&state.inner.slots);
        slots.current = Some(current.clone());
        slots.starting = Some(pending.clone());
    }
    let epoch = state.inner.epoch.load(Ordering::Acquire);
    state.invalidate();
    assert_ne!(state.inner.epoch.load(Ordering::Acquire), epoch);
    assert_eq!(current.control.stop.load(Ordering::Acquire), DISCARD);
    assert_eq!(pending.control.stop.load(Ordering::Acquire), DISCARD);
    state.stop(None).unwrap();
    assert!(!current.control.live.load(Ordering::Acquire));
    assert!(!pending.control.live.load(Ordering::Acquire));
}

#[test]
fn packets_are_bounded_little_endian_and_stop_flushes_the_last_samples() {
    let mut packets = Packetizer::new();
    let samples: Vec<i16> = (0..5001).map(|i| (i % 32768) as i16).collect();
    let mut frames = Vec::new();
    assert!(packets.push(&samples, &mut |frame| {
        frames.push(frame);
        true
    }));
    assert!(packets.flush(&mut |frame| {
        frames.push(frame);
        true
    }));
    assert_eq!(
        frames.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![4800, 4800, 402]
    );
    let restored: Vec<_> = frames
        .concat()
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    assert_eq!(restored, samples);
}

#[test]
fn test_mode_feeds_levels_but_never_emits_pcm() {
    let mut processor = Processor::new(48000, false);
    let mut packets = Packetizer::new();
    let events = Mutex::new(Vec::new());
    let send = |event| {
        lock(&events).push(event);
        true
    };
    assert!(emit_captured(
        Captured {
            mono: vec![0.1; 4800],
            peak: 0.1,
            clipped: 0,
            samples: 4800
        },
        &mut processor,
        &mut packets,
        CaptureMode::Test,
        1,
        &send
    ));
    let events = lock(&events);
    assert!(events
        .iter()
        .any(|e| matches!(e, AudioEvent::Levels { .. })));
    assert!(!events.iter().any(|e| matches!(e, AudioEvent::Pcm { .. })));
    assert!(packets.samples.is_empty());
}

#[test]
fn queued_test_ticket_is_cancelled_before_any_native_device_access() {
    let state = AudioState::default();
    let ticket = state.start_ticket(CaptureMode::Test);
    let stream_ticket = state.start_ticket(CaptureMode::Stream);
    state.invalidate_test();
    assert!(stream_ticket.valid(&state.inner, CaptureMode::Stream));
    let result = state.start_with_ticket(
        AudioConfig {
            device_id: Some("not-a-real-input-id".into()),
            mode: CaptureMode::Test,
            noise_suppression: false,
        },
        ticket,
        |_| panic!("Cancelled test must not produce capture events"),
    );
    assert!(result.unwrap_err().contains("отменён"));
    let slots = lock(&state.inner.slots);
    assert!(slots.starting.is_none() && slots.current.is_none() && slots.retired.is_empty());
}
#[test]
fn malformed_device_selection_is_rejected_without_opening_a_microphone() {
    assert!(AudioState::default()
        .start(
            AudioConfig {
                device_id: Some(String::new()),
                mode: CaptureMode::Test,
                noise_suppression: false,
            },
            |_| panic!("Invalid device must not capture")
        )
        .is_err());
}

#[test]
fn noise_toggle_changes_only_current_worker_without_restarting_test() {
    let state = AudioState::default();
    let current = fake_worker(300, CaptureMode::Test);
    let pending = fake_worker(301, CaptureMode::Test);
    {
        let mut slots = lock(&state.inner.slots);
        slots.current = Some(current.clone());
        slots.starting = Some(pending.clone());
    }
    let ticket = state.start_ticket(CaptureMode::Test);
    assert!(state.set_noise_suppression(299, true).is_err());
    assert!(state.set_noise_suppression(301, true).is_err());
    state.set_noise_suppression(300, true).unwrap();
    assert!(current.control.noise_suppression.load(Ordering::Acquire));
    assert!(!pending.control.noise_suppression.load(Ordering::Acquire));
    assert_eq!(current.control.stop.load(Ordering::Acquire), 0);
    assert!(current.control.live.load(Ordering::Acquire));
    assert!(ticket.valid(&state.inner, CaptureMode::Test));
    assert!(Arc::ptr_eq(
        lock(&state.inner.slots).current.as_ref().unwrap(),
        &current
    ));
    state.set_noise_suppression(300, false).unwrap();
    assert!(!current.control.noise_suppression.load(Ordering::Acquire));
    state.invalidate_test();
    assert!(state.set_noise_suppression(300, true).is_err());
    state.stop(None).unwrap();
}

#[test]
fn live_dsp_toggle_drains_old_audio_and_keeps_bounded_24k_output() {
    let mut processor = Processor::new(48000, false);
    let signal: Vec<_> = (0..4800)
        .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / 48000.0).sin() * 0.5)
        .collect();
    let mut output = Vec::new();
    for enabled in [false, true, false, true] {
        output.extend(processor.set_noise_suppression(enabled));
        assert!(processor.set_noise_suppression(enabled).is_empty());
        let (samples, levels) = processor.push(Captured {
            mono: signal.clone(),
            peak: 0.5,
            clipped: 0,
            samples: signal.len(),
        });
        assert_eq!(samples.len(), 2400);
        output.extend(samples);
        let levels = levels.unwrap();
        assert_eq!(levels.input_peak, 0.5);
        assert!(levels.rms.is_finite());
        assert!(levels.raw_rms > 0.3);
    }
    output.extend(processor.finish());
    assert!(
        (9600..11600).contains(&output.len()),
        "Switches must preserve the audio duration plus bounded filter tails"
    );
    assert!(output.iter().any(|value| *value != 0));
}

#[test]
fn cpal_advisories_preserve_capture_but_real_failures_keep_diagnostics() {
    for kind in [cpal::ErrorKind::Xrun, cpal::ErrorKind::RealtimeDenied] {
        assert!(terminal_stream_error(&cpal::Error::new(kind)).is_none());
    }
    for kind in [
        cpal::ErrorKind::DeviceNotAvailable,
        cpal::ErrorKind::PermissionDenied,
        cpal::ErrorKind::StreamInvalidated,
        cpal::ErrorKind::BackendError,
        cpal::ErrorKind::Other,
    ] {
        let cause = cpal::Error::with_message(kind, "WASAPI diagnostic HRESULT 0x88890004");
        let message = terminal_stream_error(&cause).expect("Real failure must stop capture");
        assert!(message.contains("0x88890004"));
        assert!(message.contains(&format!("{kind:?}")));
    }
}
