use anyhow::Result;
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::types::Language;

const DEFAULT_EXCLUDE: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".turbo",
    ".cache",
    "target",
    "__pycache__",
];

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs",
];

pub struct Scanner {
    root: PathBuf,
    exclude_patterns: Vec<String>,
}

impl Scanner {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
            exclude_patterns: DEFAULT_EXCLUDE.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn with_excludes(mut self, excludes: Vec<String>) -> Self {
        self.exclude_patterns.extend(excludes);
        self
    }

    pub fn scan(&self) -> Result<Vec<PathBuf>> {
        let files: Vec<PathBuf> = WalkDir::new(&self.root)
            .into_iter()
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                !self.exclude_patterns.iter().any(|p| name.as_ref() == p.as_str())
            })
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext))
                    .unwrap_or(false)
            })
            .map(|entry| entry.into_path())
            .collect();

        Ok(files)
    }

    pub fn scan_with_language(&self) -> Result<Vec<(PathBuf, Language)>> {
        let files = self.scan()?;
        let result: Vec<(PathBuf, Language)> = files
            .into_par_iter()
            .filter_map(|path| {
                let ext = path.extension()?.to_str()?;
                let lang = Language::from_extension(ext)?;
                Some((path, lang))
            })
            .collect();

        Ok(result)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_scan_finds_ts_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("index.ts"), "export {}").unwrap();
        fs::write(dir.path().join("app.tsx"), "export {}").unwrap();
        fs::write(dir.path().join("readme.md"), "# Hello").unwrap();

        let scanner = Scanner::new(dir.path());
        let files = scanner.scan().unwrap();

        assert_eq!(files.len(), 2);
    }

    #[test]
    fn test_scan_excludes_node_modules() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/foo")).unwrap();
        fs::write(dir.path().join("node_modules/foo/index.js"), "").unwrap();
        fs::write(dir.path().join("index.ts"), "export {}").unwrap();

        let scanner = Scanner::new(dir.path());
        let files = scanner.scan().unwrap();

        assert_eq!(files.len(), 1);
    }
}
