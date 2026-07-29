import { z } from "zod";
export declare const analyzeProjectChecksSchema: z.ZodObject<{
    projectRoot: z.ZodString;
    verbose: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    projectRoot: string;
    verbose: boolean;
}, {
    projectRoot: string;
    verbose?: boolean | undefined;
}>;
export type AnalyzeProjectChecksParams = z.infer<typeof analyzeProjectChecksSchema>;
interface FrameworkDetection {
    name: string;
    detected: boolean;
    version?: string;
    patterns: string[];
}
interface AuthDetection {
    name: string;
    detected: boolean;
    hasSSRBailout: boolean;
    hooks: string[];
}
interface RecommendedCheck {
    name: string;
    recommended: boolean;
    reason: string;
    priority: "required" | "recommended" | "optional";
    estimatedTime?: string;
}
interface AnalysisResult {
    status: "success" | "error";
    projectRoot: string;
    projectName?: string;
    frameworks: FrameworkDetection[];
    authLibraries: AuthDetection[];
    hasTypeScript: boolean;
    hasMonorepo: boolean;
    hasPrisma: boolean;
    recommendedChecks: RecommendedCheck[];
    summary: string;
    quickCommand?: string;
}
export declare function analyzeProjectChecks(params: AnalyzeProjectChecksParams): Promise<AnalysisResult>;
export {};
