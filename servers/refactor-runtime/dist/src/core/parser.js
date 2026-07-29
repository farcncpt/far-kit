import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project, SyntaxKind, Node, } from 'ts-morph';
import { resolveImportPath } from './resolver.js';
// Reuse a single Project instance across parses for performance
let sharedProject = null;
function getProject() {
    if (!sharedProject) {
        sharedProject = new Project({
            compilerOptions: {
                allowJs: true,
                jsx: 4, // JsxEmit.ReactJSX
            },
            skipAddingFilesFromTsConfig: true,
            useInMemoryFileSystem: false,
        });
    }
    return sharedProject;
}
/**
 * Reset the shared project (useful for testing).
 */
export function resetParser() {
    sharedProject = null;
}
/**
 * Extract @import statements from CSS files.
 * Handles: @import 'pkg'; @import "pkg"; @import url('pkg'); @import url("pkg");
 */
function extractCssImports(content, filePath, config) {
    const imports = [];
    const importRegex = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?/g;
    let match;
    const lines = content.split('\n');
    while ((match = importRegex.exec(content)) !== null) {
        const source = match[1];
        // Skip relative imports for dep auditing — only care about package names
        if (source.startsWith('.') || source.startsWith('/'))
            continue;
        // Calculate line number from match index
        const upToMatch = content.slice(0, match.index);
        const line = upToMatch.split('\n').length;
        imports.push({
            source,
            resolvedPath: '',
            specifiers: [],
            type: 'css',
            isTypeOnly: false,
            line,
            column: 0,
        });
    }
    return imports;
}
/**
 * Parse a single file and extract imports/exports.
 */
