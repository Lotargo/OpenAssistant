//! Native Codex app-server transport. Events are INTERNAL protocol data:
//! the browser adapter must whitelist methods/fields and must never relay auth events.
use crate::auth::{SafeError, now_seconds};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex, MutexGuard, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
    time,
};

const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_PENDING: usize = 128;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub cwd: PathBuf,
    pub codex_home: Option<PathBuf>,
    pub executable: Option<PathBuf>,
    /// None uses the native app-server command. Explicit arguments support test injection.
    /// These options belong to the backend configuration, never to browser RPC input.
    pub arguments: Option<Vec<String>>,
}

fn app_server_arguments() -> Vec<String> {
    vec![
        "app-server".into(),
        "--listen".into(),
        "stdio://".into(),
        "-c".into(),
        "model_provider=\"openai\"".into(),
        // These overrides apply only to our child; never edit the user's config.
        "-c".into(),
        "notify=[]".into(),
        "-c".into(),
        "tui.notifications=false".into(),
    ]
}

impl SpawnOptions {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            codex_home: None,
            executable: None,
            arguments: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum Event {
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: String,
        method: String,
        params: Value,
    },
    Disconnected {
        message: String,
    },
}

/// Locate the installed native binary without executing shell wrappers or reading credentials.
pub fn resolve_native_executable(explicit: Option<&Path>) -> Result<PathBuf, SafeError> {
    if let Some(path) = explicit {
        let resolved = if path.is_file() {
            Some(path.to_owned())
        } else if path.components().count() == 1 {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|prefix| prefix.join(path))
                    .find(|candidate| candidate.is_file())
            })
        } else {
            None
        };
        let path =
            resolved.ok_or_else(|| SafeError::new("Configured Codex executable was not found."))?;
        #[cfg(windows)]
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "cmd" | "bat" | "ps1"
                )
            })
        {
            return Err(SafeError::new(
                "Use the native codex.exe executable, not a shell wrapper.",
            ));
        }
        return std::fs::canonicalize(path)
            .map_err(|_| SafeError::new("Could not resolve the configured Codex executable."));
    }
    let mut prefixes: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        prefixes.push(PathBuf::from(appdata).join("npm"));
    }
    for prefix in &prefixes {
        let candidate = prefix.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    #[cfg(windows)]
    {
        let platforms = [
            ("codex-win32-x64", "x86_64-pc-windows-msvc"),
            ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
        ];
        for prefix in prefixes {
            for (package, target) in platforms {
                let roots = [
                    prefix
                        .join("node_modules/@openai/codex/node_modules/@openai")
                        .join(package),
                    prefix.join("node_modules/@openai").join(package),
                ];
                for root in roots {
                    for leaf in ["bin/codex.exe", "codex/codex.exe"] {
                        let candidate = root.join("vendor").join(target).join(leaf);
                        if candidate.is_file() {
                            return Ok(candidate);
                        }
                    }
                }
            }
        }
    }
    Err(SafeError::new(
        "Native Codex executable not found. Install Codex or set --codex-executable.",
    ))
}

type ResponseSender = oneshot::Sender<Result<Value, SafeError>>;

#[derive(Clone)]
struct ServerRequest {
    rpc_id: Value,
    method: String,
    params: Value,
}

struct Inner {
    stdin: Mutex<ChildStdin>,
    child: StdMutex<Option<Child>>,
    pending: StdMutex<HashMap<u64, ResponseSender>>,
    requests: StdMutex<HashMap<String, ServerRequest>>,
    tasks: StdMutex<Vec<JoinHandle<()>>>,
    next_id: AtomicU64,
    next_request: AtomicU64,
    closed: AtomicBool,
    events: mpsc::Sender<Event>,
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.terminate("Codex client dropped.");
    }
}

/// Synchronous process cancellation, available even while initialization is awaiting a reply.
#[derive(Clone, Default)]
pub struct ProcessControl {
    state: Arc<StdMutex<ProcessControlState>>,
}
#[derive(Default)]
struct ProcessControlState {
    stopped: bool,
    process: Weak<Inner>,
}
impl ProcessControl {
    fn register(&self, process: &Arc<Inner>) -> Result<(), SafeError> {
        let stopped = {
            let mut state = lock(&self.state);
            if state.stopped {
                true
            } else {
                state.process = Arc::downgrade(process);
                false
            }
        };
        if stopped {
            process.terminate("Codex startup was cancelled.");
            Err(SafeError::new("Codex startup was cancelled."))
        } else {
            Ok(())
        }
    }

