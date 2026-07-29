use anyhow::Result;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::core::graph::DependencyGraph;
use crate::core::types::*;

/// Analyze a dependency graph to find dead (unreachable) files and unused exports.
pub fn find_dead_code(
    graph: &DependencyGraph,
    entry_points: &[PathBuf],
) -> Result<DeadCodeResult> {
    // 1. BFS from entry points to find all reachable files
    let mut reachable = HashSet::new();
    let mut queue: VecDeque<PathBuf> = entry_points.iter().cloned().collect();

    while let Some(current) = queue.pop_front() {
        if reachable.contains(&current) {
            continue;
        }
        if graph.get_file_info(&current).is_none() {
            continue;
        }
        reachable.insert(current.clone());

        let deps = graph.dependencies(&current);
        for dep in deps {
            if !reachable.contains(&dep) {
                queue.push_back(dep);
            }
        }
    }

    // 2. Find dead files
    let mut dead_files = Vec::new();
    let mut total_dead_lines = 0;

    for file_path in graph.all_files() {
        if reachable.contains(file_path.as_path()) {
            continue;
        }

        let file_info = match graph.get_file_info(file_path) {
            Some(info) => info,
            None => continue,
        };

        let line_count = count_file_lines(file_path);
        total_dead_lines += line_count;

        let has_exports = !file_info.exports.is_empty();

        let (confidence, reason) = if !has_exports {
            (
                DeadCodeConfidence::Possible,
                "File has no exports and is not imported by any reachable file".to_string(),
            )
        } else {
            (
                DeadCodeConfidence::Definite,
                "File exports are not imported by any reachable file".to_string(),
            )
        };

        dead_files.push(DeadFileInfo {
            path: file_path.clone(),
            confidence,
            reason,
            line_count,
        });
    }

    // 3. Find dead exports in reachable files
    let dead_exports = find_dead_exports(graph, &reachable);

    Ok(DeadCodeResult {
        entry_points: entry_points.to_vec(),
        reachable_files: reachable.len(),
        dead_files,
        dead_exports,
        total_dead_lines,
    })
}

fn find_dead_exports(
    graph: &DependencyGraph,
    reachable: &HashSet<PathBuf>,
) -> Vec<DeadExportInfo> {
    // Build set of all (file, exportName) pairs that are actually imported
    let mut used_exports: HashSet<String> = HashSet::new(); // "filePath::exportName"

    for importer_path in reachable {
        let file_info = match graph.get_file_info(importer_path) {
            Some(info) => info,
            None => continue,
        };

        for import in &file_info.imports {
            let resolved = match &import.resolved_path {
                Some(p) => p,
                None => continue,
            };

            if graph.get_file_info(resolved).is_none() {
                continue;
            }

            for spec in &import.specifiers {
                if spec.is_namespace {
                    // Namespace import uses everything
                    if let Some(target_info) = graph.get_file_info(resolved) {
                        for exp in &target_info.exports {
                            used_exports.insert(format!("{}::{}", resolved.display(), exp.name));
                        }
                    }
                } else if spec.is_default {
                    used_exports.insert(format!("{}::default", resolved.display()));
                } else {
                    used_exports.insert(format!("{}::{}", resolved.display(), spec.name));
                }
            }
        }
    }

    let mut dead_exports = Vec::new();

    for file_path in reachable {
        let file_info = match graph.get_file_info(file_path) {
            Some(info) => info,
            None => continue,
        };

        for exp in &file_info.exports {
            if exp.export_type == ExportType::ReExport {
                continue;
            }
            if exp.name == "*" {
                continue;
            }

            let key = if exp.is_default {
                format!("{}::default", file_path.display())
            } else {
                format!("{}::{}", file_path.display(), exp.name)
            };

            if !used_exports.contains(&key) {
                dead_exports.push(DeadExportInfo {
                    file: file_path.clone(),
                    export_name: exp.name.clone(),
                    line: exp.line,
                    confidence: DeadCodeConfidence::Possible,
                });
            }
        }
    }

    dead_exports
}

fn count_file_lines(file_path: &Path) -> usize {
    match std::fs::read_to_string(file_path) {
        Ok(content) => content.lines().count(),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_dead_code_empty_graph() {
        let graph = DependencyGraph::new();
        let result = find_dead_code(&graph, &[]).unwrap();

        assert!(result.dead_files.is_empty());
        assert!(result.dead_exports.is_empty());
        assert_eq!(result.reachable_files, 0);
        assert_eq!(result.total_dead_lines, 0);
    }

    #[test]
    fn test_find_dead_code_no_entry_points() {
        let graph = DependencyGraph::new();
        let entry_points = Vec::new();
        let result = find_dead_code(&graph, &entry_points).unwrap();

        // With no entry points, nothing is reachable
        assert_eq!(result.reachable_files, 0);
    }
}
