use anyhow::Result;
use std::path::{Path, PathBuf};

use crate::core::types::RouteChange;

/// Next.js route handler filenames.
const ROUTE_FILES: &[&str] = &[
    "route.ts", "route.tsx", "route.js", "route.jsx",
    "page.ts", "page.tsx", "page.js", "page.jsx",
];

/// Check if a file is a Next.js route file.
pub fn is_route_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|f| f.to_str())
        .map(|name| ROUTE_FILES.contains(&name))
        .unwrap_or(false)
}

/// Derive URL route from filesystem path.
///
/// Examples:
///   src/app/api/users/route.ts -> /api/users
///   src/app/editor/[pageId]/page.tsx -> /editor/[pageId]
pub fn derive_route(file_path: &Path, project_root: &Path) -> Option<String> {
    if !is_route_file(file_path) {
        return None;
    }

    let relative = file_path.strip_prefix(project_root).ok()?;
    let parts: Vec<&str> = relative
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    // Find the "app" segment
    let app_index = parts.iter().position(|&p| p == "app")?;

    // Take everything between "app" and the filename (last part)
    let route_parts: Vec<&str> = parts[app_index + 1..parts.len() - 1]
        .iter()
        .copied()
        // Filter out route groups (segments starting with '(')
        .filter(|p| !p.starts_with('('))
        .collect();

    if route_parts.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", route_parts.join("/")))
    }
}

/// Scan files for string literals containing an API route URL.
pub fn scan_for_route_usages(
    files: &[&PathBuf],
    old_route: &str,
    new_route: &str,
) -> Vec<RouteChange> {
    let mut changes = Vec::new();

    for file_path in files {
        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (line_num, line) in content.lines().enumerate() {
            let line_number = line_num + 1;

            // Check all quote types
            for quote in &['"', '\'', '`'] {
                let mut search_start = 0;
                while let Some(start) = line[search_start..].find(*quote) {
                    let abs_start = search_start + start + 1;
                    if abs_start >= line.len() {
                        break;
                    }

                    if let Some(end) = line[abs_start..].find(*quote) {
                        let string_content = &line[abs_start..abs_start + end];

                        // Check if string matches the old route exactly,
                        // or starts with old_route/ or old_route?
                        let is_match = string_content == old_route
                            || string_content.starts_with(&format!("{}/", old_route))
                            || string_content.starts_with(&format!("{}?", old_route));

                        if is_match {
                            let new_content =
                                string_content.replacen(old_route, new_route, 1);
                            let new_line = format!(
                                "{}{}{}{}{}",
                                &line[..abs_start - 1],
                                quote,
                                new_content,
                                quote,
                                &line[abs_start + end + 1..]
                            );

                            changes.push(RouteChange {
                                file: file_path.to_path_buf(),
                                line: line_number,
                                old_route: string_content.to_string(),
                                new_route: new_content,
                                context: new_line,
                                applied: false,
                            });
                        }

                        search_start = abs_start + end + 1;
                    } else {
                        break;
                    }
                }
            }
        }
    }

    changes
}

/// Apply route rewrites to files on disk.
pub fn apply_route_rewrites(changes: &mut [RouteChange], dry_run: bool) -> Result<()> {
    if dry_run || changes.is_empty() {
        return Ok(());
    }

    // Group change indices by file
    let mut by_file: std::collections::HashMap<PathBuf, Vec<usize>> =
        std::collections::HashMap::new();

    for (i, change) in changes.iter().enumerate() {
        by_file
            .entry(change.file.clone())
            .or_default()
            .push(i);
    }

    for (file_path, mut indices) in by_file {
        let content = std::fs::read_to_string(&file_path)?;
        let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

        // Sort by line descending to preserve line numbers
        indices.sort_by(|a, b| changes[*b].line.cmp(&changes[*a].line));

        for idx in &indices {
            let change = &changes[*idx];
            let line_idx = change.line.saturating_sub(1);
            if line_idx < lines.len() {
                let line = &lines[line_idx];
                let new_line = line.replacen(&change.old_route, &change.new_route, 1);
                lines[line_idx] = new_line;
            }
        }

        let mut result = lines.join("\n");
        if content.ends_with('\n') {
            result.push('\n');
        }
        std::fs::write(&file_path, result)?;

        // Mark all changes for this file as applied
        for idx in &indices {
            changes[*idx].applied = true;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_route_file() {
        assert!(is_route_file(Path::new("src/app/api/users/route.ts")));
        assert!(is_route_file(Path::new("src/app/editor/page.tsx")));
        assert!(!is_route_file(Path::new("src/app/lib/utils.ts")));
        assert!(!is_route_file(Path::new("src/app/api/users/handler.ts")));
    }

    #[test]
    fn test_derive_route_api() {
        let root = Path::new("/project");
        let file = Path::new("/project/src/app/api/users/route.ts");
        assert_eq!(derive_route(file, root), Some("/api/users".to_string()));
    }

    #[test]
    fn test_derive_route_page() {
        let root = Path::new("/project");
        let file = Path::new("/project/src/app/editor/[pageId]/page.tsx");
        assert_eq!(
            derive_route(file, root),
            Some("/editor/[pageId]".to_string())
        );
    }

    #[test]
    fn test_derive_route_with_route_group() {
        let root = Path::new("/project");
        let file = Path::new("/project/src/app/(marketing)/about/page.tsx");
        assert_eq!(derive_route(file, root), Some("/about".to_string()));
    }

    #[test]
    fn test_derive_route_root_page() {
        let root = Path::new("/project");
        let file = Path::new("/project/src/app/page.tsx");
        assert_eq!(derive_route(file, root), Some("/".to_string()));
    }

    #[test]
    fn test_derive_route_non_route_file() {
        let root = Path::new("/project");
        let file = Path::new("/project/src/app/lib/utils.ts");
        assert_eq!(derive_route(file, root), None);
    }

    #[test]
    fn test_scan_for_route_usages() {
        use std::io::Write;
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("client.ts");
        let mut f = std::fs::File::create(&file).unwrap();
        writeln!(f, r#"const url = "/api/users";"#).unwrap();
        writeln!(f, r#"fetch("/api/users/123");"#).unwrap();
        writeln!(f, r#"const other = "/api/posts";"#).unwrap();

        let file_pathbuf = file.clone();
        let files = vec![&file_pathbuf];
        let changes = scan_for_route_usages(&files, "/api/users", "/api/v2/users");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].old_route, "/api/users");
        assert_eq!(changes[0].new_route, "/api/v2/users");
        assert_eq!(changes[1].old_route, "/api/users/123");
        assert_eq!(changes[1].new_route, "/api/v2/users/123");
    }
}
