//! Codex turn orchestration, independent of HTTP and the voice transport.
use crate::{
    auth::SafeError,
    bridge,
    codex::{Client, Event, ProcessControl, SpawnOptions},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{self, Instant},
};

pub const MAX_TASK_CHARS: usize = 16000;
const MAX_RESULT_CHARS: usize = 64000;
const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
const OUTPUT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct Config {
    pub workspace: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub web_search: bool,
    pub parallel: bool,
}
#[derive(Debug)]
pub enum Command {
    Run { id: String, task: String },
    Interrupt { id: Option<String> },
    Approval { id: String, decision: String },
    UserInput { id: String, answers: Value },
    Models,
    Shutdown,
}
#[derive(Debug)]
pub enum Output {
    Ui(Value),
    Completed {
        id: String,
        text: String,
        status: String,
    },
}
pub struct Handle {
    pub commands: mpsc::Sender<Command>,
    task: Option<JoinHandle<()>>,
    stop: watch::Sender<Option<String>>,
    process: ProcessControl,
}
impl Handle {
    pub async fn shutdown(mut self) {
        let _ = self.stop.send(Some(String::new()));
        let _ = self.commands.try_send(Command::Shutdown);
        // Keep ownership in self: dropping this future must run Handle::drop.
        if let Some(task) = self.task.as_mut()
            && time::timeout(Duration::from_secs(5), &mut *task)
                .await
                .is_err()
        {
            self.process.terminate();
            task.abort();
            let _ = task.await;
        }
        self.task.take();
        self.process.terminate();
    }