    pub fn terminate(&self) {
        let process = {
            let mut state = lock(&self.state);
            state.stopped = true;
            state.process.upgrade()
        };
        if let Some(process) = process {
            process.terminate("Codex client stopped.");
        }
    }
}

struct SpawnGuard {
    control: ProcessControl,
    armed: bool,
}
impl Drop for SpawnGuard {
    fn drop(&mut self) {
        if self.armed {
            self.control.terminate();
        }
    }
}

struct WriteGuard<'a> {
    inner: &'a Inner,
    complete: bool,
}
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.inner
                .terminate("Codex input write was interrupted; the process was stopped.");
        }
    }
}

impl Inner {
    async fn write(&self, value: Value) -> Result<(), SafeError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(SafeError::new("Codex process is disconnected."));
        }
        let mut bytes = serde_json::to_vec(&value)
            .map_err(|_| SafeError::new("Could not serialize a Codex request."))?;
        if bytes.len() > MAX_LINE {
            return Err(SafeError::new(
                "Codex request exceeds the transport size limit.",
            ));
        }
        bytes.push(b'\n');
        time::timeout(WRITE_TIMEOUT, async {
            let mut stdin = self.stdin.lock().await;
            let mut guard = WriteGuard {
                inner: self,
                complete: false,
            };
            stdin.write_all(&bytes).await?;
            stdin.flush().await?;
            guard.complete = true;
            Ok::<(), std::io::Error>(())
        })
        .await
        .map_err(|_| SafeError::new("Timed out writing to Codex."))?
        .map_err(|_| SafeError::new("Codex input pipe is closed."))
    }

    async fn emit(&self, event: Event) -> Result<(), SafeError> {
        time::timeout(EVENT_TIMEOUT, self.events.send(event))
            .await
            .map_err(|_| SafeError::new("Codex event consumer is not responding."))?
            .map_err(|_| SafeError::new("Codex event consumer is disconnected."))
    }

    fn fail_pending(&self, reason: &str) {
        for (_, sender) in lock(&self.pending).drain() {
            let _ = sender.send(Err(SafeError::new(reason)));
        }
        lock(&self.requests).clear();
    }

    fn terminate(&self, reason: &str) {
        let was_closed = self.closed.swap(true, Ordering::AcqRel);
        self.fail_pending(reason);
        for task in lock(&self.tasks).drain(..) {
            task.abort();
        }
        if let Some(child) = lock(&self.child).as_mut() {
            let _ = child.start_kill();
        }
        if !was_closed {
            let _ = self.events.try_send(Event::Disconnected {
                message: reason.to_owned(),
            });
        }
    }

    async fn close(&self, reason: &str) {
        self.terminate(reason);
    }
}

/// Cloneable client: one process can own multiple threads and independent RPC requests.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct PendingGuard {
    inner: Weak<Inner>,
    id: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            lock(&inner.pending).remove(&self.id);
        }
    }
}

impl Client {
    pub async fn spawn(
        options: SpawnOptions,
        events: mpsc::Sender<Event>,
    ) -> Result<Self, SafeError> {
        Self::spawn_controlled(options, events, ProcessControl::default()).await
    }

