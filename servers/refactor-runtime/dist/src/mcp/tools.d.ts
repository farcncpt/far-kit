import type { MoveManifest, MoveOperation, ImpactReport } from '../core/types.js';
export declare function refactorScan(params: {
    projectRoot: string;
}): Promise<{
    stats: import("../core/types.js").ScanStats;
    files: {
        path: string;
        language: "typescript" | "javascript" | "css";
        imports: number;
        exports: number;
    }[];
}>;
export declare function refactorMove(params: {
    oldPath: string;
    newPath: string;
    dryRun?: boolean;
}): Promise<{
    type: "folder";
    oldDir: string;
    newDir: string;
    filesMoved: number;
    totalFilesUpdated: number;
    routeChanges: import("../core/types.js").RouteChange[];
    results: {
        operation: MoveOperation;
        affectedFiles: import("../core/types.js").AffectedFile[];
        routeChanges: import("../core/types.js").RouteChange[];
        totalFilesUpdated: number;
    }[];
    dryRun: boolean;
    auditId: string | undefined;
    operation?: undefined;
    affectedFiles?: undefined;
} | {
    type: "file";
    operation: MoveOperation;
    affectedFiles: import("../core/types.js").AffectedFile[];
    routeChanges: import("../core/types.js").RouteChange[];
    totalFilesUpdated: number;
    dryRun: boolean;
    auditId: string | undefined;
    oldDir?: undefined;
    newDir?: undefined;
    filesMoved?: undefined;
    results?: undefined;
}>;
export declare function refactorMoveBulk(params: {
    manifest: MoveManifest;
}): Promise<{
    results: {
        operation: MoveOperation;
        affectedFiles: number;
        routeChanges: import("../core/types.js").RouteChange[];
        totalFilesUpdated: number;
    }[];
    dryRun: boolean;
    auditId: string | undefined;
}>;
export declare function refactorAnalyzeImpact(params: {
    file: string;
    sinceCommit?: string;
}): Promise<{
    reports: ImpactReport[];
}>;
export declare function refactorAutoFix(params: {
    impactReport: ImpactReport;
    dryRun?: boolean;
}): Promise<{
    totalFixed: number;
    totalSkipped: number;
    fixed: {
        file: string;
        line: number;
        appliedFix: string;
    }[];
    remainingTasks: import("../core/types.js").TaskItem[];
    dryRun: boolean;
}>;
export declare function refactorDependencyGraph(params: {
    projectRoot: string;
    entryPoint?: string;
    maxDepth?: number;
}): Promise<{
    entryPoint: string;
    dependents: {
        file: string;
        depth: number;
    }[];
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
    circularDeps?: undefined;
    orphans?: undefined;
} | {
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
    circularDeps: string[][];
    orphans: string[];
    entryPoint?: undefined;
    dependents?: undefined;
}>;
export declare function refactorDryRun(params: {
    operations: MoveOperation[];
}): Promise<{
    results: {
        operation: MoveOperation;
        affectedFiles: import("../core/types.js").AffectedFile[];
        routeChanges: import("../core/types.js").RouteChange[];
        totalFilesUpdated: number;
    }[];
    totalAffected: number;
}>;
export declare function refactorRollback(params: {
    auditLogId: string;
}): Promise<{
    auditId: string;
    totalActions: number;
    successful: number;
    failed: number;
}>;
export declare function refactorScanRoutes(params: {
    projectRoot: string;
}): Promise<{
    projectRoot: string;
    totalRoutes: number;
    routes: {
        file: string;
        route: string;
    }[];
}>;
export declare function refactorDelete(params: {
    file: string;
    dryRun?: boolean;
}): Promise<{
    targetFile: string;
    affectedFiles: {
        path: string;
        importsToRemove: {
            line: number;
            specifier: string;
            fullLineRemoval: boolean;
        }[];
    }[];
    reExportBreaks: {
        file: string;
        symbol: string;
        line: number;
    }[];
    totalImportsRemoved: number;
    dryRun: boolean;
}>;
export declare function refactorRename(params: {
    file: string;
    oldName: string;
    newName: string;
    dryRun?: boolean;
}): Promise<{
    oldName: string;
    newName: string;
    sourceFile: string;
    affectedFiles: {
        path: string;
        rewrites: {
            line: number;
            oldText: string;
            newText: string;
        }[];
    }[];
    dynamicAccessWarnings: {
        file: string;
        line: number;
        context: string;
    }[];
    totalRewrites: number;
    dryRun: boolean;
}>;
export declare function refactorDeadCode(params: {
    projectRoot: string;
    entryPoints?: string[];
}): Promise<{
    entryPoints: string[];
    reachableFiles: number;
    deadFiles: {
        path: string;
        confidence: "definite" | "possible" | "side-effect";
        reason: string;
        lineCount: number;
    }[];
    deadExports: {
        file: string;
        exportName: string;
        line: number;
        confidence: "definite" | "possible";
    }[];
    totalDeadLines: number;
}>;
export declare function refactorUIAudit(params: {
    projectRoot: string;
}): Promise<import("../core/types.js").UIAuditResult>;
export declare function refactorDepsAudit(params: {
    projectRoot: string;
}): Promise<import("../core/types.js").DepsAuditResult>;
export declare function refactorEnvAudit(params: {
    projectRoot: string;
    envFiles?: string[];
}): Promise<import("../core/types.js").EnvAuditResult>;
//# sourceMappingURL=tools.d.ts.map