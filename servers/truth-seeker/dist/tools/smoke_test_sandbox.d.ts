/**
 * smoke_test_sandbox - Execute code in isolation to catch runtime errors
 *
 * Modes:
 * 1. execute_function: Load and run a function with test data
 * 2. execute_snippet: Run arbitrary code with injected variables
 * 3. trace_execution: Execute and trace every property access
 *
 * Catches runtime errors that static analysis misses by actually running the code.
 */
import { Pool } from 'pg';
export interface SmokeTestResult {
    status: 'success' | 'error' | 'partial';
    executed: boolean;
    mode: string;
    summary: string;
    results?: ExecutionResult[];
    error?: string;
    recommendations?: string[];
}
export interface ExecutionResult {
    index: number;
    input: any;
    success: boolean;
    returnValue?: any;
    error?: {
        message: string;
        type: string;
        line?: number;
        column?: number;
        stack?: string;
        propertyPath?: string;
    };
    executionTime: number;
    warnings?: string[];
}
export interface ExecuteFunctionParams {
    functionPath: string;
    functionName: string;
    exportType?: 'named' | 'default';
    testInputs?: any[];
    dataSource?: {
        type: 'db_query' | 'mock' | 'file';
        connectionString?: string;
        query?: string;
        mockData?: any[];
        filePath?: string;
    };
    timeout?: number;
    captureWarnings?: boolean;
}
export interface ExecuteSnippetParams {
    code: string;
    variables?: Record<string, any>;
    timeout?: number;
}
export interface TraceExecutionParams {
    functionPath: string;
    functionName: string;
    exportType?: 'named' | 'default';
    testInput: any;
    traceDepth?: number;
    timeout?: number;
}
export interface ExecuteFunctionsBatchParams {
    functions: Array<{
        functionPath: string;
        functionName: string;
        exportType?: 'named' | 'default';
        testInputs: any[];
        label?: string;
    }>;
    stopOnFirstError?: boolean;
    timeout?: number;
}
export interface BatchSmokeTestResult {
    status: 'success' | 'error' | 'partial';
    totalFunctions: number;
    totalTests: number;
    passedFunctions: number;
    failedFunctions: number;
    passedTests: number;
    failedTests: number;
    results: Array<{
        label: string;
        functionPath: string;
        functionName: string;
        status: 'success' | 'error' | 'partial';
        testsRun: number;
        testsPassed: number;
        testsFailed: number;
        executionResults: ExecutionResult[];
        errorSummary?: string[];
    }>;
    summary: string;
    aggregatedRecommendations: string[];
}
/**
 * Execute a function from a file with test data
 */
export declare function executeFunction(pool: Pool | null, params: ExecuteFunctionParams): Promise<SmokeTestResult>;
/**
 * Execute a code snippet with injected variables
 */
export declare function executeSnippet(params: ExecuteSnippetParams): Promise<SmokeTestResult>;
/**
 * Execute and trace property accesses to find potential null/undefined issues
 */
export declare function traceExecution(params: TraceExecutionParams): Promise<SmokeTestResult>;
/**
 * Execute multiple functions with their test inputs in one batch operation
 */
export declare function executeFunctionsBatch(pool: Pool | null, params: ExecuteFunctionsBatchParams): Promise<BatchSmokeTestResult>;