export function parseFile(filePath, config, enrichments) {
    const project = getProject();
    const ext = path.extname(filePath);
    const language = ext === '.css' ? 'css'
        : (ext === '.ts' || ext === '.tsx') ? 'typescript'
            : 'javascript';
    if (language === 'css') {
        const content = fs.readFileSync(filePath, 'utf-8');
        const cssImports = extractCssImports(content, filePath, config);
        return {
            path: filePath,
            relativePath: path.relative(config.projectRoot, filePath),
            imports: cssImports,
            exports: [],
            language,
        };
    }
    // Add or get the source file
    let sourceFile;
    try {
        sourceFile = project.addSourceFileAtPath(filePath);
    }
    catch {
        sourceFile = project.getSourceFileOrThrow(filePath);
    }
    const imports = extractImports(sourceFile, filePath, config);
    const exports = extractExports(sourceFile);
    const result = {
        path: filePath,
        relativePath: path.relative(config.projectRoot, filePath),
        imports,
        exports,
        language,
    };
    if (enrichments) {
        if (enrichments.includes('symbolUsages')) {
            result.symbolUsages = extractSymbolUsages(sourceFile);
        }
        if (enrichments.includes('jsxElements')) {
            result.jsxElements = extractJSXElements(sourceFile);
        }
        if (enrichments.includes('envReferences')) {
            result.envReferences = extractEnvReferences(sourceFile);
        }
        if (enrichments.includes('callSites')) {
            result.callSites = extractCallSites(sourceFile);
        }
    }
    // Remove from project to avoid accumulating files
    project.removeSourceFile(sourceFile);
    return result;
}
function extractImports(sourceFile, filePath, config) {
    const imports = [];
    const dir = path.dirname(filePath);
    // Static imports: import { x } from 'y'
    for (const decl of sourceFile.getImportDeclarations()) {
        const source = decl.getModuleSpecifierValue();
        const resolvedPath = resolveImportPath(source, dir, config);
        const specifiers = extractImportSpecifiers(decl);
        const isTypeOnly = decl.isTypeOnly();
        const line = decl.getStartLineNumber();
        const column = decl.getStart() - (sourceFile.getFullText().lastIndexOf('\n', decl.getStart()) + 1);
        imports.push({
            source,
            resolvedPath,
            specifiers,
            type: 'static',
            isTypeOnly,
            line,
            column,
        });
    }
    // Re-export sources: export { x } from 'y', export * from 'y'
    // These create dependency edges just like imports
    for (const decl of sourceFile.getExportDeclarations()) {
        const moduleSpecifier = decl.getModuleSpecifierValue();
        if (moduleSpecifier) {
            const resolvedPath = resolveImportPath(moduleSpecifier, dir, config);
            const specifiers = decl.getNamedExports().map((named) => ({
                name: named.getName(),
                alias: named.getAliasNode()?.getText(),
                isDefault: false,
                isNamespace: false,
            }));
            // For `export * from 'y'`, mark as namespace
            if (specifiers.length === 0) {
                specifiers.push({ name: '*', isDefault: false, isNamespace: true });
            }
            imports.push({
                source: moduleSpecifier,
                resolvedPath,
                specifiers,
                type: 'static',
                isTypeOnly: decl.isTypeOnly(),
                line: decl.getStartLineNumber(),
                column: 0,
            });
        }
    }
    // Dynamic imports: import('x') and require('x')
    sourceFile.forEachDescendant((node) => {
        if (Node.isCallExpression(node)) {
            const expr = node.getExpression();
            // Dynamic import()
            if (expr.getKind() === SyntaxKind.ImportKeyword) {
                const args = node.getArguments();
                if (args.length > 0 && Node.isStringLiteral(args[0])) {
                    const source = args[0].getLiteralValue();
                    const resolvedPath = resolveImportPath(source, dir, config);
                    imports.push({
                        source,
                        resolvedPath,
                        specifiers: [],
                        type: 'dynamic',
                        isTypeOnly: false,
                        line: node.getStartLineNumber(),
                        column: 0,
                    });
                }
            }
            // require()
            if (Node.isIdentifier(expr) && expr.getText() === 'require') {
                const args = node.getArguments();
                if (args.length > 0 && Node.isStringLiteral(args[0])) {
                    const source = args[0].getLiteralValue();
                    const resolvedPath = resolveImportPath(source, dir, config);
                    imports.push({
                        source,
                        resolvedPath,
                        specifiers: [],
                        type: 'require',
                        isTypeOnly: false,
                        line: node.getStartLineNumber(),
                        column: 0,
                    });
                }
            }
        }
    });
    return imports;
}
function extractImportSpecifiers(decl) {
    const specifiers = [];
    // Default import
    const defaultImport = decl.getDefaultImport();
    if (defaultImport) {
        specifiers.push({
            name: 'default',
            alias: defaultImport.getText(),
            isDefault: true,
            isNamespace: false,
        });
    }
    // Namespace import: import * as x
    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport) {
        specifiers.push({
            name: '*',
            alias: namespaceImport.getText(),
            isDefault: false,
            isNamespace: true,
        });
    }
    // Named imports: import { a, b as c }
    for (const named of decl.getNamedImports()) {
        const name = named.getName();
        const alias = named.getAliasNode()?.getText();
        specifiers.push({
            name,
            alias: alias !== name ? alias : undefined,
            isDefault: false,
            isNamespace: false,
        });
    }
    return specifiers;
}
function extractExports(sourceFile) {
    const exports = [];
    // Export declarations: export { x } from 'y', export { x }
    for (const decl of sourceFile.getExportDeclarations()) {
        const moduleSpecifier = decl.getModuleSpecifierValue();
        for (const named of decl.getNamedExports()) {
            exports.push({
                name: named.getName(),
                type: 're-export',
                isDefault: false,
                reExportSource: moduleSpecifier,
                line: decl.getStartLineNumber(),
            });
        }
        // export * from 'y'
        if (decl.getNamedExports().length === 0 && moduleSpecifier) {
            exports.push({
                name: '*',
                type: 're-export',
                isDefault: false,
                reExportSource: moduleSpecifier,
                line: decl.getStartLineNumber(),
            });
        }
    }
    // Export assignments: export default x
    for (const assignment of sourceFile.getExportAssignments()) {
        exports.push({
            name: 'default',
            type: 'variable',
            isDefault: true,
            line: assignment.getStartLineNumber(),
        });
    }
    // Exported functions
    for (const func of sourceFile.getFunctions()) {
        if (func.isExported()) {
            exports.push({
                name: func.getName() || 'default',
                type: 'function',
                isDefault: func.isDefaultExport(),
                signature: extractFunctionSignature(func),
                line: func.getStartLineNumber(),
            });
        }
    }
    // Exported classes
    for (const cls of sourceFile.getClasses()) {
        if (cls.isExported()) {
            exports.push({
                name: cls.getName() || 'default',
                type: 'class',
                isDefault: cls.isDefaultExport(),
                line: cls.getStartLineNumber(),
            });
        }
    }
    // Exported variables
    for (const stmt of sourceFile.getVariableStatements()) {
        if (stmt.isExported()) {
            for (const decl of stmt.getDeclarations()) {
                exports.push({
                    name: decl.getName(),
                    type: 'variable',
                    isDefault: false,
                    line: stmt.getStartLineNumber(),
                });
            }
        }
    }
    // Exported interfaces
    for (const iface of sourceFile.getInterfaces()) {
        if (iface.isExported()) {
            exports.push({
                name: iface.getName(),
                type: 'interface',
                isDefault: iface.isDefaultExport(),
                line: iface.getStartLineNumber(),
            });
        }
    }
    // Exported type aliases
    for (const typeAlias of sourceFile.getTypeAliases()) {
        if (typeAlias.isExported()) {
            exports.push({
                name: typeAlias.getName(),
                type: 'type',
                isDefault: typeAlias.isDefaultExport(),
                line: typeAlias.getStartLineNumber(),
            });
        }
    }
    // Exported enums
    for (const enumDecl of sourceFile.getEnums()) {
        if (enumDecl.isExported()) {
            exports.push({
                name: enumDecl.getName(),
                type: 'enum',
                isDefault: enumDecl.isDefaultExport(),
                line: enumDecl.getStartLineNumber(),
            });
        }
    }
    return exports;
}
function extractFunctionSignature(func) {
    const params = func.getParameters().map((p) => ({
        name: p.getName(),
        type: p.getType().getText() || 'any',
        optional: p.isOptional(),
        defaultValue: p.getInitializer()?.getText(),
    }));
    return {
        name: func.getName() || 'anonymous',
        params,
        returnType: func.getReturnType().getText() || 'void',
        isAsync: func.isAsync(),
    };
}
// ============================================================
// Enrichment Extractors
// ============================================================
function extractSymbolUsages(sourceFile) {
    const usages = [];
    sourceFile.forEachDescendant((node) => {
        if (!Node.isIdentifier(node))
            return;
        const parent = node.getParent();
        if (!parent)
            return;
        // Skip identifiers that are part of import/export declarations
        if (Node.isImportDeclaration(parent) ||
            Node.isImportSpecifier(parent) ||
            Node.isExportDeclaration(parent) ||
            Node.isExportSpecifier(parent) ||
            Node.isImportClause(parent) ||
            Node.isNamespaceImport(parent)) {
            return;
        }
        // Skip identifiers in declaration name position (function name, class name, variable name, etc.)
        if ((Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent) ||
            Node.isInterfaceDeclaration(parent) || Node.isTypeAliasDeclaration(parent) ||
            Node.isEnumDeclaration(parent)) &&
            parent.getNameNode() === node) {
            return;
        }
        // Skip variable declaration names (left side of const x = ...)
        if (Node.isVariableDeclaration(parent) && parent.getNameNode() === node) {
            return;
        }
        // Skip parameter names in function definitions
        if (Node.isParameterDeclaration(parent) && parent.getNameNode() === node) {
            return;
        }
        // Skip property names in object literal and property assignments
        if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) {
            return;
        }
        const name = node.getText();
        const line = node.getStartLineNumber();
        const lineStart = sourceFile.getFullText().lastIndexOf('\n', node.getStart()) + 1;
        const column = node.getStart() - lineStart;
        // Classify the usage type
        let type = 'reference';
        if (Node.isCallExpression(parent) && parent.getExpression() === node) {
            type = 'call';
        }
        else if (Node.isTypeReference(parent)) {
            type = 'type-reference';
        }
        else if ((Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent)) &&
            parent.getTagNameNode() === node) {
            type = 'jsx-component';
        }
        else if (Node.isPropertyAccessExpression(parent)) {
            type = 'property-access';
        }
        // Determine if this is a write (assignment target)
        let isWrite = false;
        if (Node.isBinaryExpression(parent)) {
            const operatorToken = parent.getOperatorToken().getKind();
            if (operatorToken === SyntaxKind.EqualsToken ||
                operatorToken === SyntaxKind.PlusEqualsToken ||
                operatorToken === SyntaxKind.MinusEqualsToken) {
                isWrite = parent.getLeft() === node;
            }
        }
        usages.push({ name, type, line, column, isWrite });
    });
    return usages;
}
function extractJSXElements(sourceFile) {
    const elements = [];
    sourceFile.forEachDescendant((node) => {
        if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) {
            return;
        }
        const tagName = node.getTagNameNode().getText();
        const isComponent = /^[A-Z]/.test(tagName);
        const line = node.getStartLineNumber();
        let hasChildren = false;
        if (Node.isJsxOpeningElement(node)) {
            const parentElement = node.getParent();
            if (Node.isJsxElement(parentElement)) {
                const children = parentElement.getJsxChildren();
                // Has children if there are non-whitespace children
                hasChildren = children.some((child) => {
                    if (Node.isJsxText(child)) {
                        return child.getText().trim().length > 0;
                    }
                    return true;
                });
            }
        }
        const props = [];
        for (const attr of node.getAttributes()) {
            if (Node.isJsxSpreadAttribute(attr)) {
                props.push({
                    name: '...',
                    hasValue: true,
                    isEventHandler: false,
                    valueType: 'spread',
                    line: attr.getStartLineNumber(),
                });
                continue;
            }
            if (Node.isJsxAttribute(attr)) {
                const propName = attr.getNameNode().getText();
                const initializer = attr.getInitializer();
                const hasValue = initializer !== undefined;
                const isEventHandler = /^on[A-Z]/.test(propName);
                let valueType = 'shorthand';
                if (initializer) {
                    if (Node.isJsxExpression(initializer)) {
                        valueType = 'expression';
                    }
                    else if (Node.isStringLiteral(initializer)) {
                        valueType = 'literal';
                    }
                }
                props.push({
                    name: propName,
                    hasValue,
                    isEventHandler,
                    valueType,
                    line: attr.getStartLineNumber(),
                });
            }
        }
        elements.push({ tagName, props, hasChildren, line, isComponent });
    });
    return elements;
}
function extractEnvReferences(sourceFile) {
    const refs = [];
    sourceFile.forEachDescendant((node) => {
        if (!Node.isPropertyAccessExpression(node))
            return;
        const text = node.getText();
        let accessPattern = null;
        let variable = null;
        // Match process.env.VARIABLE_NAME
        const processEnvMatch = text.match(/^process\.env\.(\w+)$/);
        if (processEnvMatch) {
            accessPattern = 'process.env';
            variable = processEnvMatch[1];
        }
        // Match import.meta.env.VARIABLE_NAME
        const importMetaMatch = text.match(/^import\.meta\.env\.(\w+)$/);
        if (importMetaMatch) {
            accessPattern = 'import.meta.env';
            variable = importMetaMatch[1];
        }
        if (!accessPattern || !variable)
            return;
        // Avoid double-counting: skip if parent is also a PropertyAccessExpression
        // that would match (e.g., process.env in process.env.X)
        const parent = node.getParent();
        // Check for default value: parent is BinaryExpression with || or ??
        let hasDefault = false;
        if (Node.isBinaryExpression(parent)) {
            const op = parent.getOperatorToken().getKind();
            if (op === SyntaxKind.BarBarToken ||
                op === SyntaxKind.QuestionQuestionToken) {
                hasDefault = parent.getLeft() === node;
            }
        }
        refs.push({
            variable,
            accessPattern,
            line: node.getStartLineNumber(),
            hasDefault,
        });
    });
    return refs;
}
function extractCallSites(sourceFile) {
    const sites = [];
    sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node))
            return;
        const expr = node.getExpression();
        const argCount = node.getArguments().length;
        const line = node.getStartLineNumber();
        let callee;
        let receiver;
        if (Node.isPropertyAccessExpression(expr)) {
            callee = expr.getName();
            receiver = expr.getExpression().getText();
        }
        else if (Node.isIdentifier(expr)) {
            callee = expr.getText();
        }
        else {
            // Dynamic call like fn()() — skip import keyword calls
            if (expr.getKind() === SyntaxKind.ImportKeyword)
                return;
            callee = expr.getText();
        }
        // isChained: the result of this call is used in a property access leading to another call
        // i.e., parent is PropertyAccessExpression and grandparent is CallExpression
        let isChained = false;
        const parent = node.getParent();
        if (Node.isPropertyAccessExpression(parent)) {
            const grandparent = parent.getParent();
            if (Node.isCallExpression(grandparent)) {
                isChained = true;
            }
        }
        sites.push({
            callee,
            arguments: argCount,
            line,
            isChained,
            receiver,
        });
    });
    return sites;
}
//# sourceMappingURL=parser.js.map