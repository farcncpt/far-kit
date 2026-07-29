use anyhow::{Context, Result};
use std::path::Path;

use crate::audit::logger::AuditLogger;
use crate::core::types::*;

/// Apply import rewrites to a file's source code.
/// Returns the new file contents with all import paths updated.
pub fn rewrite_imports_in_source(source: &str, rewrites: &[AffectedFile]) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let mut result_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();

    // Sort rewrites by line number (descending) so line numbers stay valid
    let mut sorted_rewrites: Vec<&AffectedFile> = rewrites.iter().collect();
    sorted_rewrites.sort_by(|a, b| b.line.cmp(&a.line));

    for rewrite in sorted_rewrites {
        let line_idx = rewrite.line.saturating_sub(1);
        if line_idx < result_lines.len() {
            let line = &result_lines[line_idx];
            // Replace the old import path with the new one
            let new_line = replace_import_source(line, &rewrite.old_import, &rewrite.new_import);
            result_lines[line_idx] = new_line;
        }
    }

    // Preserve trailing newline if original had one
    let mut result = result_lines.join("\n");
    if source.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Replace an import source string in a line of code.
/// Handles various quoting styles: "...", '...', `...`
fn replace_import_source(line: &str, old_source: &str, new_source: &str) -> String {
    // Try all quoting styles
    for (open, close) in [("\"", "\""), ("'", "'"), ("`", "`")] {
        let old_quoted = format!("{}{}{}", open, old_source, close);
        let new_quoted = format!("{}{}{}", open, new_source, close);
        if line.contains(&old_quoted) {
            return line.replacen(&old_quoted, &new_quoted, 1);
        }
    }

    // Fallback: simple text replacement
    line.replacen(old_source, new_source, 1)
}

/// Apply rewrites to actual files on disk.
/// If dry_run is true, returns what would change without writing.
pub fn apply_rewrites(
    move_result: &MoveResult,
    dry_run: bool,
    mut audit_logger: Option<&mut AuditLogger>,
) -> Result<Vec<AffectedFile>> {
    let mut applied = Vec::new();

    // Group rewrites by file
    let mut rewrites_by_file: std::collections::HashMap<&std::path::Path, Vec<&AffectedFile>> =
        std::collections::HashMap::new();

    for affected in &move_result.affected_files {
        rewrites_by_file
            .entry(affected.path.as_path())
            .or_default()
            .push(affected);
    }

    for (file_path, rewrites) in &rewrites_by_file {
        let source = std::fs::read_to_string(file_path)
            .with_context(|| format!("Failed to read file: {}", file_path.display()))?;

        let new_source = rewrite_imports_in_source(&source, &rewrites.iter().cloned().cloned().collect::<Vec<_>>());

        if source != new_source {
            if let Some(ref mut logger) = audit_logger.as_deref_mut() {
                for rewrite in rewrites {
                    logger.log(AuditEntry {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        operation: AuditOperation::Rewrite,
                        file: file_path.to_path_buf(),
                        old_content: rewrite.old_import.clone(),
                        new_content: rewrite.new_import.clone(),
                        line: rewrite.line,
                        rollbackable: true,
                    })?;
                }
            }

            if !dry_run {
                std::fs::write(file_path, &new_source)
                    .with_context(|| format!("Failed to write file: {}", file_path.display()))?;
            }

            for rewrite in rewrites {
                applied.push(AffectedFile {
                    path: file_path.to_path_buf(),
                    old_import: rewrite.old_import.clone(),
                    new_import: rewrite.new_import.clone(),
                    line: rewrite.line,
                    applied: !dry_run,
                });
            }
        }
    }

    Ok(applied)
}

/// Move the actual file on disk (if not dry_run).
pub fn move_file(old_path: &Path, new_path: &Path, dry_run: bool) -> Result<()> {
    if dry_run {
        return Ok(());
    }

    // Create parent directories
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory: {}", parent.display()))?;
    }

    std::fs::rename(old_path, new_path).with_context(|| {
        format!(
            "Failed to move file: {} -> {}",
            old_path.display(),
            new_path.display()
        )
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_replace_import_source_double_quotes() {
        let line = r#"import { foo } from "../lib/utils";"#;
        let result = replace_import_source(line, "../lib/utils", "../../shared/utils");
        assert_eq!(result, r#"import { foo } from "../../shared/utils";"#);
    }

    #[test]
    fn test_replace_import_source_single_quotes() {
        let line = "import { foo } from '../lib/utils';";
        let result = replace_import_source(line, "../lib/utils", "../../shared/utils");
        assert_eq!(result, "import { foo } from '../../shared/utils';");
    }

    #[test]
    fn test_rewrite_imports_in_source() {
        let source = r#"import { foo } from "../lib/utils";
import { bar } from "./helpers";
const x = 1;
"#;

        let rewrites = vec![
            AffectedFile {
                path: std::path::PathBuf::from("/test.ts"),
                old_import: "../lib/utils".to_string(),
                new_import: "../../shared/utils".to_string(),
                line: 1,
                applied: false,
            },
            AffectedFile {
                path: std::path::PathBuf::from("/test.ts"),
                old_import: "./helpers".to_string(),
                new_import: "../helpers".to_string(),
                line: 2,
                applied: false,
            },
        ];

        let result = rewrite_imports_in_source(source, &rewrites);
        assert!(result.contains("../../shared/utils"));
        assert!(result.contains("../helpers"));
        assert!(result.contains("const x = 1;"));
    }
}
