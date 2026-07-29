use anyhow::Result;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::Direction;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::parser::SourceParser;
use super::resolver::resolve_import;
use super::scanner::Scanner;
use super::types::*;

/// Strip the `\\?\` extended-length path prefix that `std::fs::canonicalize()`
/// adds on Windows. Without this, canonicalized paths won't match scanner paths.
fn normalize_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

pub struct DependencyGraph {
    graph: DiGraph<PathBuf, ()>,
    node_map: HashMap<PathBuf, NodeIndex>,
    file_info: HashMap<PathBuf, FileInfo>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self {
            graph: DiGraph::new(),
            node_map: HashMap::new(),
            file_info: HashMap::new(),
        }
    }

    /// Build the dependency graph from a project root.
    pub fn build(project_root: &Path, config: &ProjectConfig) -> Result<Self> {
        let scanner = Scanner::new(project_root);
        let files = scanner.scan_with_language()?;

        // Parse all files in parallel
        let parsed_files: Vec<(PathBuf, Language, Vec<ImportInfo>, Vec<ExportInfo>)> = {
            let results = Mutex::new(Vec::new());

            files.par_iter().for_each(|(path, lang)| {
                let mut parser = match SourceParser::new() {
                    Ok(p) => p,
                    Err(_) => return,
                };
                if let Ok((imports, exports)) = parser.parse_file(path, *lang) {
                    results
                        .lock()
                        .unwrap()
                        .push((path.clone(), *lang, imports, exports));
                }
            });

            results.into_inner().unwrap()
        };

        let mut dep_graph = Self::new();

        // First pass: add all nodes and store file info
        for (path, lang, imports, exports) in &parsed_files {
            let relative_path = path
                .strip_prefix(project_root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            let node_idx = dep_graph.graph.add_node(path.clone());
            dep_graph.node_map.insert(path.clone(), node_idx);

            dep_graph.file_info.insert(
                path.clone(),
                FileInfo {
                    path: path.clone(),
                    relative_path,
                    imports: imports.clone(),
                    exports: exports.clone(),
                    language: *lang,
                    symbol_usages: None,
                    jsx_elements: None,
                    env_references: None,
                    call_sites: None,
                },
            );
        }

        // Second pass: resolve imports and add edges
        let edges_to_add: Vec<(PathBuf, PathBuf)> = parsed_files
            .par_iter()
            .flat_map(|(path, _, imports, _)| {
                let mut edges = Vec::new();
                for import in imports {
                    if let Some(resolved) = resolve_import(&import.source, path, config) {
                        let canonical = std::fs::canonicalize(&resolved)
                            .map(normalize_path)
                            .unwrap_or(resolved);
                        edges.push((path.clone(), canonical));
                    }
                }
                edges
            })
            .collect();

        for (from, to) in edges_to_add {
            if let (Some(&from_idx), Some(&to_idx)) =
                (dep_graph.node_map.get(&from), dep_graph.node_map.get(&to))
            {
                dep_graph.graph.add_edge(from_idx, to_idx, ());
            }
        }

        // Update resolved paths in imports
        for (path, _, _imports, _) in parsed_files {
            if let Some(file_info) = dep_graph.file_info.get_mut(&path) {
                for import in &mut file_info.imports {
                    import.resolved_path =
                        resolve_import(&import.source, &path, config)
                            .and_then(|p| std::fs::canonicalize(&p).ok().map(normalize_path).or(Some(p)));
                }
            }
        }

        Ok(dep_graph)
    }

    /// Get all files that import the given file (reverse dependencies).
    pub fn dependents(&self, file: &Path) -> Vec<PathBuf> {
        let node_idx = match self.node_map.get(file) {
            Some(idx) => *idx,
            None => return Vec::new(),
        };

        self.graph
            .neighbors_directed(node_idx, Direction::Incoming)
            .map(|idx| self.graph[idx].clone())
            .collect()
    }

    /// Get all files that the given file imports (forward dependencies).
    pub fn dependencies(&self, file: &Path) -> Vec<PathBuf> {
        let node_idx = match self.node_map.get(file) {
            Some(idx) => *idx,
            None => return Vec::new(),
        };

        self.graph
            .neighbors_directed(node_idx, Direction::Outgoing)
            .map(|idx| self.graph[idx].clone())
            .collect()
    }

    /// Get file info for a given path.
    pub fn get_file_info(&self, file: &Path) -> Option<&FileInfo> {
        self.file_info.get(file)
    }

    /// Get all files in the graph.
    pub fn all_files(&self) -> Vec<&PathBuf> {
        self.file_info.keys().collect()
    }

    /// Get total number of files.
    pub fn file_count(&self) -> usize {
        self.file_info.len()
    }

    /// Get total number of edges (import relationships).
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// Detect circular dependencies.
    pub fn find_circular_deps(&self) -> Vec<Vec<PathBuf>> {
        let mut cycles = Vec::new();
        let sccs = petgraph::algo::kosaraju_scc(&self.graph);

        for scc in sccs {
            if scc.len() > 1 {
                let cycle: Vec<PathBuf> = scc
                    .iter()
                    .map(|idx| self.graph[*idx].clone())
                    .collect();
                cycles.push(cycle);
            } else if scc.len() == 1 {
                // Check for self-loop
                let idx = scc[0];
                if self.graph.contains_edge(idx, idx) {
                    cycles.push(vec![self.graph[idx].clone()]);
                }
            }
        }

        cycles
    }

    /// Find orphaned files (no imports and not imported by anyone).
    pub fn find_orphans(&self) -> Vec<PathBuf> {
        self.node_map
            .iter()
            .filter(|(_, &idx)| {
                let incoming = self
                    .graph
                    .neighbors_directed(idx, Direction::Incoming)
                    .count();
                let outgoing = self
                    .graph
                    .neighbors_directed(idx, Direction::Outgoing)
                    .count();
                incoming == 0 && outgoing == 0
            })
            .map(|(path, _)| path.clone())
            .collect()
    }

    /// Traverse the graph to a maximum depth from a starting file.
    pub fn traverse(&self, start: &Path, max_depth: usize, direction: Direction) -> Vec<(PathBuf, usize)> {
        let start_idx = match self.node_map.get(start) {
            Some(idx) => *idx,
            None => return Vec::new(),
        };

        let mut visited = HashSet::new();
        let mut result = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back((start_idx, 0usize));

        while let Some((idx, depth)) = queue.pop_front() {
            if depth > max_depth || !visited.insert(idx) {
                continue;
            }

            if idx != start_idx {
                result.push((self.graph[idx].clone(), depth));
            }

            for neighbor in self.graph.neighbors_directed(idx, direction) {
                if !visited.contains(&neighbor) {
                    queue.push_back((neighbor, depth + 1));
                }
            }
        }

        result
    }

    /// Get file counts grouped by language.
    pub fn files_by_language(&self) -> HashMap<String, usize> {
        let mut counts = HashMap::new();
        for file_info in self.file_info.values() {
            let lang = format!("{:?}", file_info.language).to_lowercase();
            *counts.entry(lang).or_insert(0) += 1;
        }
        counts
    }

    /// Get total imports and exports count.
    pub fn import_export_counts(&self) -> (usize, usize) {
        let imports: usize = self.file_info.values().map(|f| f.imports.len()).sum();
        let exports: usize = self.file_info.values().map(|f| f.exports.len()).sum();
        (imports, exports)
    }

    /// Get the underlying file_info map (for move operations that need to iterate).
    pub fn file_info_map(&self) -> &HashMap<PathBuf, FileInfo> {
        &self.file_info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_graph() {
        let graph = DependencyGraph::new();
        assert_eq!(graph.file_count(), 0);
        assert_eq!(graph.edge_count(), 0);
    }
}
