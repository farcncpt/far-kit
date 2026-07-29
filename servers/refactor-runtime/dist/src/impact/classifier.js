/**
 * Classify the impact of a change on a specific piece of calling code.
 */
export function classifyEffect(change, callingCode, depth) {
    switch (change.changeType) {
        case 'renamed':
            return classifyRename(change, callingCode);
        case 'param_added_optional':
            return {
                classification: 'mechanical_auto',
                description: `Optional parameter added to ${change.entity} — no action needed at call sites`,
                autoFixable: true,
            };
        case 'param_added_required':
            return classifyRequiredParam(change, callingCode, depth);
        case 'param_removed':
            return classifyParamRemoved(change, callingCode);
        case 'param_type_changed':
            return classifyParamTypeChanged(change, callingCode, depth);
        case 'return_type_widened':
            return classifyReturnTypeWidened(change, callingCode, depth);
        case 'return_type_narrowed':
            return {
                classification: 'mechanical_auto',
                description: `Return type of ${change.entity} narrowed — existing code is compatible`,
                autoFixable: true,
            };
        case 'return_type_changed':
            return classifyReturnTypeChanged(change, callingCode, depth);
        case 'removed':
            return classifyRemoved(change, depth);
        case 'interface_field_added':
            return classifyInterfaceFieldAdded(change, callingCode);
        case 'interface_field_removed':
            return classifyInterfaceFieldRemoved(change, callingCode);
        case 'interface_field_changed':
            return classifyInterfaceFieldChanged(change, callingCode, depth);
        default:
            return {
                classification: 'logic_complex',
                description: `Unknown change type in ${change.entity}`,
                autoFixable: false,
            };
    }
}
function classifyRename(change, callingCode) {
    return {
        classification: 'mechanical_auto',
        description: `${change.entity} renamed — update all references`,
        suggestedFix: change.newSignature
            ? `Rename ${change.oldSignature} to ${change.newSignature}`
            : undefined,
        autoFixable: true,
    };
}
function classifyRequiredParam(change, callingCode, depth) {
    if (depth <= 1) {
        return {
            classification: 'mechanical_confirm',
            description: `Required parameter added to ${change.entity}. Call site must be updated.`,
            suggestedFix: `Add required argument at call site: ${callingCode}`,
            autoFixable: false,
        };
    }
    return {
        classification: 'logic_simple',
        description: `${change.entity} now requires additional parameter. Indirect caller at depth ${depth}.`,
        suggestedFix: `Review call chain and determine correct value for new parameter`,
        autoFixable: false,
    };
}
function classifyParamRemoved(change, callingCode) {
    return {
        classification: 'mechanical_auto',
        description: `Parameter removed from ${change.entity}. Remove extra argument at call sites.`,
        suggestedFix: `Remove extra argument from: ${callingCode}`,
        autoFixable: true,
    };
}
function classifyParamTypeChanged(change, callingCode, depth) {
    if (depth <= 1) {
        return {
            classification: 'mechanical_confirm',
            description: `Parameter type changed in ${change.entity}: ${change.oldSignature} -> ${change.newSignature}`,
            suggestedFix: `Update argument type at call site`,
            autoFixable: false,
        };
    }
    return {
        classification: 'logic_simple',
        description: `Parameter type change in ${change.entity} cascaded to depth ${depth}`,
        autoFixable: false,
    };
}
function classifyReturnTypeWidened(change, callingCode, depth) {
    // Check if the calling code destructures the result directly
    const destructures = callingCode.includes('const {') ||
        callingCode.includes('let {') ||
        callingCode.includes('const [');
    if (destructures) {
        return {
            classification: 'logic_simple',
            description: `${change.entity} now returns ${change.newSignature}. Line destructures directly — will crash on null.`,
            suggestedFix: `Add null check before destructuring: ${callingCode}`,
            autoFixable: false,
        };
    }
    // Check for property access on result
    const accessesProperty = callingCode.includes(`.`) &&
        callingCode.includes(change.entity.split('.')[0]);
    if (accessesProperty) {
        return {
            classification: 'mechanical_confirm',
            description: `${change.entity} return type widened to include null/undefined. Property access may crash.`,
            suggestedFix: `Add optional chaining or null check`,
            autoFixable: false,
        };
    }
    return {
        classification: depth <= 1 ? 'mechanical_confirm' : 'logic_simple',
        description: `Return type of ${change.entity} widened: ${change.oldSignature} -> ${change.newSignature}`,
        suggestedFix: `Add null/undefined handling`,
        autoFixable: false,
    };
}
function classifyReturnTypeChanged(change, callingCode, depth) {
    if (depth <= 2) {
        return {
            classification: 'logic_simple',
            description: `Return type of ${change.entity} changed: ${change.oldSignature} -> ${change.newSignature}`,
            suggestedFix: `Review callers that depend on the old return type`,
            autoFixable: false,
        };
    }
    return {
        classification: 'logic_complex',
        description: `Return type change in ${change.entity} cascaded to depth ${depth}. Full chain analysis needed.`,
        autoFixable: false,
    };
}
function classifyRemoved(change, depth) {
    if (depth <= 1) {
        return {
            classification: 'architectural',
            description: `${change.entity} was removed. All direct usages must be replaced or deleted.`,
            autoFixable: false,
        };
    }
    return {
        classification: 'logic_complex',
        description: `${change.entity} was removed. Indirect usage at depth ${depth} will break.`,
        autoFixable: false,
    };
}
function classifyInterfaceFieldAdded(change, callingCode) {
    return {
        classification: 'mechanical_confirm',
        description: `New field added to ${change.entity}. Implementations must include this field.`,
        suggestedFix: `Add the new field to all implementations`,
        autoFixable: false,
    };
}
function classifyInterfaceFieldRemoved(change, callingCode) {
    return {
        classification: 'mechanical_auto',
        description: `Field removed from ${change.entity}. Remove field from all implementations.`,
        suggestedFix: `Remove field from implementations`,
        autoFixable: true,
    };
}
function classifyInterfaceFieldChanged(change, callingCode, depth) {
    return {
        classification: depth <= 1 ? 'mechanical_confirm' : 'logic_simple',
        description: `Field type changed in ${change.entity}: ${change.oldSignature} -> ${change.newSignature}`,
        suggestedFix: `Update field type in all implementations`,
        autoFixable: false,
    };
}
//# sourceMappingURL=classifier.js.map