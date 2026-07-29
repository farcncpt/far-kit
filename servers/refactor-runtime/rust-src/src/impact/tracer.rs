use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::core::graph::DependencyGraph;
use crate::core::types::*;

/// Trace the cascade of a change through the dependency graph.
/// Returns all files and locations affected, ordered by depth.
pub fn trace_cascade(
    change: &ChangeInfo,
    graph: &DependencyGraph,
    max_depth: usize,
) -> Vec<CascadeEffect> {
    let mut effects = Vec::new();
    let mut visited = HashSet::new();

    trace_recursive(
        &change.file,
        change,
        graph,
        1,
        max_depth,
        &mut visited,
        &mut effects,
    );

    // Sort by depth, then by file
    effects.sort_by(|a, b| a.depth.cmp(&b.depth).then(a.file.cmp(&b.file)));

    effects
}

fn trace_recursive(
    current_file: &Path,
    change: &ChangeInfo,
    graph: &DependencyGraph,
    depth: usize,
    max_depth: usize,
    visited: &mut HashSet<PathBuf>,
    effects: &mut Vec<CascadeEffect>,
) {
    if depth > max_depth || !visited.insert(current_file.to_path_buf()) {
        return;
    }

    // Get all files that import the current file
    let dependents = graph.dependents(current_file);

    for dependent_path in &dependents {
        if let Some(file_info) = graph.get_file_info(dependent_path) {
            // Check if this file imports the changed entity
            for import in &file_info.imports {
                let imports_changed_file = import
                    .resolved_path
                    .as_ref()
                    .map(|p| p == current_file)
                    .unwrap_or(false);

                if !imports_changed_file {
                    continue;
                }

                // Check if the import includes the changed entity
                let imports_entity = import.specifiers.is_empty() // side-effect import or wildcard
                    || import.specifiers.iter().any(|s| {
                        s.name == change.entity
                            || s.is_namespace
                            || (s.is_default && change.entity == "default")
                    });

                if imports_entity {
                    let (classification, description, suggested_fix, auto_fixable) =
                        classify_effect(change, depth);

                    // Get the calling code snippet (the import line itself for now)
                    let calling_code = format!(
                        "import {{ {} }} from {:?}",
                        change.entity,
                        import.source
                    );

                    effects.push(CascadeEffect {
                        file: dependent_path.clone(),
                        line: import.line,
                        depth,
                        classification,
                        description,
                        calling_code,
                        suggested_fix: Some(suggested_fix),
                        auto_fixable,
                    });

                    // Trace further (this file's exports might be affected too)
                    trace_recursive(
                        dependent_path,
                        change,
                        graph,
                        depth + 1,
                        max_depth,
                        visited,
                        effects,
                    );
                }
            }
        }
    }
}

fn classify_effect(change: &ChangeInfo, depth: usize) -> (Classification, String, String, bool) {
    match change.change_type {
        ChangeType::Renamed => (
            Classification::MechanicalAuto,
            format!("'{}' was renamed", change.entity),
            format!(
                "Update reference from '{}' to '{}'",
                change.old_signature.as_deref().unwrap_or(&change.entity),
                change.new_signature.as_deref().unwrap_or("?")
            ),
            true,
        ),
        ChangeType::Removed => (
            if depth <= 1 {
                Classification::LogicSimple
            } else {
                Classification::LogicComplex
            },
            format!("'{}' was removed", change.entity),
            "Find alternative or remove usage".to_string(),
            false,
        ),
        ChangeType::ParamAddedRequired => (
            Classification::MechanicalConfirm,
            format!(
                "'{}' has a new required parameter: {}",
                change.entity,
                change.new_signature.as_deref().unwrap_or("?")
            ),
            "Add the required parameter at all call sites".to_string(),
            false,
        ),
        ChangeType::ParamAddedOptional => (
            Classification::MechanicalAuto,
            format!("'{}' has a new optional parameter", change.entity),
            "No changes needed — parameter is optional".to_string(),
            true,
        ),
        ChangeType::ParamRemoved => (
            Classification::MechanicalConfirm,
            format!("'{}' had a parameter removed", change.entity),
            "Remove the parameter from all call sites".to_string(),
            false,
        ),
        ChangeType::ParamTypeChanged => (
            Classification::LogicSimple,
            format!(
                "'{}' parameter type changed: {} -> {}",
                change.entity,
                change.old_signature.as_deref().unwrap_or("?"),
                change.new_signature.as_deref().unwrap_or("?")
            ),
            "Update parameter types at call sites".to_string(),
            false,
        ),
        ChangeType::ReturnTypeWidened => (
            if depth <= 1 {
                Classification::MechanicalConfirm
            } else {
                Classification::LogicSimple
            },
            format!(
                "'{}' return type widened: {} -> {}",
                change.entity,
                change.old_signature.as_deref().unwrap_or("?"),
                change.new_signature.as_deref().unwrap_or("?")
            ),
            "Add null/undefined checks where return value is used".to_string(),
            false,
        ),
        ChangeType::ReturnTypeNarrowed => (
            Classification::MechanicalAuto,
            format!("'{}' return type narrowed (safe)", change.entity),
            "No changes needed — type is more specific".to_string(),
            true,
        ),
        ChangeType::ReturnTypeChanged => (
            Classification::LogicComplex,
            format!(
                "'{}' return type changed: {} -> {}",
                change.entity,
                change.old_signature.as_deref().unwrap_or("?"),
                change.new_signature.as_deref().unwrap_or("?")
            ),
            "Review all usages of the return value".to_string(),
            false,
        ),
        ChangeType::InterfaceFieldAdded | ChangeType::InterfaceFieldRemoved | ChangeType::InterfaceFieldChanged => {
            let severity = if depth <= 1 {
                Classification::MechanicalConfirm
            } else {
                Classification::LogicSimple
            };
            (
                severity,
                format!("Interface '{}' changed", change.entity),
                "Update all implementations and usages".to_string(),
                false,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_rename() {
        let (class, _, _, auto) = classify_effect(
            &ChangeInfo {
                file: PathBuf::from("/test.ts"),
                entity: "foo".to_string(),
                change_type: ChangeType::Renamed,
                old_signature: Some("foo".to_string()),
                new_signature: Some("bar".to_string()),
            },
            1,
        );
        assert_eq!(class, Classification::MechanicalAuto);
        assert!(auto);
    }

    #[test]
    fn test_classify_removed() {
        let (class, _, _, auto) = classify_effect(
            &ChangeInfo {
                file: PathBuf::from("/test.ts"),
                entity: "foo".to_string(),
                change_type: ChangeType::Removed,
                old_signature: None,
                new_signature: None,
            },
            1,
        );
        assert_eq!(class, Classification::LogicSimple);
        assert!(!auto);
    }
}
