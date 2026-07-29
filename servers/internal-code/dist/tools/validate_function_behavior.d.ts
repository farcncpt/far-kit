import { z } from "zod";
export declare const validateFunctionBehaviorSchema: z.ZodObject<{
    filePath: z.ZodString;
    functionName: z.ZodString;
    exportType: z.ZodDefault<z.ZodEnum<["named", "default"]>>;
    testCases: z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        input: z.ZodArray<z.ZodAny, "many">;
        expected: z.ZodAny;
        expectError: z.ZodOptional<z.ZodBoolean>;
        errorMessage: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        input: any[];
        expected?: any;
        name?: string | undefined;
        expectError?: boolean | undefined;
        errorMessage?: string | undefined;
    }, {
        input: any[];
        expected?: any;
        name?: string | undefined;
        expectError?: boolean | undefined;
        errorMessage?: string | undefined;
    }>, "many">;
    strictEquality: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    compareType: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    timeout: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    filePath: string;
    functionName: string;
    exportType: "default" | "named";
    testCases: {
        input: any[];
        expected?: any;
        name?: string | undefined;
        expectError?: boolean | undefined;
        errorMessage?: string | undefined;
    }[];
    timeout?: number | undefined;
    strictEquality?: boolean | undefined;
    compareType?: boolean | undefined;
}, {
    filePath: string;
    functionName: string;
    testCases: {
        input: any[];
        expected?: any;
        name?: string | undefined;
        expectError?: boolean | undefined;
        errorMessage?: string | undefined;
    }[];
    timeout?: number | undefined;
    exportType?: "default" | "named" | undefined;
    strictEquality?: boolean | undefined;
    compareType?: boolean | undefined;
}>;
export type ValidateFunctionBehaviorParams = z.infer<typeof validateFunctionBehaviorSchema>;
export declare function validateFunctionBehavior(params: ValidateFunctionBehaviorParams): Promise<{
    status: string;
    message: string;
    hint: string;
    stack?: undefined;
    totalTests?: undefined;
    passed?: undefined;
    failed?: undefined;
    executionTime?: undefined;
    results?: undefined;
    summary?: undefined;
} | {
    status: string;
    message: any;
    stack: any;
    hint: string;
    totalTests?: undefined;
    passed?: undefined;
    failed?: undefined;
    executionTime?: undefined;
    results?: undefined;
    summary?: undefined;
} | {
    status: string;
    totalTests: any;
    passed: any;
    failed: any;
    executionTime: number;
    results: any;
    summary: string;
    message?: undefined;
    hint?: undefined;
    stack?: undefined;
}>;