    pub async fn spawn_controlled(
        options: SpawnOptions,
        events: mpsc::Sender<Event>,
        control: ProcessControl,
    ) -> Result<Self, SafeError> {
        let mut guard = SpawnGuard {
            control,
            armed: true,
        };
        if !options.cwd.is_dir() {
            return Err(SafeError::new(
                "Codex workspace does not exist or is not a directory.",
            ));
        }
        let executable = resolve_native_executable(options.executable.as_deref())?;
        let mut command = Command::new(executable);
        command.args(options.arguments.unwrap_or_else(app_server_arguments));
        command
            .current_dir(options.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY");
        if let Some(home) = options.codex_home {
            command.env("CODEX_HOME", home);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, no console flash.
        // Approval policy, permission profiles and sandbox settings are inherited unchanged.
        let mut child = command
            .spawn()
            .map_err(|_| SafeError::new("Could not start the native Codex app-server."))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SafeError::new("Codex stdin is unavailable."))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SafeError::new("Codex stdout is unavailable."))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| SafeError::new("Codex stderr is unavailable."))?;
        let inner = Arc::new(Inner {
            stdin: Mutex::new(stdin),
            child: StdMutex::new(Some(child)),
            pending: StdMutex::new(HashMap::new()),
            requests: StdMutex::new(HashMap::new()),
            tasks: StdMutex::new(vec![]),
            next_id: AtomicU64::new(1),
            next_request: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            events,
        });
        guard.control.register(&inner)?;
        let weak = Arc::downgrade(&inner);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let line = read_bounded_line(&mut reader, MAX_LINE).await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let line = match line {
                    Ok(Some(line)) => line,
                    Ok(None) => {
                        inner.close("Codex process closed its output.").await;
                        break;
                    }
                    Err(_) => {
                        inner
                            .close("Codex output is invalid or exceeds the transport limit.")
                            .await;
                        break;
                    }
                };
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let message: Value = match serde_json::from_slice::<Value>(&line) {
                    Ok(value) if value.is_object() => value,
                    _ => {
                        inner
                            .close("Codex emitted invalid JSON protocol data.")
                            .await;
                        break;
                    }
                };
                if let Err(error) = dispatch(&inner, message).await {
                    inner.close(&error.to_string()).await;
                    break;
                }
                // No strong Arc is held across the next read, so dropping all clients kills the process.
            }
        });
        let drain = tokio::spawn(async move {
            // Drain bounded chunks. Never log stderr: it can contain private configuration or tokens.
            let mut buffer = [0u8; 8192];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
        lock(&inner.tasks).extend([reader, drain]);
        let client = Self { inner };
        let initialized = client.request("initialize", json!({
            "clientInfo": {"name":"openassistant","title":"OpenAssistant","version":env!("CARGO_PKG_VERSION")},
            "capabilities": {"experimentalApi":true,"requiredHumanApproval":true}
        })).await;
        if let Err(error) = initialized {
            client.shutdown().await;
            return Err(error);
        }
        if let Err(error) = client.notify("initialized", json!({})).await {
            client.shutdown().await;
            return Err(error);
        }
        guard.armed = false;
        Ok(client)
    }

    pub fn is_connected(&self) -> bool {
        !self.inner.closed.load(Ordering::Acquire)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, SafeError> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, SafeError> {
        if !valid_method(method) {
            return Err(SafeError::new("Invalid Codex method name."));
        }
        if !self.is_connected() {
            return Err(SafeError::new("Codex process is disconnected."));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = lock(&self.inner.pending);
            if pending.len() >= MAX_PENDING {
                return Err(SafeError::new("Too many pending Codex requests."));
            }
            pending.insert(id, sender);
        }
        let _guard = PendingGuard {
            inner: Arc::downgrade(&self.inner),
            id,
        };
        if let Err(error) = self
            .inner
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.inner.close(&error.to_string()).await;
            return Err(error);
        }
        match time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => {
                response.map_err(|error| SafeError::new(format!("Codex RPC {method}: {error}")))
            }
            Ok(Err(_)) => Err(SafeError::new(
                "Codex request was interrupted by process shutdown.",
            )),
            Err(_) => Err(SafeError::new(format!(
                "Codex request timed out: {method}."
            ))),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), SafeError> {
        if !valid_method(method) {
            return Err(SafeError::new("Invalid Codex method name."));
        }
        let result = self
            .inner
            .write(json!({"method":method,"params":params}))
            .await;
        if let Err(error) = &result {
            self.inner.close(&error.to_string()).await;
        }
        result
    }

    /// Respond only to an outstanding server request after the user made a decision.
    /// Session-wide grants and persistent policy amendments are deliberately not exposed.
    pub async fn resolve(&self, id: &str, response: Value) -> Result<(), SafeError> {
        let (request, result) = {
            let mut requests = lock(&self.inner.requests);
            let request = requests
                .get(id)
                .ok_or_else(|| SafeError::new("This Codex approval is no longer pending."))?;
            let result = approval_result(&request.method, &request.params, response)?;
            let request = requests
                .remove(id)
                .expect("request checked under the same lock");
            (request, result)
        };
        let outcome = self
            .inner
            .write(json!({"id":request.rpc_id,"result":result}))
            .await;
        if let Err(error) = &outcome {
            self.inner.close(&error.to_string()).await;
        }
        outcome
    }

    pub async fn approve(&self, id: &str, approved: bool) -> Result<(), SafeError> {
        self.resolve(
            id,
            json!({"decision":if approved {"accept"} else {"decline"}}),
        )
        .await
    }

    pub async fn start_thread(&self, cwd: &Path, model: Option<&str>) -> Result<Value, SafeError> {
        let mut params = json!({"cwd":cwd,"ephemeral":true,"modelProvider":"openai"});
        if let Some(model) = model.filter(|value| !value.is_empty()) {
            params["model"] = json!(model);
        }
        self.request("thread/start", params).await
    }

    pub async fn start_turn(
        &self,
        thread: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Value, SafeError> {
        self.start_turn_with_policy(thread, text, model, effort, false)
            .await
    }

    pub async fn start_hint_turn(
        &self,
        thread: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Value, SafeError> {
        self.start_turn_with_policy(thread, text, model, effort, true)
            .await
    }

    async fn start_turn_with_policy(
        &self,
        thread: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
        read_only: bool,
    ) -> Result<Value, SafeError> {
        if text.trim().is_empty() {
            return Err(SafeError::new("Codex task text is empty."));
        }
        let mut params = json!({
            "threadId":thread,
            "input":[{"type":"text","text":text,"text_elements":[]}]
        });
        if let Some(model) = model.filter(|value| !value.is_empty()) {
            params["model"] = json!(model);
        }
        if let Some(effort) = effort.filter(|value| !value.is_empty()) {
            params["effort"] = json!(effort);
        }
        if read_only {
            params["sandboxPolicy"] = json!({"type":"readOnly","networkAccess":false});
            params["approvalPolicy"] = json!("never");
        }
        self.request("turn/start", params).await
    }

    pub async fn fork_thread(&self, thread: &str) -> Result<Value, SafeError> {
        self.request(
            "thread/fork",
            json!({
                "threadId":thread,"ephemeral":true,"excludeTurns":true
            }),
        )
        .await
    }

    pub async fn interrupt(&self, thread: &str, turn: &str) -> Result<Value, SafeError> {
        self.request("turn/interrupt", json!({"threadId":thread,"turnId":turn}))
            .await
    }

    pub async fn list_models(&self) -> Result<Value, SafeError> {
        let mut result = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..20 {
            let mut params = json!({"limit":100,"modelProvider":"openai","includeHidden":false});
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let page = self.request("model/list", params).await?;
            let models = page["data"]
                .as_array()
                .ok_or_else(|| SafeError::new("Codex model catalog has an invalid shape."))?;
            result.extend(models.iter().cloned());
            let next = page["nextCursor"]
                .as_str()
                .filter(|value| !value.is_empty());
            let Some(next) = next else {
                return Ok(json!({"data":result,"nextCursor":null}));
            };
            if !seen.insert(next.to_owned()) {
                return Err(SafeError::new(
                    "Codex model catalog repeated its pagination cursor.",
                ));
            }
            cursor = Some(next.to_owned());
        }
        Err(SafeError::new(
            "Codex model catalog exceeded the pagination limit.",
        ))
    }

    pub async fn shutdown(&self) {
        self.inner.close("Codex client stopped.").await;
        for task in lock(&self.inner.tasks).drain(..) {
            task.abort();
        }
        let child = lock(&self.inner.child).take();
        if let Some(mut child) = child {
            let _ = time::timeout(Duration::from_secs(5), child.wait()).await;
        }
    }
}

fn valid_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= 160
        && method
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-'))
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(count) > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "line too large",
            ));
        }
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}

