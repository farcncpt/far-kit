/**
 * Audit UI components for common issues:
 * - Interactive elements missing event handlers
 * - Missing key props in array rendering
 * - Dead (never-imported) components
 * - Unused state variables
 */
export function auditUI(graph, config, enrichedFiles) {
    const findings = [];
    let totalComponentsScanned = 0;
    const INTERACTIVE_ELEMENTS = new Set([
        'button', 'a', 'input', 'select', 'textarea',
    ]);
    const HANDLER_PROPS = {
        button: ['onClick', 'onMouseDown', 'onPointerDown'],
        a: ['onClick', 'href'],
        input: ['onChange', 'onInput', 'onBlur', 'onFocus'],
        select: ['onChange'],
        textarea: ['onChange', 'onInput', 'onBlur'],
    };
    for (const [filePath, fileInfo] of enrichedFiles) {
        const isJSX = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
        if (!isJSX)
            continue;
        const jsxElements = fileInfo.jsxElements;
        if (!jsxElements || jsxElements.length === 0)
            continue;
        totalComponentsScanned++;
        // --- Missing handlers on interactive elements ---
        for (const elem of jsxElements) {
            if (elem.isComponent)
                continue; // Only check HTML elements
            if (!INTERACTIVE_ELEMENTS.has(elem.tagName))
                continue;
            const acceptableHandlers = HANDLER_PROPS[elem.tagName] || [];
            const propNames = elem.props.map((p) => p.name);
            const hasHandler = acceptableHandlers.some((h) => propNames.includes(h));
            // Also accept spread props as they may include handlers
            const hasSpread = elem.props.some((p) => p.valueType === 'spread');
            if (!hasHandler && !hasSpread) {
                findings.push({
                    type: 'missing_handler',
                    file: fileInfo.relativePath,
                    line: elem.line,
                    component: elem.tagName,
                    description: `<${elem.tagName}> element without an event handler (${acceptableHandlers.join(', ')})`,
                    severity: 'medium',
                    autoFixable: false,
                });
            }
        }
        // --- Missing key props in array .map() ---
        // Heuristic: look for callSites with callee 'map', then check if JSX elements
        // near those lines lack a 'key' prop.
        if (fileInfo.callSites) {
            const mapCalls = fileInfo.callSites.filter((c) => c.callee === 'map');
            for (const mapCall of mapCalls) {
                // Find JSX elements on or after the map call line (within a reasonable range)
                const nearbyJSX = jsxElements.filter((e) => e.line >= mapCall.line && e.line <= mapCall.line + 10);
                for (const elem of nearbyJSX) {
                    // Only check the first/outermost JSX element returned from map
                    // (which should have a key prop)
                    if (elem.isComponent || !elem.isComponent) {
                        const hasKey = elem.props.some((p) => p.name === 'key');
                        if (!hasKey) {
                            findings.push({
                                type: 'missing_key',
                                file: fileInfo.relativePath,
                                line: elem.line,
                                component: elem.tagName,
                                description: `<${elem.tagName}> inside .map() without a "key" prop`,
                                severity: 'high',
                                autoFixable: false,
                            });
                            break; // One finding per map call
                        }
                    }
                }
            }
        }
        // --- Unused state variables ---
        if (fileInfo.callSites && fileInfo.symbolUsages) {
            const useStateCalls = fileInfo.callSites.filter((c) => c.callee === 'useState');
            // For each useState call, the destructured setter might be unused.
            // In array destructuring `const [val, setVal] = useState(...)`, the
            // identifiers inside the binding pattern appear in symbolUsages
            // (BindingElement names are NOT skipped by the parser, unlike
            // VariableDeclaration names). So `setVal` appears once for the
            // destructuring site. If it's used elsewhere, refCount > 1.
            for (const usCall of useStateCalls) {
                // Find identifiers on the same line that start with 'set'
                const settersOnLine = fileInfo.symbolUsages.filter((u) => u.line === usCall.line && u.name.startsWith('set'));
                for (const setter of settersOnLine) {
                    // Count all references to this setter in the file.
                    // One reference is the destructuring binding itself.
                    // If only 1 occurrence, the setter is never used after destructuring.
                    const refCount = fileInfo.symbolUsages.filter((u) => u.name === setter.name).length;
                    if (refCount <= 1) {
                        findings.push({
                            type: 'unused_state',
                            file: fileInfo.relativePath,
                            line: usCall.line,
                            component: filePath.split('/').pop() || '',
                            description: `useState setter "${setter.name}" appears unused`,
                            severity: 'low',
                            autoFixable: false,
                        });
                    }
                }
            }
        }
    }
    // --- Dead components ---
    // Components exported from files that are never imported anywhere in the graph.
    for (const [filePath, fileInfo] of enrichedFiles) {
        const isJSX = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
        if (!isJSX)
            continue;
        const reverseEdges = graph.reverseEdges.get(filePath);
        const hasImporters = reverseEdges && reverseEdges.size > 0;
        if (!hasImporters) {
            // Check if it exports components (functions returning JSX)
            const componentExports = fileInfo.exports.filter((e) => e.type === 'function' && /^[A-Z]/.test(e.name));
            for (const exp of componentExports) {
                findings.push({
                    type: 'dead_component',
                    file: fileInfo.relativePath,
                    line: exp.line,
                    component: exp.name,
                    description: `Component "${exp.name}" is exported but never imported anywhere`,
                    severity: 'low',
                    autoFixable: false,
                });
            }
        }
    }
    // Build summary
    const summary = {
        missingHandlers: findings.filter((f) => f.type === 'missing_handler').length,
        unconnectedHandlers: findings.filter((f) => f.type === 'unconnected_handler').length,
        unusedState: findings.filter((f) => f.type === 'unused_state').length,
        missingKeys: findings.filter((f) => f.type === 'missing_key').length,
        deadComponents: findings.filter((f) => f.type === 'dead_component').length,
    };
    return {
        totalComponentsScanned,
        findings,
        summary,
    };
}
//# sourceMappingURL=auditor.js.map