use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::core::graph::DependencyGraph;
use crate::core::resolver::{compute_relative_import, is_relative_import};
use crate::core::types::*;
use crate::move_op::route_scanner::{derive_route, is_route_file, scan_for_route_usages};

/// Compute all the import rewrites needed after moving a file.
pub fn compute_move(
    old_path: &Path,
    new_path: &Path,
    graph: &DependencyGraph,
    config: &ProjectConfig,
) -> Result<MoveResult> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut affected_files = Vec::new();

    // 1. Find all files that import the moved file (reverse deps) and update their import paths
    let dependents = graph.dependents(old_path);
    for dep_path in &dependents {
        if let Some(file_info) = graph.get_file_info(dep_path) {
            for import in &file_info.imports {
                // Check if this import resolves to the old path
                let resolves_to_old = import
                    .resolved_path
                    .as_ref()
                    .map(|p| p == old_path)
                    .unwrap_or(false);

                if resolves_to_old {
                    let new_import = compute_new_import_path(
                        dep_path,
                        &import.source,
                        old_path,
                        new_path,
                        config,
                    );

                    affected_files.push(AffectedFile {
                        path: dep_path.clone(),
                        old_import: import.source.clone(),
                        new_import,
                        line: import.line,
                        applied: false,
                    });
                }
            }
        }
    }

    // 2. Update imports within the moved file itself (since its directory changed)
    if let Some(file_info) = graph.get_file_info(old_path) {
        for import in &file_info.imports {
            if !is_relative_import(&import.source) {
                continue; // Skip non-relative imports (packages, aliases)
            }

            if let Some(ref resolved) = import.resolved_path {
                let new_import = compute_relative_import(new_path, resolved);

                if new_import != import.source {
                    affected_files.push(AffectedFile {
                        path: new_path.to_path_buf(),
                        old_import: import.source.clone(),
                        new_import,
                        line: import.line,
                        applied: false,
                    });
                }
            }
        }
    }

    // 3. Route detection: if both old and new are route files, scan for route usages
    let mut route_changes = Vec::new();
    if is_route_file(old_path) && is_route_file(new_path) {
        let old_route = derive_route(old_path, &config.project_root);
        let new_route = derive_route(new_path, &config.project_root);

        if let (Some(old_r), Some(new_r)) = (old_route, new_route) {
            if old_r != new_r {
                let all_files = graph.all_files();
                route_changes = scan_for_route_usages(&all_files, &old_r, &new_r);
            }
        }
    }

    let total = affected_files.len();

    Ok(MoveResult {
        operation: MoveOperation {
            old_path: old_path.to_path_buf(),
            new_path: new_path.to_path_buf(),
            timestamp,
        },
        affected_files,
        total_files_updated: total,
        route_changes,
    })
}

/// Compute what a single import path should become after a file move.
fn compute_new_import_path(
    importing_file: &Path,
    old_import_source: &str,
    _old_target_path: &Path,
    new_target_path: &Path,
    config: &ProjectConfig,
) -> String {
    // If the import uses an alias, try to preserve the alias form
    for (alias_pattern, _targets) in &config.path_aliases {
        let prefix = alias_pattern.trim_end_matches('*');
        if old_import_source.starts_with(prefix) {
            // Compute the new alias-relative path
            if let Ok(relative) = new_target_path.strip_prefix(&config.project_root) {
                let rel_str = relative.to_string_lossy().replace('\\', "/");
                // Strip extension
                let stripped = strip_import_extension(&rel_str);
                // Check if it maps to the alias
                if let Some(base_url) = &config.base_url {
                    let stripped = stripped
                        .strip_prefix(&format!("{}/", base_url))
                        .unwrap_or(&stripped);
                    return format!("{}{}", prefix, stripped);
                }
            }
        }
    }

    // Default: compute relative path
    compute_relative_import(importing_file, new_target_path)
}

fn strip_import_extension(path: &str) -> String {
    for ext in &[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"] {
        if path.ends_with(ext) {
            return path[..path.len() - ext.len()].to_string();
        }
    }
    path.to_string()
}

