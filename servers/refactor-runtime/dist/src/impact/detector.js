import { Project, } from 'ts-morph';
/**
 * Detect changes between two versions of a file by comparing their ASTs.
 */
export function detectChanges(oldContent, newContent, filePath) {
    const project = new Project({
        compilerOptions: { allowJs: true, jsx: 4 },
        skipAddingFilesFromTsConfig: true,
        useInMemoryFileSystem: true,
    });
    const oldFile = project.createSourceFile('old.ts', oldContent);
    const newFile = project.createSourceFile('new.ts', newContent);
    const changes = [];
    // Compare functions
    changes.push(...compareFunctions(oldFile, newFile, filePath));
    // Compare interfaces
    changes.push(...compareInterfaces(oldFile, newFile, filePath));
    // Compare type aliases
    changes.push(...compareTypeAliases(oldFile, newFile, filePath));
    // Compare classes
    changes.push(...compareClasses(oldFile, newFile, filePath));
    return changes;
}
function compareFunctions(oldFile, newFile, filePath) {
    const changes = [];
    const oldFuncs = new Map();
    const newFuncs = new Map();
    for (const f of oldFile.getFunctions()) {
        const name = f.getName();
        if (name)
            oldFuncs.set(name, f);
    }
    for (const f of newFile.getFunctions()) {
        const name = f.getName();
        if (name)
            newFuncs.set(name, f);
    }
    // Check for removed functions
    for (const [name, oldFunc] of oldFuncs) {
        if (!newFuncs.has(name)) {
            changes.push({
                file: filePath,
                entity: name,
                changeType: 'removed',
                oldSignature: formatFuncSignature(oldFunc),
            });
            continue;
        }
        const newFunc = newFuncs.get(name);
        // Compare parameters
        const oldParams = oldFunc.getParameters();
        const newParams = newFunc.getParameters();
        // Check for added/removed params
        if (newParams.length > oldParams.length) {
            for (let i = oldParams.length; i < newParams.length; i++) {
                const param = newParams[i];
                const changeType = param.isOptional() || param.hasInitializer()
                    ? 'param_added_optional'
                    : 'param_added_required';
                changes.push({
                    file: filePath,
                    entity: name,
                    changeType,
                    oldSignature: formatFuncSignature(oldFunc),
                    newSignature: formatFuncSignature(newFunc),
                });
            }
        }
        if (newParams.length < oldParams.length) {
            for (let i = newParams.length; i < oldParams.length; i++) {
                changes.push({
                    file: filePath,
                    entity: name,
                    changeType: 'param_removed',
                    oldSignature: formatFuncSignature(oldFunc),
                    newSignature: formatFuncSignature(newFunc),
                });
            }
        }
        // Check param type changes
        const minLen = Math.min(oldParams.length, newParams.length);
        for (let i = 0; i < minLen; i++) {
            const oldType = oldParams[i].getType().getText();
            const newType = newParams[i].getType().getText();
            if (oldType !== newType) {
                changes.push({
                    file: filePath,
                    entity: name,
                    changeType: 'param_type_changed',
                    oldSignature: formatFuncSignature(oldFunc),
                    newSignature: formatFuncSignature(newFunc),
                });
            }
        }
        // Compare return types
        const oldReturn = oldFunc.getReturnType().getText();
        const newReturn = newFunc.getReturnType().getText();
        if (oldReturn !== newReturn) {
            let changeType = 'return_type_changed';
            if (newReturn.includes('| null') || newReturn.includes('| undefined')) {
                changeType = 'return_type_widened';
            }
            else if (oldReturn.includes('| null') || oldReturn.includes('| undefined')) {
                changeType = 'return_type_narrowed';
            }
            changes.push({
                file: filePath,
                entity: name,
                changeType,
                oldSignature: formatFuncSignature(oldFunc),
                newSignature: formatFuncSignature(newFunc),
            });
        }
    }
    return changes;
}
function compareInterfaces(oldFile, newFile, filePath) {
    const changes = [];
    const oldIfaces = new Map();
    const newIfaces = new Map();
    for (const i of oldFile.getInterfaces()) {
        oldIfaces.set(i.getName(), i);
    }
    for (const i of newFile.getInterfaces()) {
        newIfaces.set(i.getName(), i);
    }
    for (const [name, oldIface] of oldIfaces) {
        if (!newIfaces.has(name)) {
            changes.push({
                file: filePath,
                entity: name,
                changeType: 'removed',
            });
            continue;
        }
        const newIface = newIfaces.get(name);
        const oldProps = new Map(oldIface.getProperties().map((p) => [p.getName(), p.getType().getText()]));
        const newProps = new Map(newIface.getProperties().map((p) => [p.getName(), p.getType().getText()]));
        // Removed fields
        for (const [propName] of oldProps) {
            if (!newProps.has(propName)) {
                changes.push({
                    file: filePath,
                    entity: `${name}.${propName}`,
                    changeType: 'interface_field_removed',
                });
            }
        }
        // Added fields
        for (const [propName] of newProps) {
            if (!oldProps.has(propName)) {
                changes.push({
                    file: filePath,
                    entity: `${name}.${propName}`,
                    changeType: 'interface_field_added',
                });
            }
        }
        // Changed fields
        for (const [propName, oldType] of oldProps) {
            const newType = newProps.get(propName);
            if (newType && oldType !== newType) {
                changes.push({
                    file: filePath,
                    entity: `${name}.${propName}`,
                    changeType: 'interface_field_changed',
                    oldSignature: oldType,
                    newSignature: newType,
                });
            }
        }
    }
    return changes;
}
function compareTypeAliases(oldFile, newFile, filePath) {
    const changes = [];
    const oldTypes = new Map();
    const newTypes = new Map();
    for (const t of oldFile.getTypeAliases()) {
        oldTypes.set(t.getName(), t.getType().getText());
    }
    for (const t of newFile.getTypeAliases()) {
        newTypes.set(t.getName(), t.getType().getText());
    }
    for (const [name, oldType] of oldTypes) {
        if (!newTypes.has(name)) {
            changes.push({ file: filePath, entity: name, changeType: 'removed' });
        }
        else if (newTypes.get(name) !== oldType) {
            changes.push({
                file: filePath,
                entity: name,
                changeType: 'return_type_changed',
                oldSignature: oldType,
                newSignature: newTypes.get(name),
            });
        }
    }
    return changes;
}
function compareClasses(oldFile, newFile, filePath) {
    const changes = [];
    const oldClasses = new Map();
    const newClasses = new Map();
    for (const c of oldFile.getClasses()) {
        const name = c.getName();
        if (name)
            oldClasses.set(name, c);
    }
    for (const c of newFile.getClasses()) {
        const name = c.getName();
        if (name)
            newClasses.set(name, c);
    }
    for (const [name, oldClass] of oldClasses) {
        if (!newClasses.has(name)) {
            changes.push({ file: filePath, entity: name, changeType: 'removed' });
            continue;
        }
        const newClass = newClasses.get(name);
        // Compare methods
        const oldMethods = new Map(oldClass.getMethods().map((m) => [m.getName(), m]));
        const newMethods = new Map(newClass.getMethods().map((m) => [m.getName(), m]));
        for (const [methodName, oldMethod] of oldMethods) {
            if (!newMethods.has(methodName)) {
                changes.push({
                    file: filePath,
                    entity: `${name}.${methodName}`,
                    changeType: 'removed',
                });
            }
        }
    }
    return changes;
}
function formatFuncSignature(func) {
    const params = func
        .getParameters()
        .map((p) => {
        const opt = p.isOptional() ? '?' : '';
        return `${p.getName()}${opt}: ${p.getType().getText()}`;
    })
        .join(', ');
    const ret = func.getReturnType().getText();
    const async = func.isAsync() ? 'async ' : '';
    return `${async}function ${func.getName() || 'anonymous'}(${params}): ${ret}`;
}
//# sourceMappingURL=detector.js.map