use anyhow::Result;
use std::path::Path;

use crate::core::parser::SourceParser;
use crate::core::types::*;

/// Detect changes between two versions of a file by comparing exports.
pub fn detect_changes(
    old_source: &str,
    new_source: &str,
    file_path: &Path,
    language: Language,
) -> Result<Vec<ChangeInfo>> {
    let mut parser = SourceParser::new()?;
    let (_, old_exports) = parser.parse_source(old_source, language)?;
    let (_, new_exports) = parser.parse_source(new_source, language)?;

    let mut changes = Vec::new();

    // Check for removed/modified exports
    for old_export in &old_exports {
        let matching_new = new_exports.iter().find(|e| e.name == old_export.name);

        match matching_new {
            None => {
                // Export was removed
                changes.push(ChangeInfo {
                    file: file_path.to_path_buf(),
                    entity: old_export.name.clone(),
                    change_type: ChangeType::Removed,
                    old_signature: Some(format_export_signature(old_export)),
                    new_signature: None,
                });
            }
            Some(new_export) => {
                // Check for type changes
                if old_export.export_type != new_export.export_type {
                    changes.push(ChangeInfo {
                        file: file_path.to_path_buf(),
                        entity: old_export.name.clone(),
                        change_type: ChangeType::Renamed, // Type of export changed
                        old_signature: Some(format_export_signature(old_export)),
                        new_signature: Some(format_export_signature(new_export)),
                    });
                }

                // Check function signature changes
                if let (Some(old_sig), Some(new_sig)) =
                    (&old_export.signature, &new_export.signature)
                {
                    let sig_changes = compare_signatures(old_sig, new_sig, file_path);
                    changes.extend(sig_changes);
                }
            }
        }
    }

    // Check for new exports (not a breaking change, but useful info)
    for new_export in &new_exports {
        if !old_exports.iter().any(|e| e.name == new_export.name) {
            // New export — only note if it's an interface field addition
            if new_export.export_type == ExportType::Interface {
                changes.push(ChangeInfo {
                    file: file_path.to_path_buf(),
                    entity: new_export.name.clone(),
                    change_type: ChangeType::InterfaceFieldAdded,
                    old_signature: None,
                    new_signature: Some(format_export_signature(new_export)),
                });
            }
        }
    }

    Ok(changes)
}

fn compare_signatures(
    old_sig: &FunctionSignature,
    new_sig: &FunctionSignature,
    file_path: &Path,
) -> Vec<ChangeInfo> {
    let mut changes = Vec::new();

    // Name change
    if old_sig.name != new_sig.name {
        changes.push(ChangeInfo {
            file: file_path.to_path_buf(),
            entity: old_sig.name.clone(),
            change_type: ChangeType::Renamed,
            old_signature: Some(old_sig.name.clone()),
            new_signature: Some(new_sig.name.clone()),
        });
    }

    // Return type changes
    if old_sig.return_type != new_sig.return_type {
        let change_type = classify_return_type_change(&old_sig.return_type, &new_sig.return_type);
        changes.push(ChangeInfo {
            file: file_path.to_path_buf(),
            entity: old_sig.name.clone(),
            change_type,
            old_signature: Some(old_sig.return_type.clone()),
            new_signature: Some(new_sig.return_type.clone()),
        });
    }

    // Parameter changes
    let old_params: Vec<&ParamInfo> = old_sig.params.iter().collect();
    let new_params: Vec<&ParamInfo> = new_sig.params.iter().collect();

    // Check for removed params
    for old_param in &old_params {
        if !new_params.iter().any(|p| p.name == old_param.name) {
            changes.push(ChangeInfo {
                file: file_path.to_path_buf(),
                entity: old_sig.name.clone(),
                change_type: ChangeType::ParamRemoved,
                old_signature: Some(format!("{}: {}", old_param.name, old_param.param_type)),
                new_signature: None,
            });
        }
    }

    // Check for added params
    for new_param in &new_params {
        if !old_params.iter().any(|p| p.name == new_param.name) {
            let change_type = if new_param.optional || new_param.default_value.is_some() {
                ChangeType::ParamAddedOptional
            } else {
                ChangeType::ParamAddedRequired
            };
            changes.push(ChangeInfo {
                file: file_path.to_path_buf(),
                entity: old_sig.name.clone(),
                change_type,
                old_signature: None,
                new_signature: Some(format!("{}: {}", new_param.name, new_param.param_type)),
            });
        }
    }

    // Check for type-changed params
    for old_param in &old_params {
        if let Some(new_param) = new_params.iter().find(|p| p.name == old_param.name) {
            if old_param.param_type != new_param.param_type {
                changes.push(ChangeInfo {
                    file: file_path.to_path_buf(),
                    entity: old_sig.name.clone(),
                    change_type: ChangeType::ParamTypeChanged,
                    old_signature: Some(format!("{}: {}", old_param.name, old_param.param_type)),
                    new_signature: Some(format!("{}: {}", new_param.name, new_param.param_type)),
                });
            }
        }
    }

    changes
}

fn classify_return_type_change(old_type: &str, new_type: &str) -> ChangeType {
    // Simple heuristic: if new type contains old type + " | null" or " | undefined", it's widened
    if new_type.contains(old_type) && (new_type.contains("null") || new_type.contains("undefined"))
    {
        ChangeType::ReturnTypeWidened
    } else if old_type.contains(new_type)
        && (old_type.contains("null") || old_type.contains("undefined"))
    {
        ChangeType::ReturnTypeNarrowed
    } else {
        ChangeType::ReturnTypeChanged
    }
}

fn format_export_signature(export: &ExportInfo) -> String {
    format!(
        "{} {:?} {}",
        if export.is_default { "default" } else { "" },
        export.export_type,
        export.name
    )
    .trim()
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_removed_export() {
        let old = r#"export function greet() { return "hi"; }
export const VERSION = "1.0";"#;
        let new = r#"export const VERSION = "1.0";"#;

        let changes = detect_changes(
            old,
            new,
            Path::new("/test.ts"),
            Language::TypeScript,
        )
        .unwrap();

        assert!(!changes.is_empty());
        assert!(changes.iter().any(|c| c.entity == "greet" && c.change_type == ChangeType::Removed));
    }
}
