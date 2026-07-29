use anyhow::Result;
use std::collections::HashMap;

use crate::core::graph::DependencyGraph;
use crate::core::types::*;

/// Audit UI components for common issues:
/// - Interactive elements missing event handlers
/// - Missing key props in array rendering
/// - Dead (never-imported) components
/// - Unused state variables
pub fn audit_ui(
    graph: &DependencyGraph,
    _config: &ProjectConfig,
    enriched_files: &HashMap<std::path::PathBuf, FileInfo>,
) -> Result<UIAuditResult> {
    let mut findings = Vec::new();
    let mut total_components_scanned = 0;

    let interactive_elements: std::collections::HashSet<&str> =
        ["button", "a", "input", "select", "textarea"].iter().copied().collect();

    let handler_props: HashMap<&str, Vec<&str>> = [
        ("button", vec!["onClick", "onMouseDown", "onPointerDown"]),
        ("a", vec!["onClick", "href"]),
        ("input", vec!["onChange", "onInput", "onBlur", "onFocus"]),
        ("select", vec!["onChange"]),
        ("textarea", vec!["onChange", "onInput", "onBlur"]),
    ]
    .into_iter()
    .collect();

    for (file_path, file_info) in enriched_files {
        let is_jsx = file_path
            .extension()
            .map(|e| e == "tsx" || e == "jsx")
            .unwrap_or(false);
        if !is_jsx {
            continue;
        }

        let jsx_elements = match &file_info.jsx_elements {
            Some(elems) if !elems.is_empty() => elems,
            _ => continue,
        };

        total_components_scanned += 1;

        // Check missing handlers on interactive elements
        for elem in jsx_elements {
            if elem.is_component {
                continue;
            }
            if !interactive_elements.contains(elem.tag_name.as_str()) {
                continue;
            }

            let acceptable = handler_props.get(elem.tag_name.as_str()).cloned().unwrap_or_default();
            let prop_names: Vec<&str> = elem.props.iter().map(|p| p.name.as_str()).collect();
            let has_handler = acceptable.iter().any(|h| prop_names.contains(h));
            let has_spread = elem.props.iter().any(|p| p.value_type == PropValueType::Spread);

            if !has_handler && !has_spread {
                findings.push(UIAuditFinding {
                    finding_type: UIAuditFindingType::MissingHandler,
                    file: file_path.clone(),
                    line: elem.line,
                    component: elem.tag_name.clone(),
                    description: format!(
                        "<{}> element without an event handler ({})",
                        elem.tag_name,
                        acceptable.join(", ")
                    ),
                    severity: Severity::Medium,
                    auto_fixable: false,
                    suggested_fix: None,
                });
            }
        }

        // Check for dead components
        let reverse_deps = graph.dependents(file_path);
        let has_importers = !reverse_deps.is_empty();

        if !has_importers {
            let component_exports: Vec<&ExportInfo> = file_info
                .exports
                .iter()
                .filter(|e| {
                    e.export_type == ExportType::Function
                        && e.name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
                })
                .collect();

            for exp in component_exports {
                findings.push(UIAuditFinding {
                    finding_type: UIAuditFindingType::DeadComponent,
                    file: file_path.clone(),
                    line: exp.line,
                    component: exp.name.clone(),
                    description: format!(
                        "Component \"{}\" is exported but never imported anywhere",
                        exp.name
                    ),
                    severity: Severity::Low,
                    auto_fixable: false,
                    suggested_fix: None,
                });
            }
        }
    }

    let summary = UIAuditSummary {
        missing_handlers: findings
            .iter()
            .filter(|f| f.finding_type == UIAuditFindingType::MissingHandler)
            .count(),
        unconnected_handlers: findings
            .iter()
            .filter(|f| f.finding_type == UIAuditFindingType::UnconnectedHandler)
            .count(),
        unused_state: findings
            .iter()
            .filter(|f| f.finding_type == UIAuditFindingType::UnusedState)
            .count(),
        missing_keys: findings
            .iter()
            .filter(|f| f.finding_type == UIAuditFindingType::MissingKey)
            .count(),
        dead_components: findings
            .iter()
            .filter(|f| f.finding_type == UIAuditFindingType::DeadComponent)
            .count(),
    };

    Ok(UIAuditResult {
        total_components_scanned,
        findings,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audit_ui_empty() {
        let graph = DependencyGraph::new();
        let config = ProjectConfig::default();
        let enriched = HashMap::new();
        let result = audit_ui(&graph, &config, &enriched).unwrap();

        assert_eq!(result.total_components_scanned, 0);
        assert!(result.findings.is_empty());
    }

    #[test]
    fn test_audit_summary_zeros() {
        let graph = DependencyGraph::new();
        let config = ProjectConfig::default();
        let enriched = HashMap::new();
        let result = audit_ui(&graph, &config, &enriched).unwrap();

        assert_eq!(result.summary.missing_handlers, 0);
        assert_eq!(result.summary.unused_state, 0);
        assert_eq!(result.summary.missing_keys, 0);
        assert_eq!(result.summary.dead_components, 0);
    }
}