/// Process a manifest of multiple moves.
/// Fixes cross-references between moved files by building a reverse map (new_path -> old_path)
/// for graph lookups.
pub fn compute_bulk_move(
    manifest: &MoveManifest,
    graph: &DependencyGraph,
    config: &ProjectConfig,
) -> Result<Vec<MoveResult>> {
    // Build a reverse map: new_path -> old_path for all moves in the manifest
    let reverse_map: HashMap<PathBuf, PathBuf> = manifest
        .moves
        .iter()
        .map(|op| (op.new_path.clone(), op.old_path.clone()))
        .collect();

    // Also build forward map for quick lookup
    let forward_map: HashMap<PathBuf, PathBuf> = manifest
        .moves
        .iter()
        .map(|op| (op.old_path.clone(), op.new_path.clone()))
        .collect();

    let mut results = Vec::new();

    for op in &manifest.moves {
        let mut result = compute_move(&op.old_path, &op.new_path, graph, config)
            .with_context(|| {
                format!(
                    "Failed to compute move: {} -> {}",
                    op.old_path.display(),
                    op.new_path.display()
                )
            })?;

        // Fix cross-references: for affected files that are themselves being moved,
        // update the affected file path to point to the new location and recompute
        // the import path from the new location.
        for affected in &mut result.affected_files {
            // If an affected file is also being moved, the rewrite should target
            // the new path of that file
            if let Some(new_affected_path) = forward_map.get(&affected.path) {
                // The dependent file is also moving. Recompute the import from
                // the dependent's new location to our new location.
                let new_import =
                    compute_new_import_path(new_affected_path, &affected.old_import, &op.old_path, &op.new_path, config);
                affected.path = new_affected_path.clone();
                affected.new_import = new_import;
            }

            // If the affected entry's path is a new_path from the manifest,
            // but the graph only has the old_path, use the reverse map for lookups
            if let Some(_old_path) = reverse_map.get(&affected.path) {
                // The path has already been remapped, which is correct
            }
        }

        // Filter no-op rewrites where old_import == new_import
        result.affected_files.retain(|af| af.old_import != af.new_import);
        result.total_files_updated = result.affected_files.len();

        results.push(result);
    }

    Ok(results)
}

/// Expand a folder move into individual file operations.
pub fn expand_folder_move(
    old_dir: &Path,
    new_dir: &Path,
    graph: &DependencyGraph,
) -> Vec<MoveOperation> {
    let timestamp = chrono::Utc::now().to_rfc3339();

    graph
        .all_files()
        .iter()
        .filter_map(|file_path| {
            if file_path.starts_with(old_dir) {
                let relative = file_path.strip_prefix(old_dir).ok()?;
                let new_path = new_dir.join(relative);
                Some(MoveOperation {
                    old_path: file_path.to_path_buf(),
                    new_path,
                    timestamp: timestamp.clone(),
                })
            } else {
                None
            }
        })
        .collect()
}

/// Compute a full folder move with all rewrites.
pub fn compute_folder_move(
    old_dir: &Path,
    new_dir: &Path,
    graph: &DependencyGraph,
    config: &ProjectConfig,
) -> Result<FolderMoveResult> {
    let operations = expand_folder_move(old_dir, new_dir, graph);
    let files_moved = operations.len();

    let manifest = MoveManifest {
        moves: operations.clone(),
        project_root: config.project_root.clone(),
        dry_run: false,
    };

    let results = compute_bulk_move(&manifest, graph, config)?;

    // Collect all route changes from individual results
    let mut route_changes: Vec<RouteChange> = results
        .iter()
        .flat_map(|r| r.route_changes.clone())
        .collect();

    // Deduplicate route changes by (file, line, old_route)
    route_changes.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then(a.line.cmp(&b.line))
            .then(a.old_route.cmp(&b.old_route))
    });
    route_changes.dedup_by(|a, b| a.file == b.file && a.line == b.line && a.old_route == b.old_route);

    let total_files_updated: usize = results.iter().map(|r| r.total_files_updated).sum();

    Ok(FolderMoveResult {
        old_dir: old_dir.to_path_buf(),
        new_dir: new_dir.to_path_buf(),
        files_moved,
        operations,
        results,
        route_changes,
        total_files_updated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_import_extension() {
        assert_eq!(strip_import_extension("foo/bar.ts"), "foo/bar");
        assert_eq!(strip_import_extension("foo/bar.tsx"), "foo/bar");
        assert_eq!(strip_import_extension("foo/bar.js"), "foo/bar");
        assert_eq!(strip_import_extension("foo/bar"), "foo/bar");
    }
}
