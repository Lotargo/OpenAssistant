use super::*;
use std::sync::{Barrier, atomic::AtomicUsize};

fn vector(index: usize) -> SpeakerVector {
    let mut spk = vec![0.0; VECTOR_SIZE];
    spk[index] = 1.0;
    SpeakerVector {
        spk,
        spk_frames: 500,
    }
}

fn utterance(id: &str) -> SpeakerUtterance {
    SpeakerUtterance {
        item_id: id.into(),
        start_ms: 0,
        end_ms: 0,
        pcm: vec![],
        known_overlap: false,
    }
}

#[test]
fn anonymous_profiles_distinguish_evidence_and_reset_each_epoch() {
    let mut first = Profiles::default();
    assert_eq!(
        first.assign(vector(0)).speaker_id.as_deref(),
        Some("anonymous-1")
    );
    assert_eq!(
        first.assign(vector(1)).speaker_id.as_deref(),
        Some("anonymous-2")
    );
    let matched = first.assign(vector(0));
    assert_eq!(matched.speaker_id.as_deref(), Some("anonymous-1"));
    assert!(matched.similarity.unwrap() > 0.99);
    let mut next_epoch = Profiles::default();
    assert_eq!(
        next_epoch.assign(vector(1)).speaker_id.as_deref(),
        Some("anonymous-1")
    );
}

#[test]
fn close_competing_profiles_and_intermediate_distances_stay_unknown() {
    let mut profiles = Profiles::default();
    profiles.assign(vector(0));
    let mut other = vector(0);
    other.spk[0] = 0.5;
    other.spk[1] = 0.75_f32.sqrt();
    assert_eq!(
        profiles.assign(other).speaker_id.as_deref(),
        Some("anonymous-2")
    );
    let before = profiles
        .entries
        .iter()
        .map(|p| p.observations)
        .collect::<Vec<_>>();
    let mut between = vector(0);
    between.spk[0] = 0.75_f32.sqrt();
    between.spk[1] = 0.5;
    assert!(profiles.assign(between).speaker_id.is_none());
    assert_eq!(
        before,
        profiles
            .entries
            .iter()
            .map(|p| p.observations)
            .collect::<Vec<_>>()
    );
    let mut ambiguous_new = vector(0);
    ambiguous_new.spk[0] = 0.7;
    ambiguous_new.spk[2] = (1.0_f32 - 0.49).sqrt();
    assert!(profiles.assign(ambiguous_new).speaker_id.is_none());
    assert_eq!(profiles.entries.len(), 2);
}

#[test]
fn short_invalid_and_nonfinite_vectors_never_seed_profiles() {
    let mut profiles = Profiles::default();
    let mut short = vector(0);
    short.spk_frames = MIN_SPEECH_FRAMES - 1;
    assert!(profiles.assign(short).speaker_id.is_none());
    for spk in [
        vec![],
        vec![0.0; VECTOR_SIZE],
        vec![f32::NAN; VECTOR_SIZE],
        vec![f32::INFINITY; VECTOR_SIZE],
        vec![1.0; VECTOR_SIZE - 1],
    ] {
        assert!(
            profiles
                .assign(SpeakerVector {
                    spk,
                    spk_frames: 800
                })
                .speaker_id
                .is_none()
        );
    }
    assert!(profiles.entries.is_empty());
}

#[test]
fn profiles_have_a_hard_memory_bound_without_reusing_labels() {
    let mut profiles = Profiles::default();
    for i in 0..MAX_PROFILES {
        assert_eq!(
            profiles.assign(vector(i)).speaker_id,
            Some(format!("anonymous-{}", i + 1))
        );
    }
    assert!(profiles.assign(vector(MAX_PROFILES)).speaker_id.is_none());
    assert_eq!(profiles.entries.len(), MAX_PROFILES);
    assert_eq!(
        profiles.assign(vector(0)).speaker_id.as_deref(),
        Some("anonymous-1")
    );
}