    pub fn spawn(config: Config, options: SpawnOptions, output: mpsc::Sender<Output>) -> Self {
        let (commands, rx) = mpsc::channel(64);
        let (stop, stop_rx) = watch::channel(None);
        let signal = stop.clone();
        let process = ProcessControl::default();
        let child_control = process.clone();
        let task = tokio::spawn(async move {
            if let Err(error) =
                run(config, options, rx, signal, stop_rx, child_control, &output).await
            {
                let _ = emit(&output, "agent_error", json!({"message":error.to_string()})).await;
                let _ = emit(
                    &output,
                    "agent_state",
                    json!({"stage":"error","detail":error.to_string()}),
                )
                .await;
            }
        });
        Self {
            commands,
            task: Some(task),
            stop,
            process,
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        // No detached cleanup: terminate the process synchronously before aborting the actor.
        self.process.terminate();
        let _ = self.stop.send(Some(String::new()));
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

struct AbortTask(JoinHandle<()>);
impl AbortTask {
    fn abort(&self) {
        self.0.abort();
    }
}
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn cut(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}
async fn emit(output: &mpsc::Sender<Output>, kind: &str, payload: Value) -> Result<(), SafeError> {
    time::timeout(
        OUTPUT_TIMEOUT,
        output.send(Output::Ui(bridge::event(kind, payload))),
    )
    .await
    .map_err(|_| SafeError::new("Agent output consumer is not responding"))?
    .map_err(|_| SafeError::new("Agent client disconnected"))
}
async fn completed(
    output: &mpsc::Sender<Output>,
    id: String,
    text: String,
    status: &str,
) -> Result<(), SafeError> {
    time::timeout(
        OUTPUT_TIMEOUT,
        output.send(Output::Completed {
            id,
            text,
            status: status.to_owned(),
        }),
    )
    .await
    .map_err(|_| SafeError::new("Agent output consumer is not responding"))?
    .map_err(|_| SafeError::new("Agent client disconnected"))
}
async fn finish_task(
    output: &mpsc::Sender<Output>,
    id: String,
    text: String,
    status: &str,
) -> Result<(), SafeError> {
    // Resolve the voice function even if its matching UI event cannot be delivered.
    let done = emit(
        output,
        "agent_done",
        json!({"task_id":id,"text":text,"status":status}),
    )
    .await;
    let result = completed(output, id, text, status).await;
    result.and(done)
}
async fn reject_task(
    output: &mpsc::Sender<Output>,
    id: String,
    message: String,
) -> Result<(), SafeError> {
    let error = emit(
        output,
        "agent_error",
        json!({"task_id":id,"message":message}),
    )
    .await;
    let result = finish_task(output, id, message, "failed").await;
    result.and(error)
}
async fn finish_cleanup(output: &mpsc::Sender<Output>, tasks: Vec<(String, String, String)>) {
    // Complete all accepted function calls first; UI delivery is best effort during teardown.
    let sends = tasks.iter().map(|(id, text, status)| {
        output.send(Output::Completed {
            id: id.clone(),
            text: text.clone(),
            status: status.clone(),
        })
    });
    let _ = time::timeout(
        Duration::from_millis(700),
        futures_util::future::join_all(sends),
    )
    .await;
    for (id, text, status) in tasks {
        let _ = output.try_send(Output::Ui(bridge::event(
            "agent_done",
            json!({"task_id":id,"text":text,"status":status}),
        )));
    }
}

pub fn require_chatgpt(account: &Value) -> Result<(), SafeError> {
    if account["account"]["type"] == "chatgpt" {
        Ok(())
    } else {
        Err(SafeError::new(
            "Codex is not signed in with ChatGPT. Run 'codex login'; API-key providers are not supported.",
        ))
    }
}

pub fn model_catalog(raw: &Value) -> Value {
    let models: Vec<_> = raw["data"]
        .as_array()
        .into_iter()
        .flatten()
        .take(2000)
        .map(|m| {
            let id = m["model"]
                .as_str()
                .or_else(|| m["id"].as_str())
                .unwrap_or("");
            let efforts: Vec<_> = m["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["reasoningEffort"].as_str())
                .take(32)
                .map(|s| cut(s, 64))
                .collect();
            json!({"id":cut(id,256),"display_name":cut(m["displayName"].as_str().unwrap_or(id),256),
            "is_default":m["isDefault"].as_bool().unwrap_or(false),
            "reasoning_efforts":efforts,"default_effort":m["defaultReasoningEffort"].as_str()})
        })
        .filter(|m| m["id"].as_str().is_some_and(|s| !s.is_empty()))
        .collect();
    json!({"models":models})
}
fn thread_params(config: &Config, ephemeral: bool) -> Value {
    let mut params = json!({
        "cwd":config.workspace,"ephemeral":ephemeral,"modelProvider":"openai",
        "config":{"web_search":if config.web_search {"live"} else {"disabled"}},
        "developerInstructions":concat!(
            "You are the coding and action agent inside OpenAssistant. Work in the selected project, ",
            "follow its instructions, use your native tools to inspect files, implement changes, ",
            "run suitable checks, and search the web when requested. Use parallel tools or agents ",
            "for independent work when they are available. Do not claim actions succeeded without evidence. ",
            "Respond concisely in Russian with standard Markdown and fenced code when useful. ",
            "The host forwards approval and clarification requests to the user; respect those decisions."
        )
    });
    if let Some(model) = config.model.as_deref().filter(|s| !s.is_empty()) {
        params["model"] = json!(model);
    }
    params
}
struct Job {
    id: String,
    thread: String,
    turn: String,
    messages: HashMap<String, (String, String)>,
    order: Vec<String>,
    started: Instant,
    stopping: bool,
}
impl Job {
    fn final_text(&self) -> String {
        self.order
            .iter()
            .rev()
            .find_map(|id| {
                self.messages
                    .get(id)
                    .filter(|(_, phase)| phase == "final_answer")
                    .map(|(text, _)| text.clone())
            })
            .or_else(|| {
                self.order
                    .last()
                    .and_then(|id| self.messages.get(id))
                    .map(|(text, _)| text.clone())
            })
            .unwrap_or_default()
    }
    fn message(&mut self, id: &str) -> &mut (String, String) {
        if !self.messages.contains_key(id) {
            self.order.push(id.to_owned());
            self.messages
                .insert(id.to_owned(), (String::new(), String::new()));
        }
        self.messages.get_mut(id).unwrap()
    }
}
struct PendingRequest {
    method: String,
    thread: String,
    turn: String,
}
struct BufferedEvent {
    event: Event,
    bytes: usize,
}

// A separate bounded pump keeps stdout RPC responses moving while a thread/start is awaiting
// its reply. A full buffer fails explicitly instead of deadlocking both protocol directions.
fn forward_notification(method: &str) -> bool {
    matches!(
        method,
        "turn/started"
            | "turn/completed"
            | "item/agentMessage/delta"
            | "item/started"
            | "item/completed"
            | "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "turn/diff/updated"
            | "turn/plan/updated"
            | "error"
    )
}
async fn pump_events(
    mut input: mpsc::Receiver<Event>,
    output: mpsc::Sender<BufferedEvent>,
    bytes: Arc<AtomicUsize>,
    stop: watch::Sender<Option<String>>,
) {
    while let Some(event) = input.recv().await {
        if let Event::Notification { method, .. } = &event
            && !forward_notification(method)
        {
            continue;
        }
        let size = match &event {
            Event::Notification { method, params } => method.len() + params.to_string().len(),
            Event::Request { id, method, params } => {
                id.len() + method.len() + params.to_string().len()
            }
            Event::Disconnected { message } => message.len(),
        };
        let previous = bytes.fetch_add(size, Ordering::AcqRel);
        if previous.saturating_add(size) > MAX_BUFFERED_BYTES
            || output
                .try_send(BufferedEvent { event, bytes: size })
                .is_err()
        {
            bytes.fetch_sub(size, Ordering::AcqRel);
            let _ = stop.send(Some(
                "Codex event buffer overflow; the session was stopped.".into(),
            ));
            break;
        }
    }
}
fn observe_turn(event: &Event, active: &mut HashMap<String, String>) {
    if let Event::Notification { method, params } = event
        && let (Some(thread), Some(turn)) =
            (params["threadId"].as_str(), params["turn"]["id"].as_str())
    {
        if method == "turn/started" {
            active.insert(thread.to_owned(), turn.to_owned());
        }
        if method == "turn/completed" && active.get(thread).is_some_and(|id| id == turn) {
            active.remove(thread);
        }
    }
}
fn take_event(event: BufferedEvent, bytes: &AtomicUsize) -> Event {
    bytes.fetch_sub(event.bytes, Ordering::AcqRel);
    event.event
}

async fn run(
    config: Config,
    mut options: SpawnOptions,
    mut commands: mpsc::Receiver<Command>,
    stop: watch::Sender<Option<String>>,
    mut shutdown: watch::Receiver<Option<String>>,
    process: ProcessControl,
    output: &mpsc::Sender<Output>,
) -> Result<(), SafeError> {
    let result = async {
        emit(
            output,
            "agent_state",
            json!({"stage":"starting","detail":"Запуск Codex","workspace":config.workspace}),
        )
        .await?;
        options.cwd = config.workspace.clone();
        let (event_tx, event_rx) = mpsc::channel(256);
        let (buffer_tx, mut events) = mpsc::channel(1024);
        let bytes = Arc::new(AtomicUsize::new(0));
        let pump = AbortTask(tokio::spawn(pump_events(
            event_rx,
            buffer_tx,
            bytes.clone(),
            stop,
        )));
        let started = tokio::select! {
            result=Client::spawn_controlled(options,event_tx,process)=>Some(result),
            _=shutdown.changed()=>None,
        };
        let client = match started {
            Some(Ok(client)) => client,
            Some(Err(error)) => {
                pump.abort();
                return Err(error);
            }
            None => {
                pump.abort();
                let reason = shutdown.borrow().clone().unwrap_or_default();
                return if reason.is_empty() {
                    Ok(())
                } else {
                    Err(SafeError::new(reason))
                };
            }
        };
        let outcome = run_client(
            &client,
            &config,
            &mut commands,
            &mut events,
            &bytes,
            &mut shutdown,
            output,
        )
        .await;
        client.shutdown().await;
        pump.abort();
        outcome
    }
    .await;
    commands.close();
    let reason = result
        .as_ref()
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "Задача отменена".into());
    let status = if result.is_err() {
        "failed"
    } else {
        "interrupted"
    };
    let mut pending = vec![];
    while let Ok(command) = commands.try_recv() {
        if let Command::Run { id, .. } = command {
            pending.push((id, reason.clone(), status.to_owned()));
        }
    }
    finish_cleanup(output, pending).await;
    result
}

async fn run_client(
    client: &Client,
    config: &Config,
    commands: &mut mpsc::Receiver<Command>,
    events: &mut mpsc::Receiver<BufferedEvent>,
    buffered_bytes: &AtomicUsize,
    shutdown: &mut watch::Receiver<Option<String>>,
    output: &mpsc::Sender<Output>,
) -> Result<(), SafeError> {
    let mut jobs = HashMap::<String, Job>::new();
    let mut queue = VecDeque::<(String, String)>::new();
    let mut requests = HashMap::<String, PendingRequest>::new();
    let mut active = HashMap::<String, String>::new();
    let mut children = HashMap::<String, String>::new();
    let mut inflight: Option<(String, String)> = None;
    let work = async {
        // Reuse the current ChatGPT login; normal token refresh belongs to Codex.
        // Checking account type must not rotate credentials on every connection.
        let account = client
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        require_chatgpt(&account)?;
        let models = client.list_models().await?;
        let catalog = model_catalog(&models);
        if let Some(model) = config.model.as_deref().filter(|s| !s.is_empty())
            && !catalog["models"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["id"] == model))
        {
            return Err(SafeError::new(
                "Выбранная модель отсутствует в списке Codex",
            ));
        }
        emit(output, "agent_models", catalog.clone()).await?;
        let thread = client
            .request("thread/start", thread_params(config, false))
            .await?;
        if thread["modelProvider"]
            .as_str()
            .is_some_and(|provider| provider != "openai")
        {
            return Err(SafeError::new(
                "OpenAssistant requires the OpenAI Codex provider.",
            ));
        }
        let main_thread = thread["thread"]["id"]
            .as_str()
            .ok_or_else(|| SafeError::new("Codex did not return a thread ID"))?
            .to_owned();
        let model = thread["model"]
            .as_str()
            .ok_or_else(|| SafeError::new("Codex did not return its selected model"))?
            .to_owned();
        let selected = catalog["models"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == model))
            .ok_or_else(|| {
                SafeError::new("Модель Codex не найдена в каталоге текущего провайдера")
            })?;
        let effort = config
            .effort
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| thread["reasoningEffort"].as_str())
            .or_else(|| selected["default_effort"].as_str())
            .map(str::to_owned);
        if let Some(effort) = &effort
            && !selected["reasoning_efforts"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v == effort))
        {
            return Err(SafeError::new(
                "Выбранный уровень рассуждения не поддерживается этой моделью Codex",
            ));
        }
        let mut effective = config.clone();
        effective.model = Some(model.clone());
        effective.effort = effort.clone();
        let state = json!({"stage":"ready","detail":"Codex готов","workspace":config.workspace,
            "model":model,"effort":effort,"thread_id":main_thread});
        emit(output, "agent_state", state.clone()).await?;
        let parallel = if config.parallel { 3 } else { 1 };
        let mut timer = time::interval(Duration::from_secs(2));
        loop {
            while jobs.len() < parallel && !queue.is_empty() {
                let (id, task) = queue.pop_front().unwrap();
                inflight = Some((id.clone(), task.clone()));
                let setup = async {
                    let thread_id = if jobs.contains_key(&main_thread) {
                        let new_thread = client
                            .request("thread/start", thread_params(&effective, true))
                            .await?;
                        new_thread["thread"]["id"]
                            .as_str()
                            .ok_or_else(|| {
                                SafeError::new("Codex did not return a parallel thread ID")
                            })?
                            .to_owned()
                    } else {
                        main_thread.clone()
                    };
                    let turn = client
                        .start_turn(
                            &thread_id,
                            &task,
                            effective.model.as_deref(),
                            effective.effort.as_deref(),
                        )
                        .await?;
                    let turn_id = turn["turn"]["id"]
                        .as_str()
                        .ok_or_else(|| SafeError::new("Codex did not return a turn ID"))?
                        .to_owned();
                    Ok::<_, SafeError>((thread_id, turn_id))
                }
                .await;
                match setup {
                    Ok((thread_id, turn_id)) => {
                        // Register before output I/O: any error from emit must still interrupt this turn.
                        active.insert(thread_id.clone(), turn_id.clone());
                        jobs.insert(
                            thread_id.clone(),
                            Job {
                                id: id.clone(),
                                thread: thread_id.clone(),
                                turn: turn_id.clone(),
                                messages: HashMap::new(),
                                order: vec![],
                                started: Instant::now(),
                                stopping: false,
                            },
                        );
                        inflight = None;
                        emit(output,"agent_task_started",json!({"task_id":id,"task":task,"thread_id":thread_id,"turn_id":turn_id})).await?;
                        emit(output,"agent_state",json!({"stage":"running","detail":"Codex выполняет задачу","active_tasks":jobs.len(),"workspace":config.workspace})).await?;
                    }
                    Err(error) => {
                        reject_task(output, id, error.to_string()).await?;
                        inflight = None;
                    }
                }
            }
            tokio::select! {
                command=commands.recv()=>{
                    let Some(command)=command else {break;};
                    match command {
                        Command::Run{id,task}=>{
                            if task.trim().is_empty() || task.chars().count()>MAX_TASK_CHARS {
                                reject_task(output,id,"Введите задачу длиной до 16000 символов".into()).await?;
                            } else if queue.len()+jobs.len()>=16 {
                                reject_task(output,id,"Очередь Codex заполнена".into()).await?;
                            } else { queue.push_back((id,task)); }
                        }
                        Command::Interrupt{id}=>{
                            let to_stop:Vec<_>=active.iter().filter(|(thread,_)|id.as_ref().is_none_or(|id|{
                                jobs.get(*thread).is_some_and(|job|&job.id==id) || children.get(*thread)==Some(id)
                            })).map(|(thread,turn)|(thread.clone(),turn.clone())).collect();
                            for (thread,turn) in to_stop {
                                client.interrupt(&thread,&turn).await?;
                                if let Some(job)=jobs.get_mut(&thread) {job.stopping=true;}
                            }
                            while let Some(index)=queue.iter().position(|(queued_id,_)|id.as_ref().is_none_or(|id|id==queued_id)) {
                                let (queued_id,task)=queue.remove(index).unwrap();
                                inflight=Some((queued_id.clone(),task));
                                finish_task(output,queued_id,"Задача отменена".into(),"interrupted").await?;
                                inflight=None;
                            }
                        }
                        Command::Approval{id,decision}=>{
                            if requests.get(&id).is_some_and(|pending|pending.method=="item/tool/requestUserInput") {
                                emit(output,"agent_error",json!({"message":"Для этого запроса нужен текстовый ответ"})).await?;
                                continue;
                            }
                            match client.resolve(&id,json!({"decision":decision})).await {
                                Ok(())=>{requests.remove(&id);emit(output,"agent_approval_resolved",json!({"request_id":id,"decision":decision})).await?;}
                                Err(e)=>emit(output,"agent_error",json!({"message":e.to_string()})).await?,
                            }
                        }
                        Command::UserInput{id,answers}=>{
                            match client.resolve(&id,json!({"answers":answers})).await {
                                Ok(())=>{requests.remove(&id);emit(output,"agent_input_resolved",json!({"request_id":id})).await?;}
                                Err(e)=>emit(output,"agent_error",json!({"message":e.to_string()})).await?,
                            }
                        }
                        Command::Models=>emit(output,"agent_models",model_catalog(&client.list_models().await?)).await?,
                        Command::Shutdown=>break,
                    }
                }
                event=events.recv()=>{
                    let Some(event)=event else {return Err(SafeError::new("Codex event channel closed"));};
                    let event=take_event(event,buffered_bytes);
                    observe_turn(&event,&mut active);
                    match event {
                        Event::Disconnected{message}=>return Err(SafeError::new(message)),
                        Event::Request{id,method,params}=>{
                            let thread=params["threadId"].as_str().unwrap_or("").to_owned();
                            let turn=params["turnId"].as_str().unwrap_or("").to_owned();
                            let task=jobs.get(&thread).map(|job|job.id.clone()).or_else(||children.get(&thread).cloned());
                            requests.insert(id.clone(),PendingRequest{method:method.clone(),thread,turn});
                            if method=="item/tool/requestUserInput" {
                                let questions:Vec<_>=params["questions"].as_array().into_iter().flatten().take(20).map(|q|{
                                    let options:Vec<_>=q["options"].as_array().into_iter().flatten().take(20).map(|o|
                                        json!({"label":cut(o["label"].as_str().unwrap_or(""),500),"description":cut(o["description"].as_str().unwrap_or(""),2000)})).collect();
                                    json!({"id":cut(q["id"].as_str().unwrap_or(""),256),"header":cut(q["header"].as_str().unwrap_or(""),256),
                                        "question":cut(q["question"].as_str().unwrap_or(""),8000),"isSecret":q["isSecret"].as_bool().unwrap_or(false),
                                        "isOther":q["isOther"].as_bool().unwrap_or(false),"options":options})
                                }).collect();
                                emit(output,"agent_input",json!({"request_id":id,"task_id":task,"questions":questions})).await?;
                            } else {
                                let title=match method.as_str() {
                                    "item/fileChange/requestApproval"|"applyPatchApproval"=>"Разрешить изменение файлов?",
                                    "item/permissions/requestApproval"=>"Codex запрашивает разрешение",
                                    "mcpServer/elicitation/request"=>"Внешний инструмент запрашивает подтверждение",
                                    _=>"Разрешить выполнение команды?",
                                };
                                let choices:Vec<_>=params["availableDecisions"].as_array().into_iter().flatten()
                                    .filter_map(Value::as_str).filter(|d|matches!(*d,"accept"|"decline"|"cancel")).collect();
                                emit(output,"agent_approval",json!({
                                    "request_id":id,"task_id":task,"method":method,"title":title,
                                    "command":params["command"].as_str(),"cwd":params["cwd"].as_str(),"reason":params["reason"].as_str(),
                                    "permissions":if method=="item/permissions/requestApproval" {params["permissions"].clone()} else {Value::Null},
                                    "choices":choices,"message":params["message"].as_str(),"url":params["url"].as_str(),
                                    "requires_content":method=="mcpServer/elicitation/request" && params["mode"]!="url"
                                })).await?;
                            }
                        }
                        Event::Notification{method,params}=>{
                            let thread=params["threadId"].as_str().unwrap_or("");
                            if method=="turn/completed" {
                                let turn=params["turn"]["id"].as_str().unwrap_or("");
                                let stale:Vec<_>=requests.iter().filter(|(_,r)|r.thread==thread && r.turn==turn)
                                    .map(|(id,r)|(id.clone(),r.method.clone())).collect();
                                for (id,method) in stale {
                                    requests.remove(&id);
                                    emit(output,if method=="item/tool/requestUserInput" {"agent_input_resolved"} else {"agent_approval_resolved"},
                                        json!({"request_id":id,"decision":"cancel"})).await?;
                                }
                                if jobs.get(thread).is_some_and(|job|job.turn==turn) {
                                    let job=jobs.remove(thread).unwrap();
                                    let status=match params["turn"]["status"].as_str() {
                                        Some("completed")=>"completed",Some("interrupted")=>"interrupted",_=>"failed"
                                    };
                                    let mut text=job.final_text();
                                    if text.trim().is_empty() {text=if status=="completed" {"Codex завершил задачу."} else {"Задача Codex не завершена."}.into();}
                                    inflight=Some((job.id.clone(),String::new()));
                                    finish_task(output,job.id,text,status).await?;
                                    inflight=None;
                                    if jobs.is_empty() && queue.is_empty() {emit(output,"agent_state",state.clone()).await?;}
                                }
                                continue;
                            }
                            if matches!(method.as_str(),"item/started"|"item/completed") && params["item"]["type"]=="collabAgentToolCall" {
                                let owner=jobs.get(thread).map(|job|job.id.clone()).or_else(||children.get(thread).cloned());
                                if let Some(owner)=owner {
                                    for child in params["item"]["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                                        children.insert(child.to_owned(),owner.clone());
                                    }
                                }
                            }
                            let Some(job)=jobs.get_mut(thread) else {continue;};
                            if let Some(turn)=params["turnId"].as_str()&& turn!=job.turn {continue;}
                            notification(job,&method,&params,output).await?;
                        }
                    }
                }
                _=timer.tick()=>{
                    let expired:Vec<_>=jobs.values().filter(|job|!job.stopping && job.started.elapsed()>Duration::from_secs(1800))
                        .map(|job|(job.thread.clone(),job.turn.clone())).collect();
                    for (thread,turn) in expired {
                        client.interrupt(&thread,&turn).await?;
                        if let Some(job)=jobs.get_mut(&thread) {job.stopping=true;}
                    }
                }
            }
        }
        Ok(())
    };
    let already_stopping = shutdown.borrow().clone();
    let result = if let Some(reason) = already_stopping {
        drop(work);
        if reason.is_empty() {
            Ok(())
        } else {
            Err(SafeError::new(reason))
        }
    } else {
        tokio::select! {
            result=work=>result,
            _=shutdown.changed()=>{
                let reason=shutdown.borrow().clone().unwrap_or_default();
                if reason.is_empty() {Ok(())} else {Err(SafeError::new(reason))}
            }
        }
    };
    // Finally: queued stdout may contain turn/started received while a setup RPC was cancelled.
    while let Ok(event) = events.try_recv() {
        observe_turn(&take_event(event, buffered_bytes), &mut active);
    }
    for job in jobs.values() {
        active.insert(job.thread.clone(), job.turn.clone());
    }
    let interruptions = active
        .iter()
        .map(|(thread, turn)| client.interrupt(thread, turn));
    let _ = time::timeout(
        Duration::from_secs(2),
        futures_util::future::join_all(interruptions),
    )
    .await;
    let reason = result
        .as_ref()
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "Задача отменена".into());
    let status = if result.is_err() {
        "failed"
    } else {
        "interrupted"
    };
    let mut unfinished: Vec<_> = jobs
        .into_values()
        .map(|job| (job.id, reason.clone(), status.to_owned()))
        .collect();
    unfinished.extend(
        queue
            .into_iter()
            .map(|(id, _)| (id, reason.clone(), status.to_owned())),
    );
    if let Some((id, _)) = inflight {
        unfinished.push((id, reason, status.to_owned()));
    }
    finish_cleanup(output, unfinished).await;
    result
}

