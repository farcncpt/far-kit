import { z } from "zod";
export declare const suspenseBoundaryCheckSchema: z.ZodObject<{
    projectRoot: z.ZodString;
    verbose: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    projectRoot: string;
    verbose: boolean;
}, {
    projectRoot: string;
    verbose?: boolean | undefined;
}>;
export type SuspenseBoundaryCheckParams = z.infer<typeof suspenseBoundaryCheckSchema>;
interface SuspenseIssue {
    file: string;
    line: number;
    hook: string;
    source: string;
    severity: "error" | "warning";
    message: string;
    suggestion: string;
}
interface CheckResult {
    status: "pass" | "fail" | "error";
    projectRoot: string;
    issues: SuspenseIssue[];
    layoutsChecked: number;
    summary: string;
    recommendation?: string;
}
export declare function suspenseBoundaryCheck(params: SuspenseBoundaryCheckParams): Promise<CheckResult>;
export {};