fn supported_request(method: &str, params: &Value) -> bool {
    match method {
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval"
        | "item/tool/requestUserInput"
        | "applyPatchApproval"
        | "execCommandApproval" => true,
        // Device verification requires an attested platform ceremony; a button is not proof.
        "mcpServer/elicitation/request" => matches!(
            params["mode"].as_str(),
            Some("form" | "openai/form" | "openaiForm" | "url")
        ),
        _ => false,
    }
}

async fn dispatch(inner: &Inner, message: Value) -> Result<(), SafeError> {
    if let Some(method) = message["method"].as_str() {
        if !valid_method(method) {
            return Err(SafeError::new("Codex emitted an invalid method name."));
        }
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if let Some(id) = message.get("id").filter(|id| !id.is_null()) {
            if method == "currentTime/read" {
                return inner
                    .write(json!({"id":id,"result":{"currentTimeAt":now_seconds()}}))
                    .await;
            }
            if !supported_request(method, &params) {
                return inner.write(json!({
                    "id":id,"error":{"code":-32601,"message":"This client does not support the requested server method."}
                })).await;
            }
            let local_id = format!(
                "request-{}",
                inner.next_request.fetch_add(1, Ordering::Relaxed)
            );
            {
                let mut requests = lock(&inner.requests);
                if requests.len() >= MAX_PENDING {
                    return Err(SafeError::new("Too many pending Codex approvals."));
                }
                requests.insert(
                    local_id.clone(),
                    ServerRequest {
                        rpc_id: id.clone(),
                        method: method.to_owned(),
                        params: params.clone(),
                    },
                );
            }
            inner
                .emit(Event::Request {
                    id: local_id,
                    method: method.to_owned(),
                    params,
                })
                .await?;
        } else {
            // Completed turns make unanswered prompts stale; never grant them after the turn ended.
            if method == "turn/completed" {
                let thread = params["threadId"].as_str();
                let turn = params["turn"]["id"].as_str();
                lock(&inner.requests).retain(|_, request| {
                    !(thread.is_some()
                        && turn.is_some()
                        && request.params["threadId"].as_str() == thread
                        && request.params["turnId"].as_str() == turn)
                });
            }
            inner
                .emit(Event::Notification {
                    method: method.to_owned(),
                    params,
                })
                .await?;
        }
        return Ok(());
    }
    if let Some(id) = message["id"].as_u64() {
        let pending = lock(&inner.pending).remove(&id);
        if let Some(sender) = pending {
            let response = if let Some(error) = message.get("error") {
                let code = error["code"]
                    .as_i64()
                    .map_or_else(|| "unknown".to_owned(), |n| n.to_string());
                Err(SafeError::new(format!(
                    "Codex rejected the request (code {code})."
                )))
            } else if let Some(result) = message.get("result") {
                Ok(result.clone())
            } else {
                Err(SafeError::new(
                    "Codex returned an invalid response envelope.",
                ))
            };
            let _ = sender.send(response);
        }
    }
    Ok(())
}

