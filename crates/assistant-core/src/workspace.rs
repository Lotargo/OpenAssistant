//! App-owned temporary workspaces. Project directories are never cleanup targets.
use crate::auth::SafeError;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MARKER: &str = ".openassistant-workspace.json";
const LEASE: &str = ".lease";
const WORKSPACE: &str = "workspace";
const MAX_CLEANUP_ENTRIES: usize = 100_000;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceMode {
    #[default]
    Temporary,
    Project,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CleanupStatus {
    Active,
    Removed,
    Preserved,
    Pending,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceStatus {
    #[serde(rename = "workspace_mode")]
    pub mode: WorkspaceMode,
    pub path: PathBuf,
    pub temporary: bool,
    pub cleanup_status: CleanupStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CleanupReport {
    pub removed: usize,
    pub pending: usize,
    pub active: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    owner: String,
    version: u32,
    id: String,
}

struct OwnedWorkspace {
    entry: PathBuf,
    id: String,
}
struct LeaseState {
    lock: Option<File>,
    cleanup_status: CleanupStatus,
    message: Option<String>,
}

pub struct WorkspaceLease {
    mode: WorkspaceMode,
    path: PathBuf,
    owned: Option<OwnedWorkspace>,
    state: Mutex<LeaseState>,
}

fn error(message: &str) -> SafeError {
    SafeError::new(message)
}

fn unique_id() -> String {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{clock:032x}-{:08x}-{:016x}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn valid_id(id: &str) -> bool {
    let parts: Vec<_> = id.split('-').collect();
    parts.len() == 3
        && parts.iter().zip([32, 8, 16]).all(|(part, size)| {
            part.len() == size && part.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn guard_ancestors(path: &Path) -> Result<(), SafeError> {
    for ancestor in path.ancestors().filter(|path| !path.as_os_str().is_empty()) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_link(&metadata) => {
                return Err(error(
                    "Temporary workspace path contains a link or reparse point.",
                ));
            }
            Ok(_) => {}
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("Could not inspect the temporary workspace path.")),
        }
    }
    Ok(())
}

pub fn managed_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("OpenAssistant")
        .join("workspaces")
}

fn prepare_root(root: &Path) -> Result<PathBuf, SafeError> {
    if !root.is_absolute() {
        return Err(error("Temporary workspace root must be an absolute path."));
    }
    guard_ancestors(root)?;
    fs::create_dir_all(root)
        .map_err(|_| error("Could not create the temporary workspace root."))?;
    guard_ancestors(root)?;
    fs::canonicalize(root).map_err(|_| error("Could not resolve the temporary workspace root."))
}

pub fn project_path(path: &Path) -> Result<PathBuf, SafeError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(error(
            "Choose an existing project directory with an absolute path.",
        ));
    }
    fs::canonicalize(path).map_err(|_| error("Could not open the selected project directory."))
}

impl WorkspaceLease {
    pub fn open(mode: WorkspaceMode, project: Option<&Path>) -> Result<Self, SafeError> {
        Self::open_at(&managed_root(), mode, project)
    }

    fn open_at(
        root: &Path,
        mode: WorkspaceMode,
        project: Option<&Path>,
    ) -> Result<Self, SafeError> {
        if mode == WorkspaceMode::Project {
            let path = project_path(project.ok_or_else(|| error("Choose a project directory."))?)?;
            return Ok(Self {
                mode,
                path,
                owned: None,
                state: Mutex::new(LeaseState {
                    lock: None,
                    cleanup_status: CleanupStatus::Active,
                    message: None,
                }),
            });
        }
        let root = prepare_root(root)?;
        let id = unique_id();
        let entry = root.join(format!("session-{id}"));
        fs::create_dir(&entry)
            .map_err(|_| error("Could not create a private temporary workspace."))?;
        let created = (|| {
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(entry.join(LEASE))
                .map_err(|_| error("Could not create the temporary workspace lease."))?;
            lock.try_lock()
                .map_err(|_| error("Could not lock the temporary workspace lease."))?;
            let marker = Marker {
                owner: "OpenAssistant".into(),
                version: 1,
                id: id.clone(),
            };
            let bytes = serde_json::to_vec(&marker)
                .map_err(|_| error("Could not encode workspace ownership."))?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(entry.join(MARKER))
                .map_err(|_| error("Could not mark the temporary workspace as owned."))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| error("Could not save temporary workspace ownership."))?;
            let path = entry.join(WORKSPACE);
            fs::create_dir(&path)
                .map_err(|_| error("Could not create the empty workspace directory."))?;
            Ok(Self {
                mode,
                path,
                owned: Some(OwnedWorkspace {
                    entry: entry.clone(),
                    id,
                }),
                state: Mutex::new(LeaseState {
                    lock: Some(lock),
                    cleanup_status: CleanupStatus::Active,
                    message: None,
                }),
            })
        })();
        if created.is_err() {
            // This exact directory was created above and has never reached a model.
            let _ = fs::remove_dir_all(&entry);
        }
        created
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> WorkspaceStatus {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        WorkspaceStatus {
            mode: self.mode,
            path: self.path.clone(),
            temporary: self.owned.is_some(),
            cleanup_status: state.cleanup_status,
            message: state.message.clone(),
        }
    }

    /// Call only after the owning Codex runtime has finished or its abort has been observed.
    pub fn cleanup(&self) -> WorkspaceStatus {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(owned) = &self.owned {
            if state.cleanup_status != CleanupStatus::Removed {
                let result = (|| {
                    if !owned
                        .entry
                        .try_exists()
                        .map_err(|_| error("Could not check workspace cleanup."))?
                    {
                        state.lock.take();
                        return Ok(());
                    }
                    validate_owned(&owned.entry, &owned.id)?;
                    let lock = match state.lock.take() {
                        Some(lock) => lock,
                        None => acquire_lease(&owned.entry)?
                            .ok_or_else(|| error("Temporary workspace is still in use."))?,
                    };
                    remove_owned(&owned.entry, &owned.id, lock)
                })();
                match result {
                    Ok(()) => {
                        state.cleanup_status = CleanupStatus::Removed;
                        state.message = None;
                    }
                    Err(cause) => {
                        state.lock.take();
                        state.cleanup_status = CleanupStatus::Pending;
                        state.message = Some(cause.to_string());
                    }
                }
            }
        } else {
            state.cleanup_status = CleanupStatus::Preserved;
        }
        drop(state);
        self.status()
    }
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        // Stop/disconnect await cleanup explicitly. This is a best-effort fallback;
        // a crash or a locked file leaves its marker for the next startup sweep.
        let _ = self.cleanup();
    }
}

