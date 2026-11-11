use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = hmac_sha256::Hash::hash(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn is_ignored_junk(name: &str) -> bool {
    matches!(
        name,
        ".DS_Store" | "Desktop.ini" | "Thumbs.db" | "ehthumbs.db"
    ) || name.starts_with("._")
}

pub fn is_claude_reserved_skill(name: &str) -> bool {
    name.eq_ignore_ascii_case("synced") || name.eq_ignore_ascii_case(".trash")
}

pub fn is_git_reserved(name: &str) -> bool {
    name.eq_ignore_ascii_case(".git")
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let is_abs = path.is_absolute();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                } else if !is_abs {
                    out.push("..");
                }
            }
            Component::Normal(seg) => out.push(seg),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

pub fn resolve_symlink_lexical(link_path: &Path) -> std::io::Result<PathBuf> {
    let raw = fs::read_link(link_path)?;
    if raw.is_absolute() {
        Ok(normalize_lexical(&raw))
    } else {
        let parent = link_path.parent().unwrap_or_else(|| Path::new("."));
        Ok(normalize_lexical(&parent.join(raw)))
    }
}

/// Compute a relative symlink value when both paths live under `anchor`, otherwise return `target_path`.
pub fn preferred_link_value(link_path: &Path, target_path: &Path, anchor: &Path) -> PathBuf {
    let link_norm = normalize_lexical(link_path);
    let target_norm = normalize_lexical(target_path);
    let anchor_norm = normalize_lexical(anchor);

    if link_norm.starts_with(&anchor_norm)
        && target_norm.starts_with(&anchor_norm)
        && let Some(parent) = link_norm.parent()
        && let Some(rel) = diff_paths(&target_norm, parent)
    {
        return rel;
    }
    target_norm
}

