use anyhow::Result;
use std::path::Path;

use crate::core::graph::DependencyGraph;
use crate::core::types::*;

/// Compute the impact of renaming an exported symbol in a source file.
/// Scans all dependents for usages of the old name and produces rewrite plans.
pub fn compute_rename(
    source_file: &Path,
    old_name: &str,
    new_name: &str,
    graph: &DependencyGraph,
) -> Result<RenameResult> {
    let mut affected_files = Vec::new();
    let dynamic_access_warnings = Vec::new();
    let mut total_rewrites = 0;

    // 1. Rewrite the source file itself (export declaration)
    if let Some(file_info) = graph.get_file_info(source_file) {
        let mut source_rewrites = Vec::new();
        for export in &file_info.exports {
            if export.name == old_name {
                source_rewrites.push(RenameRewrite {
                    line: export.line,
                    old_text: old_name.to_string(),
                    new_text: new_name.to_string(),
                });
            }
        }
        if !source_rewrites.is_empty() {
            total_rewrites += source_rewrites.len();
            affected_files.push(RenameAffectedFile {
                path: source_file.to_path_buf(),
                rewrites: source_rewrites,
                applied: false,
            });
        }
    }

    // 2. Find all files that import from the source file
    let dependents = graph.dependents(source_file);

    for dep_path in dependents {
        let file_info = match graph.get_file_info(&dep_path) {
            Some(info) => info,
            None => continue,
        };

        let mut rewrites = Vec::new();

        for import in &file_info.imports {
            let resolved = match &import.resolved_path {
                Some(p) => p,
                None => continue,
            };

            if resolved != source_file {
                continue;
            }

            for spec in &import.specifiers {
                // Named import that matches the old name
                if spec.name == old_name && !spec.is_namespace && !spec.is_default {
                    if let Some(ref alias) = spec.alias {
                        // import { oldName as alias } — rename specifier only
                        rewrites.push(RenameRewrite {
                            line: import.line,
                            old_text: format!("{} as {}", old_name, alias),
                            new_text: format!("{} as {}", new_name, alias),
                        });
                    } else {
                        // import { oldName } — rename to { newName }
                        rewrites.push(RenameRewrite {
                            line: import.line,
                            old_text: old_name.to_string(),
                            new_text: new_name.to_string(),
                        });
                    }
                }
            }
        }

        // Check for re-exports
        for export in &file_info.exports {
            if export.export_type == ExportType::ReExport && export.name == old_name {
                rewrites.push(RenameRewrite {
                    line: export.line,
                    old_text: old_name.to_string(),
                    new_text: new_name.to_string(),
                });
            }
        }

        // Scan for dynamic access patterns (string literal references)
        // This is a simplified check — full implementation would read the file
        if let Some(file_info) = graph.get_file_info(&dep_path) {
            for import in &file_info.imports {
                if let Some(ref resolved) = import.resolved_path {
                    if resolved == source_file {
                        // Mark for potential dynamic access warning
                        // A real implementation would scan file contents
                        let _ = &dynamic_access_warnings; // suppress unused warning
                    }
                }
            }
        }

        if !rewrites.is_empty() {
            total_rewrites += rewrites.len();
            affected_files.push(RenameAffectedFile {
                path: dep_path,
                rewrites,
                applied: false,
            });
        }
    }

    Ok(RenameResult {
        old_name: old_name.to_string(),
        new_name: new_name.to_string(),
        source_file: source_file.to_path_buf(),
        affected_files,
        dynamic_access_warnings,
        total_rewrites,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_rename_empty_graph() {
        let graph = DependencyGraph::new();
        let source = std::path::PathBuf::from("/project/src/utils.ts");
        let result = compute_rename(&source, "oldFunc", "newFunc", &graph).unwrap();

        assert_eq!(result.old_name, "oldFunc");
        assert_eq!(result.new_name, "newFunc");
        assert_eq!(result.source_file, source);
        assert!(result.affected_files.is_empty());
        assert_eq!(result.total_rewrites, 0);
    }

    #[test]
    fn test_compute_rename_no_dependents() {
        let graph = DependencyGraph::new();
        let source = std::path::PathBuf::from("/project/src/leaf.ts");
        let result = compute_rename(&source, "myFunc", "renamedFunc", &graph).unwrap();

        assert!(result.affected_files.is_empty());
        assert_eq!(result.total_rewrites, 0);
    }
}