#[test]
fn timestamp_and_pcm_limits_reject_truncation_before_queueing() {
    assert!(validate(&utterance("empty")).is_ok());
    let mut input = utterance("bad");
    input.end_ms = 1_000;
    assert!(validate(&input).is_err());
    input.pcm = vec![0; INPUT_RATE * 2];
    assert!(validate(&input).is_ok());
    input.pcm.push(1);
    assert!(validate(&input).is_err());
    input.start_ms = 2_000;
    assert!(validate(&input).is_err());
    input = utterance("oversized");
    input.pcm = vec![0; MAX_PCM_BYTES + 2];
    input.end_ms = 30_001;
    assert!(validate(&input).is_err());
}

#[test]
fn known_overlap_and_short_audio_skip_identity_inference() {
    let mut input = utterance("overlap");
    input.pcm = vec![0; INPUT_RATE * 2 * 5];
    input.end_ms = 5_000;
    input.known_overlap = true;
    assert!(precheck(&input).unwrap().contains("Наложение"));
    input.known_overlap = false;
    assert!(precheck(&input).is_none());
    input.pcm.clear();
    input.end_ms = 0;
    assert!(precheck(&input).is_some());
}

#[test]
fn submission_is_bounded_and_stop_rejects_more_work() {
    let (sender, _receiver) = sync_mpsc::sync_channel(QUEUE_CAPACITY);
    let handle = SpeakerHandle {
        sender: Some(sender),
        control: Arc::new(Control::default()),
        worker: None,
    };
    for i in 0..QUEUE_CAPACITY {
        handle.submit(utterance(&i.to_string())).unwrap();
    }
    assert!(
        handle
            .submit(utterance("full"))
            .unwrap_err()
            .contains("занята")
    );
    handle.stop();
    assert!(
        handle
            .submit(utterance("stopped"))
            .unwrap_err()
            .contains("остановлена")
    );
}

#[test]
fn dropping_handle_discards_queued_jobs_and_suppresses_inflight_result() {
    let (sender, receiver) = sync_mpsc::sync_channel(QUEUE_CAPACITY);
    let (events, mut output) = mpsc::channel(8);
    let control = Arc::new(Control::default());
    let entered = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    let processed = Arc::new(AtomicUsize::new(0));
    let (finished, done) = sync_mpsc::channel();
    let (worker_control, worker_entered, worker_resume, worker_count) = (
        control.clone(),
        entered.clone(),
        resume.clone(),
        processed.clone(),
    );
    let worker = thread::spawn(move || {
        consume(receiver, &worker_control, &events, |input| {
            worker_count.fetch_add(1, Ordering::SeqCst);
            worker_entered.wait();
            worker_resume.wait();
            unknown(input, "synthetic")
        });
        finished.send(()).unwrap();
    });
    let handle = SpeakerHandle {
        sender: Some(sender),
        control,
        worker: Some(worker),
    };
    handle.submit(utterance("inflight")).unwrap();
    handle.submit(utterance("queued")).unwrap();
    entered.wait();
    drop(handle);
    resume.wait();
    done.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(processed.load(Ordering::SeqCst), 1);
    assert!(output.try_recv().is_err());
}

#[test]
fn downstream_backpressure_is_cancelled_without_leaking_a_worker() {
    let (events, _output) = mpsc::channel(1);
    events
        .try_send(SpeakerEvent::Status {
            available: true,
            detail: "full".into(),
        })
        .unwrap();
    let control = Arc::new(Control::default());
    let worker_control = control.clone();
    let worker = thread::spawn(move || {
        emit(
            &events,
            &worker_control,
            SpeakerEvent::Status {
                available: false,
                detail: "cancelled".into(),
            },
        )
    });
    control.cancelled.store(true, Ordering::Release);
    worker.thread().unpark();
    assert!(!worker.join().unwrap());
}

#[tokio::test]
async fn missing_assets_report_unavailable_and_never_invent_a_speaker() {
    let (events, mut output) = mpsc::channel(8);
    let missing = std::env::temp_dir().join(format!(
        "openassistant-absent-speakers-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut handle = SpeakerHandle::spawn(missing, events).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(3), output.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        status,
        SpeakerEvent::Status {
            available: false,
            ..
        }
    ));
    assert!(handle.submit(utterance("not-invented")).is_err());
    handle.shutdown().await;
    assert!(output.recv().await.is_none());
}

