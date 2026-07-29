import { z } from "zod";
export declare const preDeployAuditSchema: z.ZodObject<{
    projectRoot: z.ZodString;
    checks: z.ZodDefault<z.ZodArray<z.ZodEnum<["typescript", "typescript-ci", "imports", "circular", "unused", "env", "suspense-boundaries"]>, "many">>;
    timeout: z.ZodDefault<z.ZodNumber>;
    failFast: z.ZodDefault<z.ZodBoolean>;
    parallel: z.ZodDefault<z.ZodBoolean>;
    verbose: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    projectRoot: string;
    verbose: boolean;
    timeout: number;
    checks: ("typescript-ci" | "imports" | "circular" | "suspense-boundaries" | "env" | "unused" | "typescript")[];
    failFast: boolean;
    parallel: boolean;
}, {
    projectRoot: string;
    verbose?: boolean | undefined;
    timeout?: number | undefined;
    checks?: ("typescript-ci" | "imports" | "circular" | "suspense-boundaries" | "env" | "unused" | "typescript")[] | undefined;
    failFast?: boolean | undefined;
    parallel?: boolean | undefined;
}>;
export type PreDeployAuditParams = z.infer<typeof preDeployAuditSchema>;
interface CheckResult {
    name: string;
    status: "pass" | "fail" | "warn" | "skip" | "error";
    duration: number;
    summary: string;
    errorCount: number;
    warningCount: number;
    errors?: any[];
    details?: any;
}
interface AuditResult {
    status: "pass" | "fail" | "error";
    projectRoot: string;
    timestamp: string;
    totalDuration: number;
    checks: CheckResult[];
    summary: {
        passed: number;
        failed: number;
        warnings: number;
        skipped: number;
        totalErrors: number;
        totalWarnings: number;
    };
    criticalIssues: string[];
    recommendations: string[];
    hint: string;
}
export declare function preDeployAudit(params: PreDeployAuditParams): Promise<AuditResult>;
export {};