fn decision(response: &Value) -> Option<&str> {
    response
        .get("decision")
        .and_then(Value::as_str)
        .or_else(|| response.get("action").and_then(Value::as_str))
}

fn approval_result(method: &str, params: &Value, response: Value) -> Result<Value, SafeError> {
    let invalid = || SafeError::new("Unsupported or invalid Codex approval response.");
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let choice = decision(&response).ok_or_else(invalid)?;
            if !matches!(choice, "accept" | "decline" | "cancel") {
                return Err(invalid());
            }
            if let Some(available) = params["availableDecisions"].as_array()
                && !available.iter().any(|value| value.as_str() == Some(choice))
            {
                return Err(SafeError::new(
                    "That decision is not offered by Codex for this request.",
                ));
            }
            Ok(json!({"decision":choice}))
        }
        "item/permissions/requestApproval" => {
            if let Some(choice) = decision(&response) {
                return match choice {
                    "accept" if params["permissions"].is_object() => Ok(json!({
                        "permissions":params["permissions"],"scope":"turn"
                    })),
                    "decline" | "cancel" => Ok(json!({"permissions":{},"scope":"turn"})),
                    _ => Err(invalid()),
                };
            }
            if response["scope"]
                .as_str()
                .is_some_and(|scope| scope != "turn")
            {
                return Err(invalid());
            }
            let granted = &response["permissions"];
            if granted.as_object().is_some_and(|object| object.is_empty())
                || granted == &params["permissions"]
            {
                Ok(json!({"permissions":granted,"scope":"turn"}))
            } else {
                Err(invalid())
            }
        }
        "execCommandApproval" | "applyPatchApproval" => match decision(&response) {
            Some("accept" | "approved") => Ok(json!({"decision":"approved"})),
            Some("decline") => Ok(json!({"decision":{"denied":{"rejection":"Declined by user"}}})),
            Some("cancel" | "abort") => Ok(json!({"decision":"abort"})),
            _ => Err(invalid()),
        },
        "item/tool/requestUserInput" => {
            if matches!(decision(&response), Some("decline" | "cancel")) {
                return Ok(json!({"answers":{}}));
            }
            let answers = response["answers"].as_object().ok_or_else(invalid)?;
            let questions = params["questions"].as_array().ok_or_else(invalid)?;
            if answers.len() > questions.len() {
                return Err(invalid());
            }
            for (id, value) in answers {
                if !questions
                    .iter()
                    .any(|question| question["id"].as_str() == Some(id.as_str()))
                {
                    return Err(invalid());
                }
                let list = value["answers"].as_array().ok_or_else(invalid)?;
                if list.len() > 32
                    || list.iter().any(|answer| {
                        answer
                            .as_str()
                            .is_none_or(|text| text.chars().count() > 32_000)
                    })
                {
                    return Err(invalid());
                }
            }
            Ok(json!({"answers":answers}))
        }
        "mcpServer/elicitation/request" => {
            let action = decision(&response).ok_or_else(invalid)?;
            if !matches!(action, "accept" | "decline" | "cancel") {
                return Err(invalid());
            }
            if action != "accept" {
                return Ok(json!({"action":action}));
            }
            if params["mode"] == "openai/userVerification" {
                return Err(invalid());
            }
            if params["mode"] != "url" && !response.get("content").is_some_and(Value::is_object) {
                return Err(SafeError::new(
                    "This Codex request needs form answers before it can be accepted.",
                ));
            }
            let mut result = json!({"action":"accept"});
            if let Some(content) = response.get("content") {
                result["content"] = content.clone();
            }
            Ok(result)
        }
        _ => Err(SafeError::new("Unsupported Codex server request.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_arguments_are_private_stdio_and_suppress_only_its_notifications() {
        let args = app_server_arguments();
        assert_eq!(&args[..3], ["app-server", "--listen", "stdio://"]);
        assert!(args.iter().any(|arg| arg == "notify=[]"));
        assert!(args.iter().any(|arg| arg == "tui.notifications=false"));
        assert!(
            !args
                .iter()
                .any(|arg| arg.contains("sandbox") || arg.contains("approval"))
        );
    }

    #[test]
    fn only_one_time_command_and_file_decisions_are_supported() {
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        ] {
            for value in ["accept", "decline", "cancel"] {
                assert_eq!(
                    approval_result(method, &json!({}), json!({"decision":value})).unwrap(),
                    json!({"decision":value})
                );
            }
            assert!(
                approval_result(method, &json!({}), json!({"decision":"acceptForSession"}))
                    .is_err()
            );
            assert!(
                approval_result(
                    method,
                    &json!({}),
                    json!({"decision":{"acceptWithExecpolicyAmendment":{}}})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn permissions_cannot_be_broadened_or_persisted() {
        let params = json!({"permissions":{"network":{"enabled":true}}});
        assert_eq!(
            approval_result(
                "item/permissions/requestApproval",
                &params,
                json!({"decision":"decline"})
            )
            .unwrap(),
            json!({"permissions":{},"scope":"turn"})
        );
        assert_eq!(
            approval_result(
                "item/permissions/requestApproval",
                &params,
                json!({"decision":"accept"})
            )
            .unwrap(),
            json!({"permissions":params["permissions"],"scope":"turn"})
        );
        assert!(
            approval_result(
                "item/permissions/requestApproval",
                &params,
                json!({"permissions":params["permissions"],"scope":"session"})
            )
            .is_err()
        );
        assert!(
            approval_result(
                "item/permissions/requestApproval",
                &params,
                json!({"permissions":{"fileSystem":{"write":["C:/"]}},"scope":"turn"})
            )
            .is_err()
        );
    }

    #[test]
    fn offered_decisions_and_form_answer_ids_are_checked() {
        assert!(
            approval_result(
                "item/commandExecution/requestApproval",
                &json!({"availableDecisions":["decline"]}),
                json!({"decision":"accept"})
            )
            .is_err()
        );
        let params = json!({"questions":[{"id":"scope"}]});
        assert!(
            approval_result(
                "item/tool/requestUserInput",
                &params,
                json!({"answers":{"unexpected":{"answers":["yes"]}}})
            )
            .is_err()
        );
        assert!(
            approval_result(
                "item/tool/requestUserInput",
                &params,
                json!({"answers":{"scope":{"answers":["a"]}}})
            )
            .is_ok()
        );
    }

    #[tokio::test]
    async fn lines_are_bounded_without_an_unbounded_read_line_allocation() {
        let mut reader = BufReader::new(&b"one\nsecond\n"[..]);
        assert_eq!(
            read_bounded_line(&mut reader, 8).await.unwrap().unwrap(),
            b"one\n"
        );
        assert_eq!(
            read_bounded_line(&mut reader, 8).await.unwrap().unwrap(),
            b"second\n"
        );
        assert!(read_bounded_line(&mut reader, 8).await.unwrap().is_none());
        let mut reader = BufReader::new(&b"123456789"[..]);
        assert!(read_bounded_line(&mut reader, 8).await.is_err());
    }
}
