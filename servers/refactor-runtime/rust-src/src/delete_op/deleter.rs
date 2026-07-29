use anyhow::Result;
use std::path::Path;

use crate::core::graph::DependencyGraph;
use crate::core::types::*;

/// Compute the impact of deleting a file from the project.
/// Returns which files are affected and what imports need to be removed.
pub fn compute_delete(target_file: &Path, graph: &DependencyGraph) -> Result<DeleteResult> {
    let mut affected_files = Vec::new();
    let mut re_export_breaks = Vec::new();
    let mut total_imports_removed = 0;

    let dependents = graph.dependents(target_file);

    for dep_path in dependents {
        let file_info = match graph.get_file_info(&dep_path) {
            Some(info) => info,
            None => continue,
        };

        let mut imports_to_remove = Vec::new();

        for import in &file_info.imports {
            let resolved = match &import.resolved_path {
                Some(p) => p,
                None => continue,
            };

            if resolved != target_file {
                continue;
            }

            // Check if this is a re-export
            let is_reexport = file_info.exports.iter().any(|e| {
                e.re_export_source.as_deref() == Some(&import.source)
            });

            if is_reexport {
                for spec in &import.specifiers {
                    re_export_breaks.push(ReExportBreak {
                        file: dep_path.clone(),
                        symbol: spec.name.clone(),
                        line: import.line,
                    });
                }
            }

            for spec in &import.specifiers {
                imports_to_remove.push(ImportRemoval {
                    line: import.line,
                    specifier: spec.alias.clone().unwrap_or_else(|| spec.name.clone()),
                    full_line_removal: true,
                });
                total_imports_removed += 1;
            }

            // Side-effect import with no specifiers
            if import.specifiers.is_empty() {
                imports_to_remove.push(ImportRemoval {
                    line: import.line,
                    specifier: import.source.clone(),
                    full_line_removal: true,
                });
                total_imports_removed += 1;
            }
        }

        if !imports_to_remove.is_empty() {
            affected_files.push(DeleteAffectedFile {
                path: dep_path,
                imports_to_remove,
                applied: false,
            });
        }
    }

    Ok(DeleteResult {
        target_file: target_file.to_path_buf(),
        affected_files,
        re_export_breaks,
        total_imports_removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_delete_empty_graph() {
        // An empty graph should produce an empty result
        let graph = DependencyGraph::new();
        let target = std::path::PathBuf::from("/some/file.ts");
        let result = compute_delete(&target, &graph).unwrap();

        assert!(result.affected_files.is_empty());
        assert_eq!(result.total_imports_removed, 0);
        assert!(result.re_export_breaks.is_empty());
        assert_eq!(result.target_file, target);
    }

    #[test]
    fn test_compute_delete_no_dependents() {
        // A file with no dependents should return empty result
        let graph = DependencyGraph::new();
        let target = std::path::PathBuf::from("/project/src/leaf.ts");
        let result = compute_delete(&target, &graph).unwrap();

        assert!(result.affected_files.is_empty());
        assert_eq!(result.total_imports_removed, 0);
    }
}
