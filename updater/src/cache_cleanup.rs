//! Conservative cache cleanup for content-addressed official packages.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install,
    state::{PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Debug, Default, Serialize)]
pub struct CleanupReport {
    pub dry_run: bool,
    pub retained: Vec<PathBuf>,
    pub targets: Vec<PathBuf>,
    pub estimated_bytes: u64,
    pub removed: Vec<PathBuf>,
    pub removed_bytes: u64,
    pub skipped: Vec<String>,
}

/// Caller must hold check.lock for the entire plan/validation/removal operation.
/// This deliberately leaves updater state unchanged, including network failures.
pub fn clean(
    config: &RuntimeConfig,
    paths: &RuntimePaths,
    state: &PersistedState,
    apply: bool,
) -> Result<CleanupReport> {
    let mut report = plan(config, paths, state)?;
    report.dry_run = !apply;
    if !report.skipped.is_empty() && report.targets.is_empty() {
        return Ok(report);
    }
    // Check native metadata and the signed upstream hash before deleting anything.
    for (path, expected) in [
        (
            &state.artifact_paths.rollback_package_path,
            state.last_known_good_version.as_deref(),
        ),
        (
            &state.artifact_paths.package_path,
            if state.candidate_version.is_none() {
                Some(state.installed_version.as_str())
            } else {
                None
            },
        ),
    ] {
        if let Some(path) = path {
            install::ensure_codex_package(path)?;
            let version = install::package_version(path)?;
            if let Some(expected) = expected {
                anyhow::ensure!(
                    version == expected,
                    "Retained package version mismatch: {}",
                    path.display()
                );
            }
        }
    }
    let hashes: Vec<_> = report
        .retained
        .iter()
        .filter(|p| p.is_file())
        .map(|p| Ok((p.clone(), hash_file(p)?)))
        .collect::<Result<_>>()?;
    if let (Some(path), Some(expected)) = (
        &state.artifact_paths.upstream_package_path,
        &state.upstream_package_sha256,
    ) {
        anyhow::ensure!(
            hashes.iter().any(|(p, h)| p == path && h == expected),
            "Retained upstream package hash mismatch"
        );
    }
    if apply {
        let guards = Guards::read()?;
        for path in report.targets.clone() {
            // Recheck boundaries and process use immediately before each removal.
            let bytes = match inspect_target(&path, &guards) {
                Ok(bytes) => bytes,
                Err(e) => {
                    report.skipped.push(format!("{}: {e:#}", path.display()));
                    continue;
                }
            };
            if path.is_dir() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
            report.removed_bytes += bytes;
            report.removed.push(path.clone());
            tracing::info!(path = %path.display(), bytes, "removed updater cache artifact");
        }
        for (path, hash) in hashes {
            anyhow::ensure!(
                hash_file(&path)? == hash,
                "Retained package changed: {}",
                path.display()
            );
        }
    }
    Ok(report)
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn plan(
    config: &RuntimeConfig,
    paths: &RuntimePaths,
    state: &PersistedState,
) -> Result<CleanupReport> {
    let mut report = CleanupReport::default();
    if state.manual_recovery_required
        || state.install_transaction.is_some()
        || !matches!(
            state.status,
            UpdateStatus::Idle
                | UpdateStatus::Installed
                | UpdateStatus::Failed
                | UpdateStatus::ReadyToInstall
                | UpdateStatus::WaitingForAppExit
        )
    {
        report
            .skipped
            .push("Updater is busy, interrupted, or requires manual recovery".into());
        return Ok(report);
    }
    if state.installed_version == "unknown"
        || (state.artifact_paths.package_path.is_none()
            && state.artifact_paths.rollback_package_path.is_none())
    {
        report
            .skipped
            .push("No recorded managed package; cannot safely identify retained versions".into());
        return Ok(report);
    }
    if state.last_known_good_version.is_some()
        && state.artifact_paths.rollback_package_path.is_none()
    {
        report
            .skipped
            .push("Known-good version has no rollback package path".into());
        return Ok(report);
    }
    let root = &paths.cache_dir;
    anyhow::ensure!(
        root.is_absolute() && root.canonicalize()? == *root,
        "Cache root must not contain symlinks"
    );
    if config.workspace_root != *root {
        report
            .skipped
            .push("Custom workspace root: automatic workspace cleanup is disabled".into());
        return Ok(report);
    }
    for p in [
        &state.artifact_paths.package_path,
        &state.artifact_paths.rollback_package_path,
        &state.artifact_paths.upstream_package_path,
    ]
    .into_iter()
    .flatten()
    {
        anyhow::ensure!(
            p.starts_with(root) && p.canonicalize()? == *p,
            "Retained artifact escapes cache or uses symlinks: {}",
            p.display()
        );
        let metadata = fs::symlink_metadata(p)?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() > 0,
            "Retained artifact is missing/empty: {}",
            p.display()
        );
        report.retained.push(p.clone());
    }
    report.retained.sort();
    report.retained.dedup();
    // A failed or incomplete candidate can still be needed for recovery/debugging.
    if state.candidate_version.is_some()
        && (state.status == UpdateStatus::Failed || state.artifact_paths.package_path.is_none())
    {
        if let Some(workspace) = &state.artifact_paths.workspace_dir {
            anyhow::ensure!(
                workspace.starts_with(root.join("workspaces"))
                    && workspace.canonicalize()? == *workspace,
                "Invalid candidate workspace"
            );
            report.retained.push(workspace.clone());
        } else {
            report
                .skipped
                .push("Incomplete candidate has no workspace identity".into());
            return Ok(report);
        }
    }
    let packages = root.join("packages");
    if packages.exists() {
        anyhow::ensure!(
            packages.canonicalize()? == packages,
            "Symlinked package cache"
        );
        for entry in fs::read_dir(&packages)? {
            let p = entry?.path();
            let name = p.file_name().unwrap().to_string_lossy();
            // A manually prefetched signed upstream package may not be bound
            // to state until the next metadata check (the prebuild prune handles it).
            if name.starts_with("chatgpt-")
                && name.ends_with(".deb")
                && newest_age(&p)? < Duration::from_secs(24 * 3600)
            {
                continue;
            }
            if is_package(&name)
                || (name.starts_with("metadata-")
                    && (name.ends_with("-probe") || name.ends_with("-download")))
            {
                select(&p, &report.retained.clone(), &mut report.targets)?;
            }
        }
    }
    let workspaces = root.join("workspaces");
    if workspaces.exists() {
        anyhow::ensure!(
            workspaces.canonicalize()? == workspaces,
            "Symlinked workspaces root"
        );
        for entry in fs::read_dir(&workspaces)? {
            let p = entry?.path();
            let name = p.file_name().unwrap().to_string_lossy();
            if !name.starts_with(|c: char| c.is_ascii_digit())
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".+-_".contains(c))
            {
                continue;
            }
            anyhow::ensure!(
                !fs::symlink_metadata(&p)?.file_type().is_symlink(),
                "Symlinked workspace: {}",
                p.display()
            );
            if !p.is_dir() || report.retained.iter().any(|k| p.starts_with(k)) {
                continue;
            }
            for part in ["builder", "codex-app", "tmp", "dist"] {
                let child = p.join(part);
                if child.try_exists()? {
                    select(&child, &report.retained.clone(), &mut report.targets)?;
                }
            }
            for part in ["logs", "reports"] {
                let child = p.join(part);
                if child.try_exists()? && newest_age(&child)? >= LOG_RETENTION {
                    select(&child, &report.retained.clone(), &mut report.targets)?;
                }
            }
        }
    }
    report.targets.sort();
    let guards = Guards::read()?;
    let targets = std::mem::take(&mut report.targets);
    for p in targets {
        match inspect_target(&p, &guards) {
            Ok(bytes) => {
                report.estimated_bytes += bytes;
                report.targets.push(p);
            }
            Err(e) => report.skipped.push(format!("{}: {e:#}", p.display())),
        }
    }
    Ok(report)
}

