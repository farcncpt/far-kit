use anyhow::{Context, Result};

use crate::audit::logger::AuditLogger;
use crate::core::types::*;

/// Apply automatic fixes for mechanical changes.
/// Returns the number of fixes applied.
pub fn apply_auto_fixes(
    effects: &[CascadeEffect],
    dry_run: bool,
    mut audit_logger: Option<&mut AuditLogger>,
) -> Result<Vec<AutoFixResult>> {
    let mut results = Vec::new();

    for effect in effects {
        if !effect.auto_fixable {
            continue;
        }

        match effect.classification {
            Classification::MechanicalAuto => {
                let result = apply_fix(effect, dry_run, audit_logger.as_deref_mut())?;
                results.push(result);
            }
            _ => continue,
        }
    }

    Ok(results)
}

#[derive(Debug)]
pub struct AutoFixResult {
    pub file: std::path::PathBuf,
    pub line: usize,
    pub description: String,
    pub applied: bool,
}

fn apply_fix(
    effect: &CascadeEffect,
    dry_run: bool,
    mut audit_logger: Option<&mut AuditLogger>,
) -> Result<AutoFixResult> {
    let suggested = effect.suggested_fix.as_deref().unwrap_or("");

    // For rename-type fixes, we can do find-and-replace in the file
    if suggested.starts_with("Update reference from") || suggested.starts_with("No changes needed") {
        // No-op fixes (like optional param additions, narrowed return types)
        if suggested.starts_with("No changes needed") {
            return Ok(AutoFixResult {
                file: effect.file.clone(),
                line: effect.line,
                description: "No changes needed (safe change)".to_string(),
                applied: true,
            });
        }

        // Rename fixes: extract old and new names
        if let Some((old_name, new_name)) = parse_rename_fix(suggested) {
            if !dry_run && effect.file.exists() {
                let source = std::fs::read_to_string(&effect.file)
                    .with_context(|| format!("Failed to read: {}", effect.file.display()))?;

                let new_source = source.replace(&old_name, &new_name);

                if source != new_source {
                    if let Some(ref mut logger) = audit_logger {
                        logger.log(AuditEntry {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            operation: AuditOperation::AutoFix,
                            file: effect.file.clone(),
                            old_content: old_name.clone(),
                            new_content: new_name.clone(),
                            line: effect.line,
                            rollbackable: true,
                        })?;
                    }

                    std::fs::write(&effect.file, &new_source)
                        .with_context(|| {
                            format!("Failed to write: {}", effect.file.display())
                        })?;
                }
            }

            return Ok(AutoFixResult {
                file: effect.file.clone(),
                line: effect.line,
                description: format!("Renamed '{}' to '{}'", old_name, new_name),
                applied: !dry_run,
            });
        }
    }

    Ok(AutoFixResult {
        file: effect.file.clone(),
        line: effect.line,
        description: format!(
            "Auto-fix not implemented for: {}",
            effect.description
        ),
        applied: false,
    })
}

fn parse_rename_fix(suggestion: &str) -> Option<(String, String)> {
    // "Update reference from 'oldName' to 'newName'"
    let parts: Vec<&str> = suggestion.split('\'').collect();
    if parts.len() >= 4 {
        Some((parts[1].to_string(), parts[3].to_string()))
    } else {
        None
    }
}

/// Check if an effect can be auto-fixed.
pub fn is_auto_fixable(change_type: ChangeType) -> bool {
    matches!(
        change_type,
        ChangeType::Renamed
            | ChangeType::ParamAddedOptional
            | ChangeType::ReturnTypeNarrowed
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rename_fix() {
        let result = parse_rename_fix("Update reference from 'foo' to 'bar'");
        assert_eq!(result, Some(("foo".to_string(), "bar".to_string())));
    }

    #[test]
    fn test_is_auto_fixable() {
        assert!(is_auto_fixable(ChangeType::Renamed));
        assert!(is_auto_fixable(ChangeType::ParamAddedOptional));
        assert!(is_auto_fixable(ChangeType::ReturnTypeNarrowed));
        assert!(!is_auto_fixable(ChangeType::Removed));
        assert!(!is_auto_fixable(ChangeType::ParamAddedRequired));
    }
}
