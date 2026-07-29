import { z } from "zod";
export declare const validateTypeScriptSchema: z.ZodObject<{
    projectRoot: z.ZodString;
    fix: z.ZodDefault<z.ZodBoolean>;
    include: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    timeout: z.ZodDefault<z.ZodNumber>;
    simulateCI: z.ZodDefault<z.ZodBoolean>;
    regenerate: z.ZodDefault<z.ZodBoolean>;
    cleanPaths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    projectRoot: string;
    fix: boolean;
    timeout: number;
    simulateCI: boolean;
    regenerate: boolean;
    include?: string[] | undefined;
    cleanPaths?: string[] | undefined;
}, {
    projectRoot: string;
    fix?: boolean | undefined;
    include?: string[] | undefined;
    timeout?: number | undefined;
    simulateCI?: boolean | undefined;
    regenerate?: boolean | undefined;
    cleanPaths?: string[] | undefined;
}>;
export type ValidateTypeScriptParams = z.infer<typeof validateTypeScriptSchema>;
interface TSError {
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
    severity: "error" | "warning";
    category: string;
    fixable: boolean;
    suggestedFix?: {
        description: string;
        replacement?: string;
        lineContent?: string;
    };
}
export declare function validateTypeScript(params: ValidateTypeScriptParams): Promise<{
    status: string;
    message: string;
    hint: string;
    valid?: undefined;
    duration?: undefined;
    ciSimulation?: undefined;
    summary?: undefined;
    errors?: undefined;
    truncated?: undefined;
    fixes?: undefined;
} | {
    status: string;
    valid: boolean;
    duration: string;
    ciSimulation: {
        enabled: boolean;
        cleaned: string[];
        cleanErrors: string[];
        regenerated: {
            generators: string[];
            success: boolean;
            output: string;
        } | null;
    } | undefined;
    summary: {
        total: number;
        errors: number;
        warnings: number;
        fixable: number;
        byCategory: Record<string, number>;
        byFile: Record<string, number>;
    };
    errors: TSError[];
    truncated: boolean;
    fixes: {
        applied: number;
        failed: number;
        details: {
            file: string;
            line: number;
            description: string;
            success: boolean;
        }[];
    } | null;
    hint: string;
    message?: undefined;
}>;
export declare const validateTypeScriptBatchSchema: z.ZodObject<{
    projects: z.ZodArray<z.ZodObject<{
        projectRoot: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        projectRoot: string;
        name?: string | undefined;
    }, {
        projectRoot: string;
        name?: string | undefined;
    }>, "many">;
    fix: z.ZodDefault<z.ZodBoolean>;
    timeout: z.ZodDefault<z.ZodNumber>;
    stopOnFirstError: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    fix: boolean;
    timeout: number;
    projects: {
        projectRoot: string;
        name?: string | undefined;
    }[];
    stopOnFirstError: boolean;
}, {
    projects: {
        projectRoot: string;
        name?: string | undefined;
    }[];
    fix?: boolean | undefined;
    timeout?: number | undefined;
    stopOnFirstError?: boolean | undefined;
}>;
export type ValidateTypeScriptBatchParams = z.infer<typeof validateTypeScriptBatchSchema>;
export declare function validateTypeScriptBatch(params: ValidateTypeScriptBatchParams): Promise<{
    status: string;
    summary: {
        projectsChecked: number;
        projectsWithErrors: number;
        totalErrors: number;
        totalFixed: number;
    };
    results: {
        name: string;
        projectRoot: string;
        status: string;
        errorCount: number;
        duration: string;
    }[];
    hint: string;
}>;
export {};