fn is_package(name: &str) -> bool {
    name.ends_with(".deb") || name.ends_with(".rpm") || name.contains(".pkg.tar.")
}

fn select(path: &Path, keep: &[PathBuf], targets: &mut Vec<PathBuf>) -> Result<()> {
    if keep.iter().any(|k| path.starts_with(k)) {
        return Ok(());
    }
    if keep.iter().any(|k| k.starts_with(path)) {
        anyhow::ensure!(
            path.is_dir() && path.canonicalize()? == path,
            "Invalid retained ancestor"
        );
        for entry in fs::read_dir(path)? {
            select(&entry?.path(), keep, targets)?;
        }
    } else {
        targets.push(path.to_path_buf());
    }
    Ok(())
}

fn newest_age(path: &Path) -> Result<Duration> {
    let meta = fs::symlink_metadata(path)?;
    let mut age = SystemTime::now()
        .duration_since(meta.modified()?)
        .unwrap_or_default();
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            age = age.min(newest_age(&entry?.path())?);
        }
    }
    Ok(age)
}

#[derive(Default)]
struct Guards {
    mounts: Vec<PathBuf>,
    used: Vec<PathBuf>,
}
impl Guards {
    fn read() -> Result<Self> {
        let mounts = fs::read_to_string("/proc/self/mountinfo")?
            .lines()
            .filter_map(|s| s.split_whitespace().nth(4))
            .map(|s| {
                PathBuf::from(
                    s.replace("\\040", " ")
                        .replace("\\011", "\t")
                        .replace("\\012", "\n")
                        .replace("\\134", "\\"),
                )
            })
            .collect();
        let mut result = Self {
            mounts,
            used: Vec::new(),
        };
        for proc in fs::read_dir("/proc")? {
            let proc = proc?.path();
            if proc
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.parse::<u32>().ok())
                .is_none_or(|pid| pid == std::process::id())
            {
                continue;
            }
            for part in ["cwd", "exe"] {
                if let Ok(p) = fs::read_link(proc.join(part)) {
                    result.used.push(p);
                }
            }
            if let Ok(entries) = fs::read_dir(proc.join("fd")) {
                for entry in entries.flatten() {
                    if let Ok(p) = fs::read_link(entry.path()) {
                        result.used.push(p);
                    }
                }
            }
            if let Ok(maps) = fs::read_to_string(proc.join("maps")) {
                for line in maps.lines() {
                    if let Some(start) = line.find('/') {
                        result
                            .used
                            .push(PathBuf::from(line[start..].trim_end_matches(" (deleted)")));
                    }
                }
            }
        }
        Ok(result)
    }
}

