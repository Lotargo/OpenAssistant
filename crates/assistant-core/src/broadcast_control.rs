//! Cancellation for one broadcast, independent of the Codex session lifetime.
//!
//! Native Stop can arrive before the core processes Start. Remember that stop
//! even when no provider task has registered yet, and abort late registrations.
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::task::AbortHandle;

#[derive(Default)]
struct State {
    id: Option<String>,
    stopped: bool,
    tasks: Vec<AbortHandle>,
}

/// Handles only voice/auth workers explicitly registered by the broadcast.
/// Codex workers must not be registered here: they may outlive listening.
#[derive(Clone, Default)]
pub struct BroadcastControl {
    state: Arc<Mutex<State>>,
}

impl BroadcastControl {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn valid_id(id: &str) -> bool {
        !id.is_empty() && id.chars().count() <= 80 && !id.chars().any(char::is_control)
    }

    /// Start at most one identity. A preemptive Stop permanently fences it.
    pub fn begin(&self, id: &str) -> bool {
        if !Self::valid_id(id) {
            return false;
        }
        let mut state = self.state();
        if state.stopped || state.id.as_deref().is_some_and(|current| current != id) {
            return false;
        }
        state.id = Some(id.to_owned());
        true
    }

    /// A worker registered after Stop is aborted immediately, before it can be
    /// retained as an active voice worker. Returns whether registration survived.
    pub fn register(&self, id: &str, task: AbortHandle) -> bool {
        let mut state = self.state();
        if state.stopped || state.id.as_deref() != Some(id) {
            drop(state);
            task.abort();
            return false;
        }
        state.tasks.retain(|task| !task.is_finished());
        state.tasks.push(task);
        true
    }

    /// Stop only this broadcast; a stale identity cannot stop the current one.
    /// If Start has not arrived yet, reserve the identity in the stopped state.
    pub fn stop(&self, id: &str) {
        if !Self::valid_id(id) {
            return;
        }
        let tasks = {
            let mut state = self.state();
            if state.id.as_deref().is_some_and(|current| current != id) {
                return;
            }
            state.id = Some(id.to_owned());
            state.stopped = true;
            std::mem::take(&mut state.tasks)
        };
        for task in tasks {
            task.abort();
        }
    }

    /// Session teardown fences both existing and future broadcast workers.
    pub fn cancel_all(&self) {
        let tasks = {
            let mut state = self.state();
            state.stopped = true;
            std::mem::take(&mut state.tasks)
        };
        for task in tasks {
            task.abort();
        }
    }

    pub fn is_stopped(&self, id: &str) -> bool {
        let state = self.state();
        state.stopped || state.id.as_deref().is_some_and(|current| current != id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;

    #[tokio::test]
    async fn stop_aborts_voice_but_allows_codex_work_to_finish() {
        let control = BroadcastControl::default();
        assert!(control.begin("broadcast"));
        let microphone = tokio::spawn(pending::<()>());
        let system = tokio::spawn(pending::<()>());
        let (finish, completion) = tokio::sync::oneshot::channel::<&str>();
        let codex = tokio::spawn(async move { completion.await.unwrap() });
        assert!(control.register("broadcast", microphone.abort_handle()));
        assert!(control.register("broadcast", system.abort_handle()));

        control.stop("broadcast");
        assert!(microphone.await.unwrap_err().is_cancelled());
        assert!(system.await.unwrap_err().is_cancelled());
        assert!(!codex.is_finished());
        finish.send("task result preserved").unwrap();
        assert_eq!(codex.await.unwrap(), "task result preserved");
    }

    #[tokio::test]
    async fn stop_before_start_or_registration_cannot_be_undone() {
        let control = BroadcastControl::default();
        control.stop("broadcast");
        assert!(!control.begin("broadcast"));
        assert!(!control.begin("another"));
        let late = tokio::spawn(pending::<()>());
        assert!(!control.register("broadcast", late.abort_handle()));
        assert!(late.await.unwrap_err().is_cancelled());
        assert!(control.is_stopped("broadcast"));

        let started = BroadcastControl::default();
        assert!(started.begin("started"));
        started.stop("started");
        let late = tokio::spawn(pending::<()>());
        assert!(!started.register("started", late.abort_handle()));
        assert!(late.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn a_stale_stop_or_registration_cannot_cancel_another_identity() {
        let control = BroadcastControl::default();
        assert!(control.begin("current"));
        let current = tokio::spawn(pending::<()>());
        assert!(control.register("current", current.abort_handle()));
        control.stop("old");
        assert!(!control.is_stopped("current"));
        assert!(!current.is_finished());

        let stale = tokio::spawn(pending::<()>());
        assert!(!control.register("old", stale.abort_handle()));
        assert!(stale.await.unwrap_err().is_cancelled());
        assert!(!current.is_finished());
        control.stop("current");
        assert!(current.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn teardown_fences_late_workers_even_before_an_identity_is_known() {
        let control = BroadcastControl::default();
        control.cancel_all();
        assert!(!control.begin("late"));
        let worker = tokio::spawn(pending::<()>());
        assert!(!control.register("late", worker.abort_handle()));
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    #[test]
    fn malformed_identifiers_do_not_reserve_a_broadcast() {
        let control = BroadcastControl::default();
        for id in ["", "new\nline", &"x".repeat(81)] {
            control.stop(id);
            assert!(!control.begin(id));
        }
        assert!(control.begin("valid"));
        assert!(control.begin("valid"));
        assert!(!control.begin("different"));
        assert!(!control.is_stopped("valid"));
    }
}
