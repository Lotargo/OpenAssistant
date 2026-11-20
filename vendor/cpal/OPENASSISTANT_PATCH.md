# OpenAssistant CPAL patch

This directory vendors the buildable source of **CPAL 0.18.2**, licensed under
Apache-2.0; the original license is preserved in [LICENSE](LICENSE).
The public API and upstream version are unchanged. OpenAssistant selects this
copy through the patch entry in src-tauri/Cargo.toml and pins CPAL to =0.18.2.

## Provenance

- Upstream repository: https://github.com/RustAudio/cpal
- Published crate: https://crates.io/crates/cpal/0.18.2
- Upstream commit from the published crate metadata:
  e1612d5d98152f8dc2a62e1b51ef7cbf4f7f26b7
- Published crate archive SHA256:
  6f02e8d0327b42d3e2e4ab2119af397344eb9fc54a34bf0ddeaa1277af8681f1
- Original src/host/wasapi/stream.rs SHA256:
  b7ac0295e968dad15c095e8ab71a06004545e1be555ca69660fe2af9b2fd930d

The source, examples, build script, manifests, README, formatting configuration,
and LICENSE were copied from that published crate. Repository administration
files and unrelated documentation are omitted. No global Cargo registry source
is modified.

## Why the local change exists

In CPAL 0.18.2, the WASAPI input path reads GetBuffer's sample pointer without
handling AUDCLNT_BUFFERFLAGS_SILENT. Windows requires clients to treat every
sample in a flagged packet as silence and ignore its actual buffer values:

https://learn.microsoft.com/en-us/windows/win32/api/audioclient/ne-audioclient-_audclnt_bufferflags

This matters for loopback capture used by the interview mode: old values must
not become repeated speech, and a flagged null buffer must not be dereferenced.

The only modified upstream implementation file is src/host/wasapi/stream.rs:

- Allocate one aligned silence buffer before entering the capture loop.
- Test SILENT before any access to the operating system's sample pointer.
- Fill the application's scratch buffer with the format's equilibrium value:
  zero for signed integer/float PCM, the midpoint for unsigned PCM.
- Preserve the original unflagged pointer and I24 conversion behavior.
- Keep endpoint-buffer release, timestamps, callbacks, and error handling intact.

The production branch and its four regression tests use the same helper.
Tests cover a null flagged pointer, a flagged nonzero payload, unsigned
equilibrium, and unchanged non-silent float/I24 conversion. They open no device.

From the OpenAssistant repository root:

    cargo test --manifest-path vendor/cpal/Cargo.toml --lib wasapi_silent_packet_tests

Remove this local patch when upgrading to an upstream release with equivalent
SILENT handling, after retaining these regressions or verifying equivalent tests.
