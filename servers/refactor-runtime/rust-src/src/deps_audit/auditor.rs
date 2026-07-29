use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::core::graph::DependencyGraph;
use crate::core::types::*;

/// Known implicit dependencies that should not be flagged as unused.
const IMPLICIT_DEPS: &[&str] = &[
    "typescript", "vite", "webpack", "rollup", "esbuild", "parcel",
    "vitest", "jest", "mocha", "prettier", "ts-node", "tsx", "turbo", "next",
];

const IMPLICIT_PREFIXES: &[&str] = &["@types/", "eslint", "@eslint/", "babel", "@babel/"];

const NODE_BUILTINS: &[&str] = &[
    "assert", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dgram", "dns", "domain", "events", "fs", "http", "http2",
    "https", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
    "sys", "timers", "tls", "tty", "url", "util", "v8", "vm", "wasi",
    "worker_threads", "zlib",
];

/// Extract the package name from an import specifier.
/// Returns None for relative imports, node builtins, and tsconfig path aliases.
fn extract_package_name(import_source: &str, config: &ProjectConfig) -> Option<String> {
    if import_source.starts_with('.') || import_source.starts_with('/') {
        return None;
    }
    if import_source.starts_with("node:") {
        return None;
    }
    let first_segment = import_source.split('/').next().unwrap_or("");
    if NODE_BUILTINS.contains(&first_segment) {
        return None;
    }

    // Check if this matches a tsconfig path alias (e.g., @/lib, @/components)
    for alias_pattern in config.path_aliases.keys() {
        let prefix = alias_pattern.trim_end_matches('*');
        if import_source.starts_with(prefix) {
            return None; // It's a path alias, not an npm package
        }
    }

    if import_source.starts_with('@') {
        let parts: Vec<&str> = import_source.split('/').collect();
        if parts.len() >= 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
        return Some(import_source.to_string());
    }

    Some(first_segment.to_string())
}

fn is_implicit_dep(name: &str) -> bool {
    if IMPLICIT_DEPS.contains(&name) {
        return true;
    }
    IMPLICIT_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

/// Audit package.json dependencies against actual imports in the codebase.
pub fn audit_deps(
    graph: &DependencyGraph,
    config: &ProjectConfig,
    package_json_path: &Path,
) -> Result<DepsAuditResult> {
    let raw = std::fs::read_to_string(package_json_path)
        .with_context(|| format!("Failed to read {}", package_json_path.display()))?;
    let pkg: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| "Failed to parse package.json")?;

    let mut declared_deps: HashMap<String, bool> = HashMap::new(); // name -> is_dev

    if let Some(deps) = pkg.get("dependencies").and_then(|v| v.as_object()) {
        for name in deps.keys() {
            declared_deps.insert(name.clone(), false);
        }
    }
    if let Some(deps) = pkg.get("devDependencies").and_then(|v| v.as_object()) {
        for name in deps.keys() {
            declared_deps.insert(name.clone(), true);
        }
    }

    // Scan all imports in the graph to find used packages
    let mut used_packages: HashMap<String, HashSet<String>> = HashMap::new();

    for file_path in graph.all_files() {
        if let Some(file_info) = graph.get_file_info(file_path) {
            for import in &file_info.imports {
                if let Some(pkg_name) = extract_package_name(&import.source, config) {
                    used_packages
                        .entry(pkg_name)
                        .or_default()
                        .insert(file_info.relative_path.clone());
                }
            }
        }
    }

    // Find unused deps
    let mut unused_deps = Vec::new();
    for (name, is_dev) in &declared_deps {
        if is_implicit_dep(name) {
            continue;
        }
        if !used_packages.contains_key(name) {
            unused_deps.push(UnusedDep {
                name: name.clone(),
                is_dev: *is_dev,
            });
        }
    }

    // Find undeclared deps
    let mut undeclared_deps = Vec::new();
    for (pkg_name, files) in &used_packages {
        if !declared_deps.contains_key(pkg_name) {
            undeclared_deps.push(UndeclaredDep {
                name: pkg_name.clone(),
                used_in: files.iter().map(|f| std::path::PathBuf::from(f)).collect(),
            });
        }
    }

    let total_declared = declared_deps.len();
    let total_used = used_packages.len();

    Ok(DepsAuditResult {
        unused_deps,
        undeclared_deps,
        duplicate_imports: Vec::new(),
        total_declared,
        total_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_package_name() {
        let config = ProjectConfig::default();
        assert_eq!(extract_package_name("lodash", &config), Some("lodash".to_string()));
        assert_eq!(extract_package_name("lodash/fp", &config), Some("lodash".to_string()));
        assert_eq!(
            extract_package_name("@scope/pkg", &config),
            Some("@scope/pkg".to_string())
        );
        assert_eq!(
            extract_package_name("@scope/pkg/sub", &config),
            Some("@scope/pkg".to_string())
        );
        assert_eq!(extract_package_name("./local", &config), None);
        assert_eq!(extract_package_name("../parent", &config), None);
        assert_eq!(extract_package_name("node:fs", &config), None);
        assert_eq!(extract_package_name("fs", &config), None); // builtin
    }

    #[test]
    fn test_extract_package_name_filters_path_aliases() {
        let mut path_aliases = std::collections::HashMap::new();
        path_aliases.insert("@/*".to_string(), vec!["./src/*".to_string()]);
        let config = ProjectConfig {
            path_aliases,
            ..Default::default()
        };
        assert_eq!(extract_package_name("@/lib/auth", &config), None);
        assert_eq!(extract_package_name("@/components/Button", &config), None);
        // Real scoped packages should still work
        assert_eq!(
            extract_package_name("@tanstack/react-query", &config),
            Some("@tanstack/react-query".to_string())
        );
    }

    #[test]
    fn test_is_implicit_dep() {
        assert!(is_implicit_dep("typescript"));
        assert!(is_implicit_dep("@types/node"));
        assert!(is_implicit_dep("eslint-config-custom"));
        assert!(!is_implicit_dep("lodash"));
        assert!(!is_implicit_dep("react"));
    }
}
