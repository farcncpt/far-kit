export interface FileInfo {
    path: string;
    relativePath: string;
    imports: ImportInfo[];
    exports: ExportInfo[];
    language: 'typescript' | 'javascript' | 'css';
    symbolUsages?: SymbolUsage[];
    jsxElements?: JSXElementInfo[];
    envReferences?: EnvReference[];
    callSites?: CallSiteInfo[];
}
export interface ImportInfo {
    source: string;
    resolvedPath: string;
    specifiers: ImportSpecifier[];
    type: 'static' | 'dynamic' | 'require' | 'css';
    isTypeOnly: boolean;
    line: number;
    column: number;
}
export interface ImportSpecifier {
    name: string;
    alias?: string;
    isDefault: boolean;
    isNamespace: boolean;
}
export interface ExportInfo {
    name: string;
    type: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 're-export';
    isDefault: boolean;
    signature?: FunctionSignature;
    reExportSource?: string;
    line: number;
}
export interface FunctionSignature {
    name: string;
    params: ParamInfo[];
    returnType: string;
    isAsync: boolean;
}
export interface ParamInfo {
    name: string;
    type: string;
    optional: boolean;
    defaultValue?: string;
}
export interface DependencyGraph {
    nodes: Map<string, FileInfo>;
    edges: Map<string, Set<string>>;
    reverseEdges: Map<string, Set<string>>;
    projectRoot: string;
}
export interface MoveOperation {
    oldPath: string;
    newPath: string;
    timestamp: string;
}
export interface MoveManifest {
    moves: MoveOperation[];
    projectRoot: string;
    dryRun: boolean;
}
export interface MoveResult {
    operation: MoveOperation;
    affectedFiles: AffectedFile[];
    routeChanges: RouteChange[];
    totalFilesUpdated: number;
}
export interface RouteChange {
    file: string;
    line: number;
    oldRoute: string;
    newRoute: string;
    context: string;
    applied: boolean;
}
export interface AffectedFile {
    path: string;
    oldImport: string;
    newImport: string;
    line: number;
    applied: boolean;
}
export interface FolderMoveResult {
    oldDir: string;
    newDir: string;
    filesMoved: number;
    operations: MoveOperation[];
    results: MoveResult[];
    routeChanges: RouteChange[];
    totalFilesUpdated: number;
}
export interface ChangeInfo {
    file: string;
    entity: string;
    changeType: ChangeType;
    oldSignature?: string;
    newSignature?: string;
}
export type ChangeType = 'param_added_required' | 'param_added_optional' | 'param_removed' | 'param_type_changed' | 'return_type_changed' | 'return_type_widened' | 'return_type_narrowed' | 'renamed' | 'removed' | 'interface_field_added' | 'interface_field_removed' | 'interface_field_changed';
export interface CascadeEffect {
    file: string;
    line: number;
    depth: number;
    classification: Classification;
    description: string;
    callingCode: string;
    suggestedFix?: string;
    autoFixable: boolean;
}
export type Classification = 'mechanical_auto' | 'mechanical_confirm' | 'logic_simple' | 'logic_complex' | 'architectural';
export interface ImpactReport {
    change: ChangeInfo;
    effects: CascadeEffect[];
    autoFixed: number;
    needsReview: number;
    tasks: TaskItem[];
}
export interface TaskItem {
    id: string;
    file: string;
    line: number;
    severity: 'critical' | 'high' | 'medium' | 'low';
    classification: Classification;
    description: string;
    context: {
        changedEntity: string;
        changeType: ChangeType;
        callingCode: string;
        suggestedApproach: string;
    };
    cascadeDepth: number;
}
export interface AuditEntry {
    timestamp: string;
    operation: 'move' | 'rewrite' | 'auto-fix';
    file: string;
    oldContent: string;
    newContent: string;
    line: number;
    rollbackable: boolean;
}
export interface AuditLog {
    id: string;
    entries: AuditEntry[];
    projectRoot: string;
    createdAt: string;
}
export interface ProjectConfig {
    projectRoot: string;
    tsConfigPath?: string;
    pathAliases: Record<string, string[]>;
    include: string[];
    exclude: string[];
}
export interface ScanResult {
    files: FileInfo[];
    stats: ScanStats;
}
export interface ScanStats {
    totalFiles: number;
    byLanguage: Record<string, number>;
    totalImports: number;
    totalExports: number;
}
export interface AnalysisResult {
    graph: DependencyGraph;
    circularDeps: string[][];
    orphans: string[];
    stats: {
        totalNodes: number;
        totalEdges: number;
        avgDependencies: number;
        maxDependencies: {
            file: string;
            count: number;
        };
        maxDependents: {
            file: string;
            count: number;
        };
    };
}
export interface SymbolUsage {
    name: string;
    type: 'reference' | 'call' | 'type-reference' | 'jsx-component' | 'property-access';
    line: number;
    column: number;
    isWrite: boolean;
}
export interface JSXElementInfo {
    tagName: string;
    props: JSXPropInfo[];
    hasChildren: boolean;
    line: number;
    isComponent: boolean;
}
export interface JSXPropInfo {
    name: string;
    hasValue: boolean;
    isEventHandler: boolean;
    valueType: 'expression' | 'literal' | 'spread' | 'shorthand';
    line: number;
}
export interface EnvReference {
    variable: string;
    accessPattern: 'process.env' | 'import.meta.env' | 'Deno.env' | 'dotenv';
    line: number;
    hasDefault: boolean;
}
export interface CallSiteInfo {
    callee: string;
    arguments: number;
    line: number;
    isChained: boolean;
    receiver?: string;
}
export interface DeleteResult {
    targetFile: string;
    affectedFiles: DeleteAffectedFile[];
    reExportBreaks: {
        file: string;
        symbol: string;
        line: number;
    }[];
    totalImportsRemoved: number;
    tasks: TaskItem[];
}
export interface DeleteAffectedFile {
    path: string;
    importsToRemove: {
        line: number;
        specifier: string;
        fullLineRemoval: boolean;
    }[];
    applied: boolean;
}
export interface RenameResult {
    oldName: string;
    newName: string;
    sourceFile: string;
    affectedFiles: RenameAffectedFile[];
    dynamicAccessWarnings: {
        file: string;
        line: number;
        context: string;
    }[];
    totalRewrites: number;
    tasks: TaskItem[];
}
export interface RenameAffectedFile {
    path: string;
    rewrites: {
        line: number;
        oldText: string;
        newText: string;
    }[];
    applied: boolean;
}
export interface DeadCodeResult {
    entryPoints: string[];
    reachableFiles: number;
    deadFiles: DeadFileInfo[];
    deadExports: DeadExportInfo[];
    totalDeadLines: number;
}
export interface DeadFileInfo {
    path: string;
    confidence: 'definite' | 'possible' | 'side-effect';
    reason: string;
    lineCount: number;
}
export interface DeadExportInfo {
    file: string;
    exportName: string;
    line: number;
    confidence: 'definite' | 'possible';
}
export interface UIAuditResult {
    totalComponentsScanned: number;
    findings: UIAuditFinding[];
    summary: {
        missingHandlers: number;
        unconnectedHandlers: number;
        unusedState: number;
        missingKeys: number;
        deadComponents: number;
    };
}
export interface UIAuditFinding {
    type: 'missing_handler' | 'unconnected_handler' | 'unused_state' | 'missing_key' | 'dead_component';
    file: string;
    line: number;
    component: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    autoFixable: boolean;
    suggestedFix?: string;
}
export interface DepsAuditResult {
    unusedDeps: {
        name: string;
        isDev: boolean;
    }[];
    undeclaredDeps: {
        name: string;
        usedIn: string[];
    }[];
    duplicateImports: {
        module: string;
        paths: string[];
        files: string[];
    }[];
    totalDeclared: number;
    totalUsed: number;
}
export interface EnvAuditResult {
    staleVars: {
        name: string;
        declaredIn: string[];
    }[];
    missingVars: {
        name: string;
        usedIn: {
            file: string;
            line: number;
        }[];
    }[];
    noDefaultVars: {
        name: string;
        usedIn: {
            file: string;
            line: number;
        }[];
    }[];
    inconsistentVars: {
        name: string;
        presentIn: string[];
        missingFrom: string[];
    }[];
    totalDeclared: number;
    totalReferenced: number;
}
//# sourceMappingURL=types.d.ts.map