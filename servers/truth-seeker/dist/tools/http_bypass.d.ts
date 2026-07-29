/**
 * HTTP Bypass Utility
 *
 * Provides direct handler invocation to bypass the HTTP layer for testing/debugging.
 * Instead of making HTTP requests, this utility:
 * 1. Directly imports the route handler file
 * 2. Creates a mock Request object
 * 3. Invokes the handler function
 * 4. Captures the response
 *
 * Benefits:
 * - No HTTP server needed
 * - Faster execution
 * - No port conflicts
 * - Perfect for local development and testing
 * - Can test handlers before deployment
 */
export interface DirectInvocationOptions {
    handlerPath: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url?: string;
    body?: any;
    headers?: Record<string, string>;
    keepTempFiles?: boolean;
}
export interface DirectInvocationResult {
    status: number;
    headers: Record<string, string>;
    body: string | any;
    isStream: boolean;
}
/**
 * Directly invokes a route handler without HTTP layer
 */
export declare function invokeHandlerDirectly(options: DirectInvocationOptions): Promise<DirectInvocationResult>;
/**
 * Utility to check if a path is a handler file
 */
export declare function isHandlerPath(path: string): boolean;
/**
 * Extract HTTP method from handler file (if possible)
 */
export declare function detectHandlerMethods(handlerPath: string): Promise<string[]>;
