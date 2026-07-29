use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::core::types::ProjectConfig;

#[derive(Debug, Deserialize)]
struct TsConfig {
    #[serde(rename = "compilerOptions")]
    compiler_options: Option<CompilerOptions>,
}

#[derive(Debug, Deserialize)]
struct CompilerOptions {
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    paths: Option<HashMap<String, Vec<String>>>,
}

pub fn load_project_config(project_root: &Path) -> Result<ProjectConfig> {
    let tsconfig_path = project_root.join("tsconfig.json");

    let mut config = ProjectConfig {
        project_root: project_root.to_path_buf(),
        ..Default::default()
    };

    if tsconfig_path.exists() {
        let content = std::fs::read_to_string(&tsconfig_path)?;
        // Strip JSON comments (// and /* */) before parsing
        let stripped = strip_json_comments(&content);
        if let Ok(tsconfig) = serde_json::from_str::<TsConfig>(&stripped) {
            if let Some(opts) = tsconfig.compiler_options {
                config.base_url = opts.base_url;
                if let Some(paths) = opts.paths {
                    config.path_aliases = paths;
                }
            }
        }
    }

    Ok(config)
}

fn strip_json_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_string = false;

    while i < len {
        if in_string {
            result.push(chars[i]);
            if chars[i] == '\\' && i + 1 < len {
                i += 1;
                result.push(chars[i]);
            } else if chars[i] == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if chars[i] == '"' {
            in_string = true;
            result.push(chars[i]);
            i += 1;
            continue;
        }

        if chars[i] == '/' && i + 1 < len {
            if chars[i + 1] == '/' {
                // Line comment — skip until newline
                while i < len && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            } else if chars[i + 1] == '*' {
                // Block comment — skip until */
                i += 2;
                while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2; // skip */
                continue;
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

pub fn resolve_alias(
    import_source: &str,
    config: &ProjectConfig,
) -> Option<PathBuf> {
    for (alias_pattern, targets) in &config.path_aliases {
        let prefix = alias_pattern.trim_end_matches('*');
        if import_source.starts_with(prefix) {
            let remainder = &import_source[prefix.len()..];
            if let Some(target) = targets.first() {
                let target_prefix = target.trim_end_matches('*');
                let base = if let Some(ref base_url) = config.base_url {
                    config.project_root.join(base_url)
                } else {
                    config.project_root.clone()
                };
                let resolved = base.join(target_prefix).join(remainder);
                return Some(resolved);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_json_comments() {
        let input = r#"{
  // This is a comment
  "key": "value", // trailing
  /* block comment */
  "key2": "val//ue"
}"#;
        let stripped = strip_json_comments(input);
        let parsed: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(parsed["key"], "value");
        assert_eq!(parsed["key2"], "val//ue");
    }

    #[test]
    fn test_resolve_alias() {
        let config = ProjectConfig {
            project_root: PathBuf::from("/project"),
            path_aliases: HashMap::from([
                ("@/*".to_string(), vec!["./src/*".to_string()]),
            ]),
            base_url: Some(".".to_string()),
            ..Default::default()
        };

        let result = resolve_alias("@/lib/auth", &config);
        assert!(result.is_some());
        let resolved = result.unwrap();
        assert!(resolved.to_string_lossy().contains("src"));
        assert!(resolved.to_string_lossy().contains("lib"));
    }
}
