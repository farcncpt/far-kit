use anyhow::{Context, Result};
use std::path::Path;

use super::logger::load_audit_log;
use crate::core::types::{AuditEntry, AuditOperation};

/// Rollback operations from an audit log file.
/// Applies changes in reverse order.
pub fn rollback(audit_log_path: &Path, dry_run: bool) -> Result<Vec<RollbackAction>> {
    let entries = load_audit_log(audit_log_path)?;
    let mut actions = Vec::new();

    // Process in reverse order
    for entry in entries.iter().rev() {
        if !entry.rollbackable {
            actions.push(RollbackAction {
                file: entry.file.clone(),
                action: format!("SKIPPED (not rollbackable): {:?}", entry.operation),
                success: false,
            });
            continue;
        }

        match entry.operation {
            AuditOperation::Move => {
                let action = rollback_move(entry, dry_run)?;
                actions.push(action);
            }
            AuditOperation::Rewrite => {
                let action = rollback_rewrite(entry, dry_run)?;
                actions.push(action);
            }
            AuditOperation::AutoFix => {
                let action = rollback_rewrite(entry, dry_run)?;
                actions.push(action);
            }
        }
    }

    Ok(actions)
}

#[derive(Debug)]
pub struct RollbackAction {
    pub file: std::path::PathBuf,
    pub action: String,
    pub success: bool,
}

fn rollback_move(entry: &AuditEntry, dry_run: bool) -> Result<RollbackAction> {
    // old_content = old path, new_content = new path
    // Rollback: move new_content back to old_content
    let new_path = Path::new(&entry.new_content);
    let old_path = Path::new(&entry.old_content);

    if !dry_run {
        if new_path.exists() {
            if let Some(parent) = old_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(new_path, old_path).with_context(|| {
                format!("Failed to rollback move: {} -> {}", new_path.display(), old_path.display())
            })?;
        }
    }

    Ok(RollbackAction {
        file: entry.file.clone(),
        action: format!(
            "Moved {} back to {}",
            entry.new_content, entry.old_content
        ),
        success: true,
    })
}

fn rollback_rewrite(entry: &AuditEntry, dry_run: bool) -> Result<RollbackAction> {
    // Revert the import change: replace new_content with old_content at the given line
    let file_path = &entry.file;

    if !file_path.exists() {
        return Ok(RollbackAction {
            file: file_path.clone(),
            action: format!("File not found: {}", file_path.display()),
            success: false,
        });
    }

    let source = std::fs::read_to_string(file_path)?;
    let lines: Vec<&str> = source.lines().collect();
    let line_idx = entry.line.saturating_sub(1);

    if line_idx >= lines.len() {
        return Ok(RollbackAction {
            file: file_path.clone(),
            action: format!("Line {} out of range", entry.line),
            success: false,
        });
    }

    let line = lines[line_idx];
    if line.contains(&entry.new_content) {
        let new_line = line.replacen(&entry.new_content, &entry.old_content, 1);
        let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        new_lines[line_idx] = new_line;
        let new_source = new_lines.join("\n");

        if !dry_run {
            std::fs::write(file_path, &new_source)?;
        }

        Ok(RollbackAction {
            file: file_path.clone(),
            action: format!(
                "Reverted line {}: {} -> {}",
                entry.line, entry.new_content, entry.old_content
            ),
            success: true,
        })
    } else {
        Ok(RollbackAction {
            file: file_path.clone(),
            action: format!(
                "Line {} doesn't contain expected content: {}",
                entry.line, entry.new_content
            ),
            success: false,
        })
    }
}
