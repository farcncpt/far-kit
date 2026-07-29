import { z } from "zod";
export declare const validateToolUsageSchema: z.ZodObject<{
    filePath: z.ZodString;
    projectRoot: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    filePath: string;
    projectRoot?: string | undefined;
}, {
    filePath: string;
    projectRoot?: string | undefined;
}>;
export declare function validateToolUsage(args: z.infer<typeof validateToolUsageSchema>): Promise<{
    status: string;
    message: string;
    valid?: undefined;
    issues?: undefined;
    summary?: undefined;
} | {
    status: string;
    valid: boolean;
    issues: any[];
    summary: string;
    message?: undefined;
}>;
