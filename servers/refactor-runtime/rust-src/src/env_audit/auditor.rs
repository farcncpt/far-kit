use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::core::types::*;

/// Parse a .env file and return a map of variable names to their values.
fn parse_env_file(file_path: &Path) -> Result<HashMap<String, String>> {
    let content = std::fs::read_to_string(file_path)?;
    let mut vars = HashMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(eq_idx) = trimmed.find('=') {
            let key = trimmed[..eq_idx].trim().to_string();
            let value = trimmed[eq_idx + 1..].trim().to_string();
            if !key.is_empty() {
                vars.insert(key, value);
            }
        }
    }

    Ok(vars)
}

/// Audit environment variables: find stale, missing, no-default, and inconsistent vars.
pub fn audit_env(
    _config: &ProjectConfig,
    env_files: &[std::path::PathBuf],
    enriched_files: &HashMap<std::path::PathBuf, FileInfo>,
) -> Result<EnvAuditResult> {
    // 1. Parse all env files
    let mut env_file_maps: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut all_declared_vars: HashSet<String> = HashSet::new();

    for env_file in env_files {
        if let Ok(vars) = parse_env_file(env_file) {
            for key in vars.keys() {
                all_declared_vars.insert(key.clone());
            }
            env_file_maps.insert(env_file.to_string_lossy().to_string(), vars);
        }
    }

    // 2. Collect all env references from enriched files
    let mut referenced_vars: HashMap<String, Vec<VarUsage>> = HashMap::new();
    let mut has_default: HashMap<String, bool> = HashMap::new();

    for (_file_path, file_info) in enriched_files {
        if let Some(ref env_refs) = file_info.env_references {
            for env_ref in env_refs {
                referenced_vars
                    .entry(env_ref.variable.clone())
                    .or_default()
                    .push(VarUsage {
                        file: std::path::PathBuf::from(&file_info.relative_path),
                        line: env_ref.line,
                    });

                if env_ref.has_default {
                    has_default.insert(env_ref.variable.clone(), true);
                }
            }
        }
    }

    // 3. Stale vars: in env files but never referenced in code
    let mut stale_vars = Vec::new();
    for var_name in &all_declared_vars {
        if !referenced_vars.contains_key(var_name) {
            let declared_in: Vec<String> = env_file_maps
                .iter()
                .filter(|(_, vars)| vars.contains_key(var_name))
                .map(|(env_file, _)| env_file.clone())
                .collect();
            stale_vars.push(StaleVar {
                name: var_name.clone(),
                declared_in,
            });
        }
    }

    // 4. Missing vars: referenced in code but not in any env file
    let mut missing_vars = Vec::new();
    for (var_name, refs) in &referenced_vars {
        if !all_declared_vars.contains(var_name) {
            missing_vars.push(MissingVar {
                name: var_name.clone(),
                used_in: refs.clone(),
            });
        }
    }

    // 5. No-default vars
    let mut no_default_vars = Vec::new();
    for (var_name, refs) in &referenced_vars {
        let var_has_default = has_default.get(var_name).copied().unwrap_or(false);
        if !var_has_default && !all_declared_vars.contains(var_name) {
            no_default_vars.push(NoDefaultVar {
                name: var_name.clone(),
                used_in: refs.clone(),
            });
        }
    }

    // 6. Inconsistent vars
    let mut inconsistent_vars = Vec::new();
    if env_files.len() > 1 {
        for var_name in &all_declared_vars {
            let mut present_in = Vec::new();
            let mut missing_from = Vec::new();
            for (env_file, vars) in &env_file_maps {
                if vars.contains_key(var_name) {
                    present_in.push(env_file.clone());
                } else {
                    missing_from.push(env_file.clone());
                }
            }
            if !missing_from.is_empty() && !present_in.is_empty() {
                inconsistent_vars.push(InconsistentVar {
                    name: var_name.clone(),
                    present_in,
                    missing_from,
                });
            }
        }
    }

    Ok(EnvAuditResult {
        stale_vars,
        missing_vars,
        no_default_vars,
        inconsistent_vars,
        total_declared: all_declared_vars.len(),
        total_referenced: referenced_vars.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audit_env_empty() {
        let config = ProjectConfig::default();
        let enriched = HashMap::new();
        let result = audit_env(&config, &[], &enriched).unwrap();

        assert!(result.stale_vars.is_empty());
        assert!(result.missing_vars.is_empty());
        assert!(result.no_default_vars.is_empty());
        assert!(result.inconsistent_vars.is_empty());
        assert_eq!(result.total_declared, 0);
        assert_eq!(result.total_referenced, 0);
    }

    #[test]
    fn test_parse_env_file_basic() {
        let dir = std::env::temp_dir();
        let env_path = dir.join("test_refactor_env_audit.env");
        std::fs::write(&env_path, "FOO=bar\n# comment\nBAZ=qux\n").unwrap();

        let result = parse_env_file(&env_path).unwrap();
        assert_eq!(result.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(result.get("BAZ"), Some(&"qux".to_string()));
        assert!(!result.contains_key("# comment"));

        std::fs::remove_file(&env_path).ok();
    }
}