fn validate_owned(entry: &Path, id: &str) -> Result<(), SafeError> {
    if !valid_id(id)
        || entry.file_name().and_then(|name| name.to_str()) != Some(&format!("session-{id}"))
    {
        return Err(error("Temporary workspace ownership is invalid."));
    }
    guard_ancestors(entry)?;
    let metadata =
        fs::symlink_metadata(entry).map_err(|_| error("Could not inspect workspace ownership."))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(error(
            "Temporary workspace directory is not a regular directory.",
        ));
    }
    let marker = entry.join(MARKER);
    let metadata = fs::symlink_metadata(&marker)
        .map_err(|_| error("Temporary workspace ownership marker is missing."))?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > 4096 {
        return Err(error("Temporary workspace ownership marker is invalid."));
    }
    let bytes = fs::read(marker).map_err(|_| error("Could not read workspace ownership."))?;
    let marker: Marker = serde_json::from_slice(&bytes)
        .map_err(|_| error("Temporary workspace ownership marker is invalid."))?;
    if marker.owner != "OpenAssistant" || marker.version != 1 || marker.id != id {
        return Err(error("Temporary workspace ownership does not match."));
    }
    Ok(())
}

fn acquire_lease(entry: &Path) -> Result<Option<File>, SafeError> {
    let path = entry.join(LEASE);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| error("Temporary workspace lease is missing."))?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(error("Temporary workspace lease is invalid."));
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| error("Could not open the temporary workspace lease."))?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(_) => Err(error("Could not lock the temporary workspace lease.")),
    }
}

fn guard_tree(entry: &Path) -> Result<(), SafeError> {
    let mut queue = vec![(entry.to_owned(), 0usize)];
    let mut count = 0usize;
    while let Some((path, depth)) = queue.pop() {
        count += 1;
        if count > MAX_CLEANUP_ENTRIES || depth > 128 {
            return Err(error(
                "Temporary workspace exceeds the automatic cleanup limit.",
            ));
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| error("Could not inspect files before workspace cleanup."))?;
        if is_link(&metadata) {
            return Err(error(
                "Temporary workspace contains a link or reparse point; automatic cleanup was skipped.",
            ));
        }
        if metadata.is_dir() {
            for child in fs::read_dir(path)
                .map_err(|_| error("Could not inspect temporary workspace contents."))?
            {
                let child =
                    child.map_err(|_| error("Could not inspect a temporary workspace file."))?;
                queue.push((child.path(), depth + 1));
            }
        }
    }
    Ok(())
}

fn remove_owned(entry: &Path, id: &str, lock: File) -> Result<(), SafeError> {
    validate_owned(entry, id)?;
    guard_tree(entry)?;
    // Hold the lease throughout content removal so another app instance cannot
    // mistake an active workspace for stale files. No symlinks are traversed.
    let workspace = entry.join(WORKSPACE);
    if workspace
        .try_exists()
        .map_err(|_| error("Could not inspect the temporary workspace."))?
    {
        fs::remove_dir_all(&workspace)
            .map_err(|_| error("Temporary files could not be removed; cleanup will be retried."))?;
    }
    drop(lock);
    fs::remove_dir_all(entry)
        .map_err(|_| error("Workspace metadata could not be removed; cleanup will be retried."))
}

