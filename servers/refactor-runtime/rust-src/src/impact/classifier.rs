use crate::core::types::*;

/// Re-classify cascade effects based on additional context.
/// This is a second pass that can upgrade/downgrade classifications
/// based on patterns in the calling code.
pub fn reclassify_effects(effects: &mut [CascadeEffect]) {
    for effect in effects.iter_mut() {
        // Destructuring patterns are more dangerous when type widens to nullable
        if effect.calling_code.contains("const {")
            || effect.calling_code.contains("let {")
        {
            if effect.classification == Classification::MechanicalConfirm {
                effect.classification = Classification::LogicSimple;
                effect.description = format!(
                    "{} (destructuring pattern detected — may crash on null)",
                    effect.description
                );
            }
        }

        // Deep cascade effects (depth > 3) are always at least logic_simple
        if effect.depth > 3 && effect.classification == Classification::MechanicalAuto {
            effect.classification = Classification::MechanicalConfirm;
        }

        // Effects in test files can be downgraded
        let file_str = effect.file.to_string_lossy();
        if file_str.contains("__tests__")
            || file_str.contains(".test.")
            || file_str.contains(".spec.")
            || file_str.contains("/test/")
            || file_str.contains("/tests/")
        {
            if effect.classification == Classification::LogicComplex {
                effect.classification = Classification::LogicSimple;
            }
        }
    }
}

/// Determine severity for a change effect based on its classification and depth.
pub fn determine_severity(effect: &CascadeEffect) -> Severity {
    match effect.classification {
        Classification::Architectural => Severity::Critical,
        Classification::LogicComplex => {
            if effect.depth <= 1 {
                Severity::Critical
            } else {
                Severity::High
            }
        }
        Classification::LogicSimple => {
            if effect.depth <= 1 {
                Severity::High
            } else {
                Severity::Medium
            }
        }
        Classification::MechanicalConfirm => Severity::Medium,
        Classification::MechanicalAuto => Severity::Low,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_reclassify_destructuring() {
        let mut effects = vec![CascadeEffect {
            file: PathBuf::from("/src/app.ts"),
            line: 10,
            depth: 1,
            classification: Classification::MechanicalConfirm,
            description: "Return type widened".to_string(),
            calling_code: "const { name } = getUser()".to_string(),
            suggested_fix: None,
            auto_fixable: false,
        }];

        reclassify_effects(&mut effects);
        assert_eq!(effects[0].classification, Classification::LogicSimple);
    }

    #[test]
    fn test_severity_levels() {
        let effect = CascadeEffect {
            file: PathBuf::from("/test.ts"),
            line: 1,
            depth: 1,
            classification: Classification::LogicComplex,
            description: "test".to_string(),
            calling_code: "".to_string(),
            suggested_fix: None,
            auto_fixable: false,
        };
        assert_eq!(determine_severity(&effect), Severity::Critical);

        let effect2 = CascadeEffect {
            file: PathBuf::from("/test.ts"),
            line: 1,
            depth: 3,
            classification: Classification::MechanicalAuto,
            description: "test".to_string(),
            calling_code: "".to_string(),
            suggested_fix: None,
            auto_fixable: true,
        };
        assert_eq!(determine_severity(&effect2), Severity::Low);
    }
}
