/**
 * validate_runtime_types - Catches type errors that TypeScript misses
 *
 * Detects common runtime errors:
 * - .trim(), .toLowerCase(), etc. on undefined/null
 * - Property access on undefined objects
 * - Missing or wrong-type params/query strings
 * - Database rows with null where code expects values
 *
 * Works by:
 * 1. Analyzing code for dangerous patterns
 * 2. Validating actual data against expected shapes
 * 3. Simulating data flow to catch issues
 */
import { Pool } from 'pg';
export interface RuntimeTypeIssue {
    type: 'null_method_call' | 'undefined_access' | 'type_mismatch' | 'missing_param' | 'nullable_db_field';
    severity: 'critical' | 'error' | 'warning';
    location?: {
        file?: string;
        line?: number;
        column?: number;
        code?: string;
    };
    message: string;
    suggestion: string;
    example?: string;
}
export interface ValidateCodePatternsParams {
    code: string;
    filename?: string;
}
export interface ValidateDbRowParams {
    row: Record<string, any>;
    expectedShape: Record<string, {
        type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';
        nullable?: boolean;
        optional?: boolean;
    }>;
    context?: string;
}
export interface ValidateParamsParams {
    params: Record<string, any>;
    expectedParams: Record<string, {
        type: 'string' | 'number' | 'boolean' | 'uuid' | 'slug';
        required?: boolean;
    }>;
    source?: 'route' | 'query' | 'body';
}
export interface ValidateDataFlowParams {
    connectionString: string;
    tableName: string;
    query: string;
    expectedFields: Record<string, {
        type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';
        nullable?: boolean;
        usedAs?: string[];
    }>;
}
export interface ValidateCodePatternsBatchParams {
    files: Array<{
        path: string;
        code: string;
    }>;
    stopOnFirstError?: boolean;
}
export interface ValidateDbSchemaBatchParams {
    tables: Array<{
        tableName: string;
        expectedShape: Record<string, {
            type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date';
            nullable?: boolean;
            optional?: boolean;
        }>;
        query?: string;
    }>;
    connectionString?: string;
}
export interface BatchValidationResult {
    status: 'success' | 'error' | 'partial';
    totalFiles?: number;
    totalTables?: number;
    passedCount: number;
    failedCount: number;
    results: Array<{
        identifier: string;
        valid: boolean;
        issueCount: number;
        criticalCount: number;
        issues: RuntimeTypeIssue[];
    }>;
    summary: string;
    aggregatedRecommendations: string[];
}
export interface RuntimeTypeValidationResult {
    status: 'success' | 'error';
    valid: boolean;
    issues: RuntimeTypeIssue[];
    summary: string;
    recommendations?: string[];
}
/**
 * Analyze code for dangerous patterns that could cause runtime type errors
 */
export declare function validateCodePatterns(params: ValidateCodePatternsParams): RuntimeTypeValidationResult;
/**
 * Validate a database row against expected shape
 */
export declare function validateDbRow(params: ValidateDbRowParams): RuntimeTypeValidationResult;
/**
 * Validate params (route, query, body) against expected types
 */
export declare function validateParams(params: ValidateParamsParams): RuntimeTypeValidationResult;
/**
 * Validate data flow from database query to usage
 */
export declare function validateDataFlow(pool: Pool, params: ValidateDataFlowParams): Promise<RuntimeTypeValidationResult>;
/**
 * Validate multiple code files for dangerous patterns at once
 */
export declare function validateCodePatternsBatch(params: ValidateCodePatternsBatchParams): BatchValidationResult;
/**
 * Validate multiple database tables against expected schemas at once
 */
export declare function validateDbSchemaBatch(pool: Pool, params: ValidateDbSchemaBatchParams): Promise<BatchValidationResult>;