pub fn cleanup_stale() -> Result<CleanupReport, SafeError> {
    cleanup_stale_at(&managed_root())
}

fn cleanup_stale_at(root: &Path) -> Result<CleanupReport, SafeError> {
    let mut report = CleanupReport::default();
    if !root
        .try_exists()
        .map_err(|_| error("Could not inspect temporary workspace storage."))?
    {
        return Ok(report);
    }
    guard_ancestors(root)?;
    for entry in
        fs::read_dir(root).map_err(|_| error("Could not inspect temporary workspace storage."))?
    {
        let entry = entry.map_err(|_| error("Could not inspect a temporary workspace entry."))?;
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix("session-"))
            .filter(|id| valid_id(id))
        else {
            continue;
        };
        // Unknown, unmarked or redirected directories are never cleanup targets.
        if validate_owned(&entry.path(), id).is_err() {
            continue;
        }
        match acquire_lease(&entry.path()) {
            Ok(None) => report.active += 1,
            Ok(Some(lock)) => match remove_owned(&entry.path(), id, lock) {
                Ok(()) => report.removed += 1,
                Err(_) => report.pending += 1,
            },
            Err(_) => report.pending += 1,
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("openassistant-workspace-test-{}", unique_id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn temporary_workspace_is_empty_and_cleanup_removes_generated_files() {
        let root = TestRoot::new();
        let lease = WorkspaceLease::open_at(&root.0, WorkspaceMode::Temporary, None).unwrap();
        assert_eq!(fs::read_dir(lease.path()).unwrap().count(), 0);
        fs::write(lease.path().join("scenario.py"), "print('temporary')").unwrap();
        let entry = lease.path().parent().unwrap().to_owned();
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Removed);
        assert!(!entry.exists());
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Removed);
    }

    #[test]
    fn active_lease_is_spared_and_abandoned_lease_is_removed() {
        let root = TestRoot::new();
        let lease = WorkspaceLease::open_at(&root.0, WorkspaceMode::Temporary, None).unwrap();
        fs::write(lease.path().join("example.txt"), "example").unwrap();
        let report = cleanup_stale_at(&root.0).unwrap();
        assert_eq!((report.active, report.removed), (1, 0));
        // Closing the OS handle models a crashed process while preserving its marker.
        lease.state.lock().unwrap().lock.take();
        let report = cleanup_stale_at(&root.0).unwrap();
        assert_eq!((report.active, report.removed, report.pending), (0, 1, 0));
    }

    #[test]
    fn project_and_unmarked_directories_are_never_swept() {
        let root = TestRoot::new();
        let project = root.0.join("project");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("important.txt"), "keep").unwrap();
        let lease =
            WorkspaceLease::open_at(&root.0, WorkspaceMode::Project, Some(&project)).unwrap();
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Preserved);
        let unknown = root.0.join(format!("session-{}", unique_id()));
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("user.txt"), "keep").unwrap();
        assert_eq!(cleanup_stale_at(&root.0).unwrap().removed, 0);
        assert_eq!(
            fs::read_to_string(project.join("important.txt")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(unknown.join("user.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn ownership_mismatch_reports_pending_instead_of_claiming_removal() {
        let root = TestRoot::new();
        let lease = WorkspaceLease::open_at(&root.0, WorkspaceMode::Temporary, None).unwrap();
        let marker = lease.path().parent().unwrap().join(MARKER);
        let original = fs::read(&marker).unwrap();
        fs::write(&marker, "{}").unwrap();
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Pending);
        assert!(lease.path().exists());
        fs::write(&marker, original).unwrap();
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Removed);
    }

    #[cfg(windows)]
    #[test]
    fn reparse_point_cleanup_never_follows_an_external_directory() {
        let root = TestRoot::new();
        let external = root.0.join("external-project");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("important.txt"), "keep").unwrap();
        let lease = WorkspaceLease::open_at(&root.0, WorkspaceMode::Temporary, None).unwrap();
        let link = lease.path().join("external-link");
        let result = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&external)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "could not create the test junction"
        );
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Pending);
        assert_eq!(
            fs::read_to_string(external.join("important.txt")).unwrap(),
            "keep"
        );
        fs::remove_dir(&link).unwrap();
        assert_eq!(lease.cleanup().cleanup_status, CleanupStatus::Removed);
        assert_eq!(
            fs::read_to_string(external.join("important.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn invalid_project_does_not_fall_back_to_a_current_directory() {
        assert!(project_path(Path::new("relative")).is_err());
        let root = TestRoot::new();
        assert!(WorkspaceLease::open_at(&root.0, WorkspaceMode::Project, None).is_err());
    }
}