async fn notification(
    job: &mut Job,
    method: &str,
    params: &Value,
    output: &mpsc::Sender<Output>,
) -> Result<(), SafeError> {
    match method {
        "item/agentMessage/delta"=>{
            let item=params["itemId"].as_str().unwrap_or("message");
            let text=params["delta"].as_str().unwrap_or("");
            let entry=job.message(item);
            if entry.0.chars().count()<MAX_RESULT_CHARS {
                entry.0.push_str(&cut(text,MAX_RESULT_CHARS-entry.0.chars().count()));
            }
            let phase=entry.1.clone();
            emit(output,"agent_delta",json!({"task_id":job.id,"thread_id":job.thread,"item_id":item,"text":cut(text,16000),"phase":phase})).await?;
        }
        "item/started"|"item/completed"=>{
            let item=&params["item"];
            let item_id=item["id"].as_str().unwrap_or("item");
            let kind=item["type"].as_str().unwrap_or("");
            let status=if method=="item/started" {"running"} else if item["status"]=="failed" {"failed"} else {"completed"};
            if kind=="agentMessage" {
                let entry=job.message(item_id);
                if let Some(phase)=item["phase"].as_str() {entry.1=phase.to_owned();}
                if let Some(text)=item["text"].as_str() {entry.0=cut(text,MAX_RESULT_CHARS);}
                return Ok(());
            }
            let (category,title,detail)=match kind {
                "commandExecution"=>("command","Команда",item["command"].as_str().unwrap_or("")),
                "fileChange"=>("file","Изменение файлов",""),
                "webSearch"=>("web","Веб-поиск",item["query"].as_str().or_else(||item["action"]["query"].as_str()).unwrap_or("")),
                "collabAgentToolCall"=>("agent","Параллельный агент",item["tool"].as_str().unwrap_or("")),
                "mcpToolCall"=>("tool","Инструмент MCP",item["tool"].as_str().unwrap_or("")),
                "plan"=>("plan","План",item["text"].as_str().unwrap_or("")),
                _=>return Ok(()),
            };
            let mut activity=json!({"task_id":job.id,"thread_id":job.thread,"item_id":item_id,
                "kind":category,"title":title,"detail":cut(detail,8000),"status":status});
            if kind=="commandExecution" {
                activity["output"]=json!(cut(item["aggregatedOutput"].as_str().unwrap_or(""),16000));
                activity["exit_code"]=item["exitCode"].clone();
            }
            if kind=="fileChange" {
                let changes:Vec<_>=item["changes"].as_array().into_iter().flatten().take(64).map(|c|
                    json!({"path":c["path"],"kind":c["kind"],"diff":cut(c["diff"].as_str().unwrap_or(""),16000)})).collect();
                activity["changes"]=json!(changes);
            }
            emit(output,"agent_activity",activity).await?;
        }
        "item/commandExecution/outputDelta"|"item/fileChange/outputDelta"=>{
            emit(output,"agent_activity",json!({"task_id":job.id,"thread_id":job.thread,"item_id":params["itemId"],
                "kind":if method.contains("commandExecution") {"command"} else {"file"},
                "title":"Вывод инструмента","detail":cut(params["delta"].as_str().unwrap_or(""),8000),"status":"running"})).await?;
        }
        "turn/diff/updated"=>emit(output,"agent_activity",json!({"task_id":job.id,"thread_id":job.thread,
            "kind":"file","title":"Изменения файлов","detail":"","diff":cut(params["diff"].as_str().unwrap_or(""),32000),"status":"completed"})).await?,
        "turn/plan/updated"=>emit(output,"agent_activity",json!({"task_id":job.id,"thread_id":job.thread,
            "kind":"plan","title":"План работы","detail":cut(&params["plan"].to_string(),8000),"status":"running"})).await?,
        "error"=>emit(output,"agent_error",json!({"task_id":job.id,"message":"Codex сообщил об ошибке выполнения","retrying":params["willRetry"].as_bool().unwrap_or(false)})).await?,
        _=>{}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_chatgpt_account_without_exposing_account_data() {
        assert!(require_chatgpt(&json!({"account":{"type":"chatgpt","email":"private"}})).is_ok());
        for value in [
            json!({"account":null}),
            json!({"account":{"type":"apiKey","secret":"private"}}),
            json!({"account":{"type":"gcp"}}),
        ] {
            let error = require_chatgpt(&value).unwrap_err().to_string();
            assert!(!error.contains("private"));
        }
    }

    #[test]
    fn catalog_uses_native_model_names_and_efforts() {
        let c = model_catalog(
            &json!({"data":[{"id":"opaque-id","model":"native-model","displayName":"Native","isDefault":true,
            "supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"ultra"}]}]}),
        );
        assert_eq!(c["models"][0]["id"], "native-model");
        assert_eq!(
            c["models"][0]["reasoning_efforts"],
            json!(["medium", "ultra"])
        );
    }
    #[test]
    fn thread_settings_never_override_approval_or_sandbox() {
        let c = Config {
            workspace: PathBuf::from("."),
            model: None,
            effort: None,
            web_search: true,
            parallel: true,
        };
        let p = thread_params(&c, false);
        assert!(p.get("approvalPolicy").is_none() && p.get("sandbox").is_none());
        assert_eq!(p["config"]["web_search"], "live");
    }
}

#[cfg(test)]
#[path = "agent_lifecycle.rs"]
mod lifecycle_tests;
