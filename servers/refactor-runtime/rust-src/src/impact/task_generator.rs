use crate::core::types::*;
use crate::impact::classifier::determine_severity;

/// Generate structured task items from cascade effects that cannot be auto-fixed.
pub fn generate_tasks(
    change: &ChangeInfo,
    effects: &[CascadeEffect],
) -> Vec<TaskItem> {
    let mut tasks = Vec::new();

    for (i, effect) in effects.iter().enumerate() {
        if effect.auto_fixable {
            continue;
        }

        let severity = determine_severity(effect);
        let task_id = format!("task-{:03}", i + 1);

        tasks.push(TaskItem {
            id: task_id,
            file: effect.file.clone(),
            line: effect.line,
            severity,
            classification: effect.classification,
            description: effect.description.clone(),
            context: TaskContext {
                changed_entity: change.entity.clone(),
                change_type: change.change_type,
                calling_code: effect.calling_code.clone(),
                suggested_approach: effect
                    .suggested_fix
                    .clone()
                    .unwrap_or_else(|| "Manual review required".to_string()),
            },
            cascade_depth: effect.depth,
        });
    }

    // Sort by severity (critical first), then by depth (shallow first)
    tasks.sort_by(|a, b| {
        severity_order(&a.severity)
            .cmp(&severity_order(&b.severity))
            .then(a.cascade_depth.cmp(&b.cascade_depth))
    });

    tasks
}

fn severity_order(severity: &Severity) -> u8 {
    match severity {
        Severity::Critical => 0,
        Severity::High => 1,
        Severity::Medium => 2,
        Severity::Low => 3,
    }
}

/// Format tasks as a readable summary.
pub fn format_task_summary(tasks: &[TaskItem]) -> String {
    let mut output = String::new();
    output.push_str(&format!("Generated {} tasks:\n\n", tasks.len()));

    let critical = tasks.iter().filter(|t| t.severity == Severity::Critical).count();
    let high = tasks.iter().filter(|t| t.severity == Severity::High).count();
    let medium = tasks.iter().filter(|t| t.severity == Severity::Medium).count();
    let low = tasks.iter().filter(|t| t.severity == Severity::Low).count();

    output.push_str(&format!(
        "  Critical: {}  High: {}  Medium: {}  Low: {}\n\n",
        critical, high, medium, low
    ));

    for task in tasks {
        output.push_str(&format!(
            "[{}] {} ({}:{}) [depth={}]\n",
            format_severity(&task.severity),
            task.description,
            task.file.display(),
            task.line,
            task.cascade_depth,
        ));
        output.push_str(&format!("  Approach: {}\n", task.context.suggested_approach));
        output.push_str(&format!(
            "  Classification: {:?}\n\n",
            task.classification
        ));
    }

    output
}

fn format_severity(severity: &Severity) -> &str {
    match severity {
        Severity::Critical => "CRITICAL",
        Severity::High => "HIGH",
        Severity::Medium => "MEDIUM",
        Severity::Low => "LOW",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_generate_tasks_skips_auto_fixable() {
        let change = ChangeInfo {
            file: PathBuf::from("/src/lib.ts"),
            entity: "getUser".to_string(),
            change_type: ChangeType::ReturnTypeWidened,
            old_signature: Some("User".to_string()),
            new_signature: Some("User | null".to_string()),
        };

        let effects = vec![
            CascadeEffect {
                file: PathBuf::from("/src/app.ts"),
                line: 10,
                depth: 1,
                classification: Classification::MechanicalAuto,
                description: "Safe change".to_string(),
                calling_code: "".to_string(),
                suggested_fix: None,
                auto_fixable: true,
            },
            CascadeEffect {
                file: PathBuf::from("/src/api.ts"),
                line: 20,
                depth: 1,
                classification: Classification::LogicSimple,
                description: "Needs null check".to_string(),
                calling_code: "const user = getUser()".to_string(),
                suggested_fix: Some("Add null check".to_string()),
                auto_fixable: false,
            },
        ];

        let tasks = generate_tasks(&change, &effects);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].file, PathBuf::from("/src/api.ts"));
    }

    #[test]
    fn test_tasks_sorted_by_severity() {
        let change = ChangeInfo {
            file: PathBuf::from("/test.ts"),
            entity: "foo".to_string(),
            change_type: ChangeType::Removed,
            old_signature: None,
            new_signature: None,
        };

        let effects = vec![
            CascadeEffect {
                file: PathBuf::from("/a.ts"),
                line: 1,
                depth: 3,
                classification: Classification::LogicSimple,
                description: "a".to_string(),
                calling_code: "".to_string(),
                suggested_fix: None,
                auto_fixable: false,
            },
            CascadeEffect {
                file: PathBuf::from("/b.ts"),
                line: 1,
                depth: 1,
                classification: Classification::LogicComplex,
                description: "b".to_string(),
                calling_code: "".to_string(),
                suggested_fix: None,
                auto_fixable: false,
            },
        ];

        let tasks = generate_tasks(&change, &effects);
        assert_eq!(tasks.len(), 2);
        // LogicComplex at depth 1 = Critical, should come first
        assert_eq!(tasks[0].severity, Severity::Critical);
    }
}
