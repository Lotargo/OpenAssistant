use super::*;
use std::fs::OpenOptions;

#[tokio::test]
async fn abort_finishes_before_temporary_workspace_files_are_removed() {
    let workspace = Arc::new(WorkspaceLease::open(WorkspaceMode::Temporary, None).unwrap());
    let path = workspace.path().to_owned();
    let file_path = path.join("active-task.txt");
    let last_workspace = Arc::new(StdMutex::new(None));
    let (input, receiver) = mpsc::channel(1);
    let (opened, ready) = tokio::sync::oneshot::channel();
    let run = tokio::spawn(async move {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options.open(file_path).unwrap();
        opened.send(()).unwrap();
        std::future::pending::<()>().await;
        drop(file);
        drop(receiver);
    });
    ready.await.unwrap();
    let session = NativeSession {
        id: 500,
        view_epoch: 0,
        input,
        run,
        forward: tokio::spawn(std::future::pending()),
        workspace,
        last_workspace: last_workspace.clone(),
        on_event: None,
        audio: Arc::new(BroadcastAudio::default()),
        voice_control: session::BroadcastControl::default(),
    };
    session.stop().await;
    assert!(!path.exists());
    assert_eq!(
        last_workspace
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .cleanup_status,
        CleanupStatus::Removed
    );
}