fn inspect_target(path: &Path, guards: &Guards) -> Result<u64> {
    anyhow::ensure!(path.canonicalize()? == path, "Target contains a symlink");
    anyhow::ensure!(
        !guards.mounts.iter().any(|p| p.starts_with(path)),
        "Mounted directory inside target"
    );
    anyhow::ensure!(
        !guards.used.iter().any(|p| p.starts_with(path)),
        "Target is in use by a process"
    );
    tree_bytes(path, fs::symlink_metadata(path)?.dev())
}

fn tree_bytes(path: &Path, dev: u64) -> Result<u64> {
    let meta =
        fs::symlink_metadata(path).with_context(|| format!("Inspecting {}", path.display()))?;
    anyhow::ensure!(meta.dev() == dev, "Filesystem boundary inside target");
    let mut bytes = meta.blocks() * 512;
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            bytes += tree_bytes(&entry?.path(), dev)?;
        }
    }
    Ok(bytes)
}

pub fn prune(cache_root: &Path, state: &PersistedState) -> Result<usize> {
    let mut retained = BTreeSet::new();
    for path in [
        state.artifact_paths.upstream_package_path.as_ref(),
        state.artifact_paths.package_path.as_ref(),
        state.artifact_paths.rollback_package_path.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        retained.insert(path.canonicalize()?);
    }
    let mut removed = 0;
    let package_dir = cache_root.join("packages");
    if !package_dir.is_dir() {
        return Ok(0);
    }
    for entry in fs::read_dir(package_dir)? {
        let path = entry?.path();
        if path.is_file()
            && path.extension().and_then(|v| v.to_str()) == Some("deb")
            && !retained.contains(&path.canonicalize()?)
        {
            fs::remove_file(path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{InstallOperation, InstallTransaction};
    use std::os::unix::fs::symlink;

    struct Fixture {
        _temp: tempfile::TempDir,
        paths: RuntimePaths,
        config: RuntimeConfig,
        state: PersistedState,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let temp = tempfile::tempdir()?;
            let root = temp.path().join("cache");
            let paths = RuntimePaths {
                config_file: temp.path().join("config.toml"),
                state_file: temp.path().join("state/state.json"),
                log_file: temp.path().join("state/service.log"),
                cache_dir: root.clone(),
                state_dir: temp.path().join("state"),
                config_dir: temp.path().join("config"),
            };
            paths.ensure_dirs()?;
            let mut state = PersistedState::new(true);
            state.installed_version = "2.0".into();
            state.last_known_good_version = Some("1.0".into());
            state.artifact_paths.package_path =
                Some(write(&root.join("workspaces/26.2/dist/current.deb"))?);
            state.artifact_paths.rollback_package_path =
                Some(write(&root.join("workspaces/26.1/dist/rollback.deb"))?);
            state.artifact_paths.upstream_package_path =
                Some(write(&root.join("packages/upstream.deb"))?);
            state.upstream_package_sha256 = Some(hash_file(
                state.artifact_paths.upstream_package_path.as_ref().unwrap(),
            )?);
            state.artifact_paths.workspace_dir = Some(root.join("workspaces/26.2"));
            let config = RuntimeConfig {
                workspace_root: root,
                ..RuntimeConfig::default()
            };
            Ok(Self {
                _temp: temp,
                paths,
                config,
                state,
            })
        }
        fn plan(&self) -> Result<CleanupReport> {
            plan(&self.config, &self.paths, &self.state)
        }
        fn file(&self, path: &str) -> Result<PathBuf> {
            write(&self.paths.cache_dir.join(path))
        }
    }
    fn write(p: &Path) -> Result<PathBuf> {
        fs::create_dir_all(p.parent().unwrap())?;
        fs::write(p, b"fixture package")?;
        Ok(p.to_path_buf())
    }
    fn selected(report: &CleanupReport, file: &Path) -> bool {
        report.targets.iter().any(|p| file.starts_with(p))
    }

    #[test]
    fn plans_old_workspaces_and_intermediates_but_keeps_three_recorded_packages() -> Result<()> {
        let f = Fixture::new()?;
        let old = f.file("workspaces/26.0/dist/old.deb")?;
        let builder = f.file("workspaces/26.2/builder/tool")?;
        let app = f.file("workspaces/26.1/codex-app/app")?;
        let metadata = f.file("packages/metadata-123-probe/Packages")?;
        let report = f.plan()?;
        for p in [old, builder, app, metadata] {
            assert!(selected(&report, &p));
            assert!(p.exists());
        }
        for p in &report.retained {
            assert!(!selected(&report, p));
        }
        assert_eq!(report.retained.len(), 3);
        Ok(())
    }
    #[test]
    fn pending_candidate_and_rollback_survive_while_finished_build_is_removed() -> Result<()> {
        let mut f = Fixture::new()?;
        f.state.status = UpdateStatus::WaitingForAppExit;
        f.state.candidate_version = Some("26.2".into());
        let tmp = f.file("workspaces/26.2/tmp/unpacked")?;
        let report = f.plan()?;
        assert!(selected(&report, &tmp));
        assert!(!selected(
            &report,
            f.state.artifact_paths.package_path.as_ref().unwrap()
        ));
        assert!(!selected(
            &report,
            f.state
                .artifact_paths
                .rollback_package_path
                .as_ref()
                .unwrap()
        ));
        Ok(())
    }
    #[test]
    fn failed_candidate_workspace_is_retained_but_network_failure_does_not_block_cleanup(
    ) -> Result<()> {
        let mut f = Fixture::new()?;
        let tmp = f.file("workspaces/26.2/tmp/unpacked")?;
        f.state.status = UpdateStatus::Failed;
        assert!(selected(&f.plan()?, &tmp));
        f.state.candidate_version = Some("26.2".into());
        assert!(!selected(&f.plan()?, &tmp));
        Ok(())
    }
    #[test]
    fn refuses_active_states_recovery_and_unfinished_transaction() -> Result<()> {
        let mut f = Fixture::new()?;
        f.file("workspaces/26.0/dist/old.deb")?;
        for status in [
            UpdateStatus::CheckingUpstream,
            UpdateStatus::DownloadingPackage,
            UpdateStatus::PreparingWorkspace,
            UpdateStatus::PatchingApp,
            UpdateStatus::BuildingPackage,
            UpdateStatus::Installing,
        ] {
            f.state.status = status;
            assert!(f.plan()?.targets.is_empty());
        }
        f.state.status = UpdateStatus::Idle;
        f.state.manual_recovery_required = true;
        assert!(f.plan()?.targets.is_empty());
        f.state.manual_recovery_required = false;
        f.state.install_transaction = Some(InstallTransaction {
            package_path: f.state.artifact_paths.package_path.clone().unwrap(),
            package_sha256: None,
            package_command: None,
            started_at: chrono::Utc::now(),
            operation: InstallOperation::Update,
        });
        assert!(f.plan()?.targets.is_empty());
        Ok(())
    }
    #[test]
    fn missing_retained_package_aborts_before_deletion() -> Result<()> {
        let f = Fixture::new()?;
        let old = f.file("workspaces/26.0/dist/old.deb")?;
        fs::remove_file(
            f.state
                .artifact_paths
                .rollback_package_path
                .as_ref()
                .unwrap(),
        )?;
        assert!(f.plan().is_err());
        assert!(old.exists());
        Ok(())
    }
    #[test]
    fn rejects_symlinked_workspace_or_protected_artifact() -> Result<()> {
        let f = Fixture::new()?;
        let outside = f._temp.path().join("outside");
        fs::create_dir(&outside)?;
        symlink(&outside, f.paths.cache_dir.join("workspaces/26.9"))?;
        assert!(f.plan().is_err());
        fs::remove_file(f.paths.cache_dir.join("workspaces/26.9"))?;
        let keep = f
            .state
            .artifact_paths
            .rollback_package_path
            .as_ref()
            .unwrap();
        fs::remove_file(keep)?;
        let file = write(&outside.join("secret.deb"))?;
        symlink(&file, keep)?;
        assert!(f.plan().is_err());
        Ok(())
    }
    #[test]
    fn skips_external_workspaces_unknown_state_and_unmanaged_content() -> Result<()> {
        let mut f = Fixture::new()?;
        let custom = f.file("user-notes/important.txt")?;
        let unknown = f.file("workspaces/my-project/dist/important.deb")?;
        let report = f.plan()?;
        assert!(!selected(&report, &custom));
        assert!(!selected(&report, &unknown));
        f.config.workspace_root = f._temp.path().join("other");
        assert!(f.plan()?.targets.is_empty());
        f.config.workspace_root = f.paths.cache_dir.clone();
        f.state.installed_version = "unknown".into();
        assert!(f.plan()?.targets.is_empty());
        Ok(())
    }
    #[test]
    fn expires_only_old_diagnostics() -> Result<()> {
        let f = Fixture::new()?;
        let log = f.file("workspaces/26.0/logs/install.log")?;
        assert!(!selected(&f.plan()?, &log));
        let old = SystemTime::now() - Duration::from_secs(8 * 86400);
        for p in [&log, log.parent().unwrap()] {
            fs::File::open(p)?.set_times(fs::FileTimes::new().set_modified(old))?;
        }
        assert!(selected(&f.plan()?, &log));
        Ok(())
    }
    #[test]
    fn guards_mounts_including_same_device_bind_mounts_and_open_files() -> Result<()> {
        let f = Fixture::new()?;
        let file = f.file("workspaces/26.0/tmp/data")?;
        let target = file.parent().unwrap();
        assert!(inspect_target(
            target,
            &Guards {
                mounts: vec![file.clone()],
                used: vec![]
            }
        )
        .is_err());
        assert!(inspect_target(
            target,
            &Guards {
                mounts: vec![],
                used: vec![file.clone()]
            }
        )
        .is_err());
        Ok(())
    }
    #[test]
    fn actual_child_process_using_cache_is_detected() -> Result<()> {
        let f = Fixture::new()?;
        let file = f.file("workspaces/26.0/tmp/data")?;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .stdout(fs::File::open(&file)?)
            .spawn()?;
        let result = f.plan();
        child.kill()?;
        child.wait()?;
        let report = result?;
        assert!(!selected(&report, &file));
        assert!(report.skipped.iter().any(|s| s.contains("in use")));
        Ok(())
    }
    #[test]
    fn native_packages_are_preserved_and_cleanup_is_idempotent() -> Result<()> {
        if !Path::new("/usr/bin/dpkg-deb").exists() {
            return Ok(());
        }
        let f = Fixture::new()?;
        for (p, version) in [
            (f.state.artifact_paths.package_path.as_ref().unwrap(), "2.0"),
            (
                f.state
                    .artifact_paths
                    .rollback_package_path
                    .as_ref()
                    .unwrap(),
                "1.0",
            ),
        ] {
            let tree = f._temp.path().join(format!("deb-{version}"));
            fs::create_dir_all(tree.join("DEBIAN"))?;
            fs::write(tree.join("DEBIAN/control"),format!("Package: codex-desktop\nVersion: {version}\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDescription: cleanup fixture\n"))?;
            assert!(std::process::Command::new("/usr/bin/dpkg-deb")
                .args(["--build", "--root-owner-group"])
                .arg(&tree)
                .arg(p)
                .stdout(std::process::Stdio::null())
                .status()?
                .success());
        }
        let old = f.file("workspaces/26.0/dist/old.deb")?;
        let report = clean(&f.config, &f.paths, &f.state, false)?;
        assert!(selected(&report, &old));
        assert!(old.exists());
        let report = clean(&f.config, &f.paths, &f.state, true)?;
        assert!(!old.exists());
        assert!(report.removed_bytes > 0);
        for p in report.retained {
            assert!(p.exists());
        }
        assert!(clean(&f.config, &f.paths, &f.state, true)?
            .removed
            .is_empty());
        Ok(())
    }
    #[test]
    fn corrupt_package_prevents_any_deletion() -> Result<()> {
        let f = Fixture::new()?;
        let old = f.file("workspaces/26.0/dist/old.deb")?;
        assert!(clean(&f.config, &f.paths, &f.state, true).is_err());
        assert!(old.exists());
        Ok(())
    }
    #[test]
    fn prebuild_prune_keeps_just_downloaded_candidate_and_rollback() -> Result<()> {
        let f = Fixture::new()?;
        let stale = f.file("packages/obsolete.deb")?;
        assert_eq!(prune(&f.paths.cache_dir, &f.state)?, 1);
        assert!(!stale.exists());
        assert!(f
            .state
            .artifact_paths
            .upstream_package_path
            .as_ref()
            .unwrap()
            .exists());
        assert!(f
            .state
            .artifact_paths
            .rollback_package_path
            .as_ref()
            .unwrap()
            .exists());
        Ok(())
    }

    #[test]
    fn prefetch_grace_expires_and_rotated_backup_is_removed() -> Result<()> {
        let mut f = Fixture::new()?;
        let prefetch = f.file("packages/chatgpt-26.3-amd64-prefetched.deb")?;
        assert!(!selected(&f.plan()?, &prefetch));
        fs::File::open(&prefetch)?.set_times(
            fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(25 * 3600)),
        )?;
        assert!(selected(&f.plan()?, &prefetch));
        let previous = f
            .state
            .artifact_paths
            .rollback_package_path
            .clone()
            .unwrap();
        f.state.artifact_paths.rollback_package_path = f.state.artifact_paths.package_path.clone();
        f.state.artifact_paths.package_path = Some(f.file("workspaces/26.3/dist/new.deb")?);
        assert!(selected(&f.plan()?, &previous));
        assert!(!selected(
            &f.plan()?,
            f.state
                .artifact_paths
                .rollback_package_path
                .as_ref()
                .unwrap()
        ));
        Ok(())
    }

    #[test]
    fn nested_symlink_is_not_followed_and_legacy_state_without_packages_is_untouched() -> Result<()>
    {
        let mut f = Fixture::new()?;
        let outside = write(&f._temp.path().join("private/data"))?;
        let dir = f.paths.cache_dir.join("workspaces/26.0/tmp");
        fs::create_dir_all(&dir)?;
        symlink(outside.parent().unwrap(), dir.join("link"))?;
        let report = f.plan()?;
        assert!(selected(&report, &dir));
        fs::remove_dir_all(&dir)?;
        assert!(outside.exists());
        f.state.artifact_paths = Default::default();
        assert!(f.plan()?.targets.is_empty());
        Ok(())
    }
}