pub fn diff_paths(target: &Path, base: &Path) -> Option<PathBuf> {
    if target.is_absolute() != base.is_absolute() {
        return None;
    }
    let target_comps: Vec<_> = target.components().collect();
    let base_comps: Vec<_> = base.components().collect();
    let mut common = 0usize;
    while common < target_comps.len()
        && common < base_comps.len()
        && target_comps[common] == base_comps[common]
    {
        common += 1;
    }
    let mut out = PathBuf::new();
    for comp in &base_comps[common..] {
        if matches!(comp, Component::Normal(_)) {
            out.push("..");
        } else {
            return None;
        }
    }
    for comp in &target_comps[common..] {
        out.push(comp.as_os_str());
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    Some(out)
}

pub fn symlink_points_to(link_path: &Path, expected_target: &Path) -> bool {
    let Ok(resolved_lex) = resolve_symlink_lexical(link_path) else {
        return false;
    };
    let expected_lex = normalize_lexical(expected_target);
    if resolved_lex == expected_lex {
        return true;
    }
    match (
        fs::canonicalize(&resolved_lex),
        fs::canonicalize(&expected_lex),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn unique_temp_path(parent: &Path, label: &OsStr) -> PathBuf {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let name = format!(".overlord-{}-{pid}-{n}.tmp", label.to_string_lossy());
    parent.join(name)
}

pub fn write_atomic(path: &Path, contents: &[u8], mode: Option<u32>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    let label = path.file_name().unwrap_or_else(|| OsStr::new("file"));
    let tmp = unique_temp_path(parent, label);

    let result = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        if let Some(m) = mode {
            f.set_permissions(fs::Permissions::from_mode(m))?;
        }
        f.write_all(contents)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        Ok(())
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Failed to write {}: {e}", path.display()));
    }
    Ok(())
}

/// Create or replace `link_path` (including replacing an existing directory or file) with a symlink to `link_value`.
pub fn set_symlink(link_path: &Path, link_value: &Path) -> Result<(), String> {
    let parent = link_path
        .parent()
        .ok_or_else(|| format!("Symlink path has no parent: {}", link_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;

    let label = link_path.file_name().unwrap_or_else(|| OsStr::new("link"));
    if let Ok(meta) = fs::symlink_metadata(link_path) {
        if meta.is_dir() && !meta.file_type().is_symlink() {
            // Directory cannot be atomically overwritten by rename(symlink, dir) on POSIX;
            // displace to a temporary backup in the same parent, place the symlink, then delete backup.
            let backup = unique_temp_path(parent, label);
            fs::rename(link_path, &backup).map_err(|e| {
                format!(
                    "Failed to displace directory {} for symlink replacement: {e}",
                    link_path.display()
                )
            })?;
            if let Err(e) = symlink(link_value, link_path) {
                let _ = fs::rename(&backup, link_path);
                return Err(format!(
                    "Failed to create symlink {} -> {}: {e}",
                    link_path.display(),
                    link_value.display()
                ));
            }
            let _ = fs::remove_dir_all(&backup);
            return Ok(());
        }
        // Existing file or symlink: atomic rename over it.
        let tmp_link = unique_temp_path(parent, label);
        symlink(link_value, &tmp_link).map_err(|e| {
            format!(
                "Failed to stage symlink {} -> {}: {e}",
                tmp_link.display(),
                link_value.display()
            )
        })?;
        if let Err(e) = fs::rename(&tmp_link, link_path) {
            let _ = fs::remove_file(&tmp_link);
            return Err(format!(
                "Failed to replace {} with symlink: {e}",
                link_path.display()
            ));
        }
        return Ok(());
    }

    symlink(link_value, link_path).map_err(|e| {
        format!(
            "Failed to create symlink {} -> {}: {e}",
            link_path.display(),
            link_value.display()
        )
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct SkillFileEntry {
    pub rel_path: String,
    pub executable: bool,
    pub bytes: Vec<u8>,
}

/// Read all payload files of a physical skill tree without following symlinks.
pub fn read_skill_tree(root: &Path) -> Result<Vec<SkillFileEntry>, String> {
    let meta = fs::symlink_metadata(root)
        .map_err(|e| format!("Failed to inspect {}: {e}", root.display()))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!(
            "Skill root must be a physical directory: {}",
            root.display()
        ));
    }
    let mut entries = Vec::new();
    collect_skill_tree(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(entries)
}

fn collect_skill_tree(
    root: &Path,
    current: &Path,
    out: &mut Vec<SkillFileEntry>,
) -> Result<(), String> {
    let rd = fs::read_dir(current)
        .map_err(|e| format!("Failed to read directory {}: {e}", current.display()))?;
    let mut children = Vec::new();
    for item in rd {
        let entry =
            item.map_err(|e| format!("Failed to read entry in {}: {e}", current.display()))?;
        children.push(entry);
    }
    children.sort_by_key(|e| e.file_name());

    for child in children {
        let file_name = child.file_name();
        let name = file_name.to_string_lossy();
        if is_ignored_junk(&name) {
            continue;
        }
        let child_path = child.path();
        let rel = child_path
            .strip_prefix(root)
            .unwrap_or(&child_path)
            .to_string_lossy()
            .replace('\\', "/");
        if is_git_reserved(&name) {
            return Err(format!(
                "Skill {} contains nested Git metadata '{rel}'; nested repositories are unsupported.",
                root.display()
            ));
        }
        let ft = child
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {e}", child_path.display()))?;
        if ft.is_symlink() {
            return Err(format!(
                "Skill {} contains symlink '{rel}'; symlinks inside skill trees are unsupported.",
                root.display()
            ));
        }
        if ft.is_dir() {
            collect_skill_tree(root, &child_path, out)?;
        } else if ft.is_file() {
            let meta = child
                .metadata()
                .map_err(|e| format!("Failed to stat {}: {e}", child_path.display()))?;
            let executable = (meta.permissions().mode() & 0o111) != 0;
            let bytes = fs::read(&child_path)
                .map_err(|e| format!("Failed to read {}: {e}", child_path.display()))?;
            out.push(SkillFileEntry {
                rel_path: rel,
                executable,
                bytes,
            });
        }
    }
    Ok(())
}

pub fn write_skill_tree_exclusive(dst: &Path, files: &[SkillFileEntry]) -> Result<(), String> {
    if fs::symlink_metadata(dst).is_ok() {
        return Err(format!("Destination already exists: {}", dst.display()));
    }
    let parent = dst
        .parent()
        .ok_or_else(|| format!("Skill destination has no parent: {}", dst.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;

    let stage = unique_temp_path(
        parent,
        dst.file_name().unwrap_or_else(|| OsStr::new("skill")),
    );
    let build = (|| -> Result<(), String> {
        fs::create_dir(&stage)
            .map_err(|e| format!("Failed to create staging dir {}: {e}", stage.display()))?;
        for f in files {
            let target = stage.join(&f.rel_path);
            let mode = if f.executable { 0o755 } else { 0o644 };
            write_atomic(&target, &f.bytes, Some(mode))?;
        }
        fs::rename(&stage, dst).map_err(|e| {
            format!(
                "Failed to publish staged skill {} -> {}: {e}",
                stage.display(),
                dst.display()
            )
        })
    })();

    if build.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    build
}