#[cfg(windows)]
#[test]
fn malformed_asset_directory_is_rejected_before_dll_loading() {
    let path = std::env::temp_dir().join(format!(
        "openassistant-invalid-speakers-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("libvosk.dll"), b"not executable").unwrap();
    let result = Engine::open(&path, &AtomicBool::new(false));
    std::fs::remove_dir_all(&path).unwrap();
    assert!(matches!(result, Err(detail) if detail.contains("Отсутствует файл")));
}

#[cfg(windows)]
#[test]
#[ignore = "Explicit offline check of installed model assets; uses only empty/silent synthetic PCM"]
fn installed_models_load_empty_pcm_offline() {
    let cancelled = AtomicBool::new(false);
    let mut engine = Engine::open(&default_asset_dir(), &cancelled).unwrap();
    let empty = engine.extract(&[], &cancelled).unwrap();
    assert!(empty.spk.is_empty());
    assert_eq!(empty.spk_frames, 0);
    // Exercises the true 24k to 16k/8k Kaldi resampling without recording any device.
    let silent = engine
        .extract(&vec![0; INPUT_RATE * 2], &cancelled)
        .unwrap();
    assert!(silent.spk.is_empty());
    assert!(silent.spk_frames < MIN_SPEECH_FRAMES);
}

#[test]
fn model_permit_serializes_epochs_and_cancels_waiters_before_old_ffi_returns() {
    let permit = Arc::new(Mutex::new(()));
    let active_models = Arc::new(AtomicUsize::new(1));
    let old_cancelled = AtomicBool::new(false);
    let old_engine = acquire_engine_permit(&permit, &old_cancelled).unwrap();
    let waiting_cancelled = Arc::new(AtomicBool::new(false));
    let (waiting_done, waiting_result) = sync_mpsc::channel();
    let waiting = {
        let permit = permit.clone();
        let cancelled = waiting_cancelled.clone();
        thread::spawn(move || {
            let loaded = acquire_engine_permit(&permit, &cancelled).is_some();
            waiting_done.send(loaded).unwrap();
        })
    };
    let (next_done, next_result) = sync_mpsc::channel();
    let next = {
        let permit = permit.clone();
        let active_models = active_models.clone();
        thread::spawn(move || {
            let cancelled = AtomicBool::new(false);
            let _engine_permit = acquire_engine_permit(&permit, &cancelled).unwrap();
            // Represents model_new and the whole Engine lifetime, including destructor.
            assert_eq!(active_models.fetch_add(1, Ordering::SeqCst), 0);
            assert_eq!(active_models.fetch_sub(1, Ordering::SeqCst), 1);
            next_done.send(()).unwrap();
        })
    };
    waiting_cancelled.store(true, Ordering::Release);
    waiting.thread().unpark();
    // The old model deliberately remains held: cancelled waiters must still finish.
    assert!(!waiting_result.recv_timeout(Duration::from_secs(2)).unwrap());
    waiting.join().unwrap();
    assert!(next_result.try_recv().is_err());
    // Cancellation alone must not release a permit for an in-flight native call.
    old_cancelled.store(true, Ordering::Release);
    assert!(matches!(permit.try_lock(), Err(TryLockError::WouldBlock)));
    assert_eq!(active_models.fetch_sub(1, Ordering::SeqCst), 1);
    drop(old_engine);
    next_result.recv_timeout(Duration::from_secs(2)).unwrap();
    next.join().unwrap();
    assert_eq!(active_models.load(Ordering::SeqCst), 0);
}

#[test]
fn poisoned_model_permit_recovers_for_a_later_listening_epoch() {
    let permit = Arc::new(Mutex::new(()));
    let failed = permit.clone();
    assert!(
        thread::spawn(move || {
            let _guard = failed.lock().unwrap();
            panic!("synthetic worker failure");
        })
        .join()
        .is_err()
    );
    assert!(permit.is_poisoned());
    let cancelled = AtomicBool::new(false);
    let guard = acquire_engine_permit(&permit, &cancelled).unwrap();
    assert!(!permit.is_poisoned());
    drop(guard);
    assert!(permit.try_lock().is_ok());
}
