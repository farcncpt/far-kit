import { z } from "zod";
export declare const inspectServerLogsSchema: z.ZodObject<{
    logFilePath: z.ZodString;
    lines: z.ZodDefault<z.ZodNumber>;
    filter: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    logFilePath: string;
    lines: number;
    filter?: string | undefined;
}, {
    logFilePath: string;
    filter?: string | undefined;
    lines?: number | undefined;
}>;
export declare function inspectServerLogs(args: z.infer<typeof inspectServerLogsSchema>): Promise<{
    status: string;
    message: string;
    hint: string;
    logs?: undefined;
    summary?: undefined;
    logFilePath?: undefined;
    lineCount?: undefined;
} | {
    status: string;
    logs: never[];
    summary: string;
    message?: undefined;
    hint?: undefined;
    logFilePath?: undefined;
    lineCount?: undefined;
} | {
    status: string;
    logFilePath: string;
    lineCount: number;
    logs: string[];
    summary: string;
    message?: undefined;
    hint?: undefined;
} | {
    status: string;
    message: string;
    hint?: undefined;
    logs?: undefined;
    summary?: undefined;
    logFilePath?: undefined;
    lineCount?: undefined;
}>;
