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
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
/**
 * Directly invokes a route handler without HTTP layer
 */
export async function invokeHandlerDirectly(options) {
    const { handlerPath, method, url, body, headers, keepTempFiles } = options;
    const absoluteHandlerPath = resolve(handlerPath);
    const handlerUrl = pathToFileURL(absoluteHandlerPath).href;
    const scriptId = randomUUID();
    const tempScriptPath = resolve(tmpdir(), `mcp-http-bypass-${scriptId}.mts`);
    // Determine the handler export name based on HTTP method
    const handlerExport = method; // GET, POST, PUT, DELETE, PATCH
    // Generate script to invoke handler
    const scriptContent = `
        import { ${handlerExport} } from '${handlerUrl}';

        async function run() {
            try {
                // Create mock Request object
                const requestUrl = ${url ? `'${url}'` : "'http://localhost/api/test'"};
                const requestInit: RequestInit = {
                    method: '${method}',
                    ${body ? `body: JSON.stringify(${JSON.stringify(body)}),` : ''}
                    ${headers ? `headers: ${JSON.stringify(headers)},` : ''}
                };

                const req = new Request(requestUrl, requestInit);

                // Invoke handler
                const res = await ${handlerExport}(req);

                // Capture response
                const responseHeaders: Record<string, string> = {};
                res.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });

                // Check if response is a stream
                const contentType = res.headers.get('content-type') || '';
                const isStream = contentType.includes('text/event-stream') ||
                                 contentType.includes('text/plain; charset=utf-8');

                let responseBody: string | any = '';

                if (res.body) {
                    if (isStream) {
                        // Handle streaming response
                        const reader = res.body.getReader();
                        const decoder = new TextDecoder();

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            responseBody += decoder.decode(value);
                        }
                    } else {
                        // Handle regular response
                        responseBody = await res.text();

                        // Try to parse as JSON
                        try {
                            responseBody = JSON.parse(responseBody);
                        } catch (e) {
                            // Keep as string if not JSON
                        }
                    }
                }

                // Output result as JSON
                const result = {
                    status: res.status,
                    headers: responseHeaders,
                    body: responseBody,
                    isStream
                };

                console.log('__MCP_RESULT_START__');
                console.log(JSON.stringify(result));
                console.log('__MCP_RESULT_END__');

            } catch (error: any) {
                console.error('__MCP_ERROR_START__');
                console.error(JSON.stringify({
                    error: error.message,
                    stack: error.stack,
                    name: error.name
                }));
                console.error('__MCP_ERROR_END__');
                process.exit(1);
            }
        }

        run();
    `;
    writeFileSync(tempScriptPath, scriptContent);
    try {
        // Execute script using ts-node
        const compilerOptions = {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            esModuleInterop: true
        };
        const output = execSync(`npx ts-node --skip-project --transpile-only "${tempScriptPath}"`, {
            encoding: 'utf-8',
            env: {
                ...process.env,
                TS_NODE_COMPILER_OPTIONS: JSON.stringify(compilerOptions)
            },
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large responses
            // Note: execSync uses shell by default, quotes handle spaces cross-platform
        });
        // Parse result from output
        const resultMatch = output.match(/__MCP_RESULT_START__([\s\S]*?)__MCP_RESULT_END__/);
        if (!resultMatch) {
            throw new Error('Failed to parse handler response from script output');
        }
        const result = JSON.parse(resultMatch[1].trim());
        return result;
    }
    catch (execError) {
        // Check if error output contains our custom error format
        const errorOutput = execError.stderr || execError.stdout || execError.message;
        const errorMatch = errorOutput.match(/__MCP_ERROR_START__([\s\S]*?)__MCP_ERROR_END__/);
        if (errorMatch) {
            const errorData = JSON.parse(errorMatch[1].trim());
            throw new Error(`Handler execution failed: ${errorData.error}\n${errorData.stack}`);
        }
        throw new Error(`Script execution failed: ${execError.message}\nStderr: ${execError.stderr}`);
    }
    finally {
        if (!keepTempFiles && process.env.KEEP_TEMP_SCRIPTS !== 'true') {
            try {
                unlinkSync(tempScriptPath);
            }
            catch (e) {
                // Ignore cleanup errors
            }
        }
    }
}
/**
 * Utility to check if a path is a handler file
 */
export function isHandlerPath(path) {
    return path.endsWith('route.ts') ||
        path.endsWith('route.js') ||
        path.endsWith('route.tsx') ||
        path.endsWith('route.jsx') ||
        path.includes('/api/');
}
/**
 * Extract HTTP method from handler file (if possible)
 */
export async function detectHandlerMethods(handlerPath) {
    try {
        const { readFileSync } = await import('fs');
        const content = readFileSync(resolve(handlerPath), 'utf-8');
        const methods = [];
        const exportPatterns = [
            /export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)/g,
            /export\s+(const|let)\s+(GET|POST|PUT|DELETE|PATCH)\s*=/g,
        ];
        for (const pattern of exportPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const method = match[2];
                if (!methods.includes(method)) {
                    methods.push(method);
                }
            }
        }
        return methods;
    }
    catch (e) {
        return [];
    }
}
//# sourceMappingURL=http_bypass.js.map