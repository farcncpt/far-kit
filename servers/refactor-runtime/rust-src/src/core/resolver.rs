use std::path::{Path, PathBuf};

use crate::config::loader::resolve_alias;
use crate::core::types::ProjectConfig;

const EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mts", "mjs", "cts", "cjs"];
const INDEX_FILES: &[&str] = &[
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
];

/// Resolve an import source string to an absolute file path.
///
/// Handles:
/// - Relative imports (./foo, ../bar)
/// - Path aliases (@/lib/auth)
/// - Barrel files (directory/index.ts)
/// - Extension-less imports
pub fn resolve_import(
    source: &str,
    from_file: &Path,
    config: &ProjectConfig,
) -> Option<PathBuf> {
    // Skip external packages (no ., no alias match)
    if !source.starts_with('.') && !source.starts_with('/') {
        // Check if it matches a path alias
        if let Some(resolved) = resolve_alias(source, config) {
            return resolve_with_extensions(&resolved);
        }
        return None; // External package
    }

    // Relative import
    let from_dir = from_file.parent()?;
    let candidate = from_dir.join(source);
    resolve_with_extensions(&candidate)
}

/// Try to resolve a path by appending extensions or looking for index files.
fn resolve_with_extensions(candidate: &Path) -> Option<PathBuf> {
    // Exact match
    if candidate.is_file() {
        return Some(candidate.to_path_buf());
    }

    // Try with extensions
    for ext in EXTENSIONS {
        let with_ext = candidate.with_extension(ext);
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }

    // Try as directory with index file
    if candidate.is_dir() {
        for index in INDEX_FILES {
            let index_path = candidate.join(index);
            if index_path.is_file() {
                return Some(index_path);
            }
        }
    }

    // Try .ts/.tsx on directory-like paths (e.g. ./components/Button => ./components/Button.tsx)
    let parent = candidate.parent()?;
    let file_stem = candidate.file_name()?.to_str()?;
    for ext in EXTENSIONS {
        let with_ext = parent.join(format!("{}.{}", file_stem, ext));
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }

    None
}

/// Compute the relative import path from one file to another.
/// Returns the path as it should appear in an import statement.
pub fn compute_relative_import(from_file: &Path, to_file: &Path) -> String {
    let from_dir = from_file.parent().unwrap_or(Path::new(""));
    let to_without_ext = strip_ts_extension(to_file);

    let relative = pathdiff::diff_paths(&to_without_ext, from_dir)
        .unwrap_or_else(|| to_without_ext.clone());

    let mut result = relative
        .to_string_lossy()
        .replace('\\', "/");

    // Strip /index suffix (barrel imports)
    if result.ends_with("/index") {
        result = result.trim_end_matches("/index").to_string();
    }

    // Ensure leading ./ for same-directory or child imports
    if !result.starts_with('.') && !result.starts_with('/') {
        result = format!("./{}", result);
    }

    result
}

/// Strip TypeScript/JavaScript extensions from a path.
fn strip_ts_extension(path: &Path) -> PathBuf {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if EXTENSIONS.contains(&ext) {
            return path.with_extension("");
        }
    }
    path.to_path_buf()
}

/// Check if an import source refers to a relative path (not an external package).
pub fn is_relative_import(source: &str) -> bool {
    source.starts_with('.') || source.starts_with('/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_compute_relative_import_same_dir() {
        let result = compute_relative_import(
            Path::new("/project/src/app.ts"),
            Path::new("/project/src/utils.ts"),
        );
        assert_eq!(result, "./utils");
    }

    #[test]
    fn test_compute_relative_import_parent() {
        let result = compute_relative_import(
            Path::new("/project/src/pages/home.ts"),
            Path::new("/project/src/utils.ts"),
        );
        assert_eq!(result, "../utils");
    }

    #[test]
    fn test_compute_relative_import_child() {
        let result = compute_relative_import(
            Path::new("/project/src/app.ts"),
            Path::new("/project/src/lib/auth.ts"),
        );
        assert_eq!(result, "./lib/auth");
    }

    #[test]
    fn test_compute_relative_import_strips_index() {
        let result = compute_relative_import(
            Path::new("/project/src/app.ts"),
            Path::new("/project/src/lib/index.ts"),
        );
        assert_eq!(result, "./lib");
    }

    #[test]
    fn test_resolve_with_extensions() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("utils.ts"), "export {}").unwrap();

        let result = resolve_with_extensions(&dir.path().join("utils"));
        assert!(result.is_some());
        assert!(result.unwrap().to_string_lossy().ends_with("utils.ts"));
    }

    #[test]
    fn test_resolve_index_file() {
        let dir = TempDir::new().unwrap();
        let lib_dir = dir.path().join("lib");
        fs::create_dir_all(&lib_dir).unwrap();
        fs::write(lib_dir.join("index.ts"), "export {}").unwrap();

        let result = resolve_with_extensions(&lib_dir);
        assert!(result.is_some());
        assert!(result.unwrap().to_string_lossy().contains("index.ts"));
    }

    #[test]
    fn test_is_relative_import() {
        assert!(is_relative_import("./utils"));
        assert!(is_relative_import("../lib/auth"));
        assert!(!is_relative_import("react"));
        assert!(!is_relative_import("@/lib/auth"));
    }
}
