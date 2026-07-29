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
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
// ========================================
// MAIN FUNCTIONS
// ========================================
/**
 * Execute a function from a file with test data
 */
export async function executeFunction(pool, params) {
    const { functionPath, functionName, exportType = 'named', testInputs, dataSource, timeout = 5000, captureWarnings = true } = params;
    const results = [];
    let inputs = [];
    try {
        // 1. Get test inputs
        if (testInputs && testInputs.length > 0) {
            inputs = testInputs;
        }
        else if (dataSource) {
            inputs = await getDataFromSource(pool, dataSource);
        }
        else {
            return {
                status: 'error',
                executed: false,
                mode: 'execute_function',
                summary: 'No test inputs provided',
                error: 'Provide either testInputs or dataSource'
            };
        }
        if (inputs.length === 0) {
            return {
                status: 'error',
                executed: false,
                mode: 'execute_function',
                summary: 'No data to test with',
                error: 'Data source returned no rows'
            };
        }
        // 2. Resolve the function path
        const absolutePath = resolve(functionPath);
        // 3. Execute each input
        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            const result = await executeSingleFunction(absolutePath, functionName, exportType, input, timeout, captureWarnings);
            results.push({ index: i, input, ...result });
        }
        // 4. Analyze results
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const errorTypes = new Map();
        results.filter(r => !r.success && r.error).forEach(r => {
            const key = r.error.type || 'Unknown';
            errorTypes.set(key, (errorTypes.get(key) || 0) + 1);
        });
        const recommendations = [];
        if (errorTypes.has('TypeError')) {
            recommendations.push('Add null/undefined checks before property access');
            recommendations.push('Use optional chaining (?.) for potentially undefined values');
        }
        if (errorTypes.has('ReferenceError')) {
            recommendations.push('Check that all variables are defined before use');
        }
        return {
            status: failCount === 0 ? 'success' : successCount === 0 ? 'error' : 'partial',
            executed: true,
            mode: 'execute_function',
            summary: `Executed ${results.length} tests: ${successCount} passed, ${failCount} failed`,
            results,
            recommendations: recommendations.length > 0 ? recommendations : undefined
        };
    }
    catch (error) {
        return {
            status: 'error',
            executed: false,
            mode: 'execute_function',
            summary: 'Failed to execute function',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
/**
 * Execute a code snippet with injected variables
 */
export async function executeSnippet(params) {
    const { code, variables = {}, timeout = 5000 } = params;
    try {
        const result = await runCodeInSandbox(code, variables, timeout);
        if (result.success) {
            return {
                status: 'success',
                executed: true,
                mode: 'execute_snippet',
                summary: 'Code executed successfully',
                results: [{
                        index: 0,
                        input: variables,
                        success: true,
                        returnValue: result.returnValue,
                        executionTime: result.executionTime
                    }]
            };
        }
        else {
            return {
                status: 'error',
                executed: true,
                mode: 'execute_snippet',
                summary: `Runtime error: ${result.error?.message}`,
                results: [{
                        index: 0,
                        input: variables,
                        success: false,
                        error: result.error,
                        executionTime: result.executionTime
                    }],
                recommendations: generateRecommendations(result.error?.type)
            };
        }
    }
    catch (error) {
        return {
            status: 'error',
            executed: false,
            mode: 'execute_snippet',
            summary: 'Failed to execute snippet',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
/**
 * Execute and trace property accesses to find potential null/undefined issues
 */
export async function traceExecution(params) {
    const { functionPath, functionName, exportType = 'named', testInput, traceDepth = 3, timeout = 5000 } = params;
    try {
        const absolutePath = resolve(functionPath);
        const result = await executeWithTracing(absolutePath, functionName, exportType, testInput, traceDepth, timeout);
        return {
            status: result.success ? 'success' : 'error',
            executed: true,
            mode: 'trace_execution',
            summary: result.success
                ? 'Function executed successfully with tracing'
                : `Traced error: ${result.error?.message} at ${result.error?.propertyPath || 'unknown'}`,
            results: [{
                    index: 0,
                    input: testInput,
                    ...result
                }],
            recommendations: result.success ? undefined : generateRecommendations(result.error?.type)
        };
    }
    catch (error) {
        return {
            status: 'error',
            executed: false,
            mode: 'trace_execution',
            summary: 'Failed to trace execution',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
// ========================================
// BATCH FUNCTIONS
// ========================================
/**
 * Execute multiple functions with their test inputs in one batch operation
 */
export async function executeFunctionsBatch(pool, params) {
    const { functions, stopOnFirstError = false, timeout = 5000 } = params;
    const results = [];
    let passedFunctions = 0;
    let failedFunctions = 0;
    let totalPassedTests = 0;
    let totalFailedTests = 0;
    let totalTests = 0;
    const allRecommendations = new Set();
    for (const fnConfig of functions) {
        const label = fnConfig.label || `${fnConfig.functionName}@${fnConfig.functionPath}`;
        try {
            const fnResult = await executeFunction(pool, {
                functionPath: fnConfig.functionPath,
                functionName: fnConfig.functionName,
                exportType: fnConfig.exportType || 'named',
                testInputs: fnConfig.testInputs,
                timeout
            });
            const testsPassed = fnResult.results?.filter(r => r.success).length || 0;
            const testsFailed = (fnResult.results?.length || 0) - testsPassed;
            totalTests += fnResult.results?.length || 0;
            totalPassedTests += testsPassed;
            totalFailedTests += testsFailed;
            // Extract unique error types for summary
            const errorSummary = [];
            const seenErrors = new Set();
            fnResult.results?.filter(r => !r.success && r.error).forEach(r => {
                const errorKey = `${r.error.type}: ${r.error.message}`;
                if (!seenErrors.has(errorKey)) {
                    seenErrors.add(errorKey);
                    errorSummary.push(errorKey);
                }
            });
            results.push({
                label,
                functionPath: fnConfig.functionPath,
                functionName: fnConfig.functionName,
                status: fnResult.status,
                testsRun: fnResult.results?.length || 0,
                testsPassed,
                testsFailed,
                executionResults: fnResult.results || [],
                errorSummary: errorSummary.length > 0 ? errorSummary : undefined
            });
            if (fnResult.status === 'success') {
                passedFunctions++;
            }
            else {
                failedFunctions++;
                if (stopOnFirstError)
                    break;
            }
            // Collect recommendations
            fnResult.recommendations?.forEach(rec => allRecommendations.add(rec));
        }
        catch (error) {
            results.push({
                label,
                functionPath: fnConfig.functionPath,
                functionName: fnConfig.functionName,
                status: 'error',
                testsRun: 0,
                testsPassed: 0,
                testsFailed: fnConfig.testInputs.length,
                executionResults: [],
                errorSummary: [error instanceof Error ? error.message : String(error)]
            });
            totalTests += fnConfig.testInputs.length;
            totalFailedTests += fnConfig.testInputs.length;
            failedFunctions++;
            if (stopOnFirstError)
                break;
        }
    }
    // Determine overall status
    let status;
    if (failedFunctions === 0) {
        status = 'success';
    }
    else if (passedFunctions === 0) {
        status = 'error';
    }
    else {
        status = 'partial';
    }
    return {
        status,
        totalFunctions: functions.length,
        totalTests,
        passedFunctions,
        failedFunctions,
        passedTests: totalPassedTests,
        failedTests: totalFailedTests,
        results,
        summary: `Batch smoke test: ${functions.length} functions, ${totalTests} tests. ` +
            `Functions: ${passedFunctions}/${functions.length} passed. ` +
            `Tests: ${totalPassedTests}/${totalTests} passed, ${totalFailedTests} failed.`,
        aggregatedRecommendations: [...allRecommendations]
    };
}
// ========================================
// HELPER FUNCTIONS
// ========================================
async function getDataFromSource(pool, dataSource) {
    if (!dataSource)
        return [];
    switch (dataSource.type) {
        case 'db_query':
            if (!pool || !dataSource.query) {
                throw new Error('Database pool and query required for db_query source');
            }
            const result = await pool.query(dataSource.query);
            return result.rows;
        case 'mock':
            return dataSource.mockData || [];
        case 'file':
            if (!dataSource.filePath) {
                throw new Error('File path required for file source');
            }
            const content = readFileSync(resolve(dataSource.filePath), 'utf-8');
            return JSON.parse(content);
        default:
            return [];
    }
}
async function executeSingleFunction(absolutePath, functionName, exportType, input, timeout, captureWarnings) {
    const start = Date.now();
    // Create a temporary script that imports and runs the function
    const tempFile = `/tmp/smoke_test_${randomUUID()}.mjs`;
    // Determine if input should be spread as args or passed as single arg
    const inputIsArray = Array.isArray(input);
    const spreadArgs = inputIsArray && input.length > 0 && typeof input[0] !== 'object';
    const script = `
import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

const input = ${JSON.stringify(input)};
const result = { success: false, returnValue: null, error: null, warnings: [] };

// Capture console.warn
const originalWarn = console.warn;
console.warn = (...args) => {
    result.warnings.push(args.map(a => String(a)).join(' '));
    ${captureWarnings ? '' : 'originalWarn(...args);'}
};

try {
    const modulePath = pathToFileURL('${absolutePath.replace(/\\/g, '/')}').href;
    const mod = await import(modulePath);

    const fn = ${exportType === 'default' ? 'mod.default' : `mod.${functionName}`};

    if (typeof fn !== 'function') {
        throw new Error('Export is not a function: ' + typeof fn);
    }

    // Execute the function
    const returnValue = ${spreadArgs ? 'await fn(...input)' : 'await fn(input)'};

    result.success = true;
    result.returnValue = returnValue;
} catch (error) {
    result.success = false;
    result.error = {
        message: error.message,
        type: error.constructor.name,
        stack: error.stack
    };

    // Try to extract line number from stack
    if (error.stack) {
        const match = error.stack.match(/:(\d+):(\d+)/);
        if (match) {
            result.error.line = parseInt(match[1], 10);
            result.error.column = parseInt(match[2], 10);
        }
    }
}

console.warn = originalWarn;
writeFileSync('${tempFile}.result', JSON.stringify(result));
`;
    try {
        writeFileSync(tempFile, script);
        try {
            execSync(`node "${tempFile}"`, {
                timeout,
                stdio: 'pipe',
                encoding: 'utf-8'
            });
        }
        catch (execError) {
            // Even if exec fails, check if we got a result file
            // (the error might be from the tested function, not the runner)
        }
        // Read result
        let resultData;
        try {
            const resultContent = readFileSync(`${tempFile}.result`, 'utf-8');
            resultData = JSON.parse(resultContent);
        }
        catch {
            return {
                success: false,
                error: {
                    message: 'Failed to read execution result',
                    type: 'SandboxError'
                },
                executionTime: Date.now() - start
            };
        }
        return {
            success: resultData.success,
            returnValue: resultData.returnValue,
            error: resultData.error,
            executionTime: Date.now() - start,
            warnings: resultData.warnings?.length > 0 ? resultData.warnings : undefined
        };
    }
    finally {
        // Cleanup
        try {
            unlinkSync(tempFile);
        }
        catch { }
        try {
            unlinkSync(`${tempFile}.result`);
        }
        catch { }
    }
}
async function runCodeInSandbox(code, variables, timeout) {
    const start = Date.now();
    const tempFile = `/tmp/smoke_snippet_${randomUUID()}.mjs`;
    // Build variable declarations
    const varDeclarations = Object.entries(variables)
        .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
        .join('\n');
    const script = `
import { writeFileSync } from 'fs';

${varDeclarations}

const result = { success: false, returnValue: null, error: null };

try {
    const returnValue = await (async () => {
        ${code}
    })();

    result.success = true;
    result.returnValue = returnValue;
} catch (error) {
    result.success = false;
    result.error = {
        message: error.message,
        type: error.constructor.name,
        stack: error.stack
    };

    if (error.stack) {
        const match = error.stack.match(/:(\d+):(\d+)/);
        if (match) {
            result.error.line = parseInt(match[1], 10);
            result.error.column = parseInt(match[2], 10);
        }
    }
}

writeFileSync('${tempFile}.result', JSON.stringify(result));
`;
    try {
        writeFileSync(tempFile, script);
        try {
            execSync(`node "${tempFile}"`, {
                timeout,
                stdio: 'pipe',
                encoding: 'utf-8'
            });
        }
        catch { }
        let resultData;
        try {
            const resultContent = readFileSync(`${tempFile}.result`, 'utf-8');
            resultData = JSON.parse(resultContent);
        }
        catch {
            return {
                success: false,
                error: {
                    message: 'Failed to read execution result',
                    type: 'SandboxError'
                },
                executionTime: Date.now() - start
            };
        }
        return {
            success: resultData.success,
            returnValue: resultData.returnValue,
            error: resultData.error,
            executionTime: Date.now() - start
        };
    }
    finally {
        try {
            unlinkSync(tempFile);
        }
        catch { }
        try {
            unlinkSync(`${tempFile}.result`);
        }
        catch { }
    }
}
async function executeWithTracing(absolutePath, functionName, exportType, input, traceDepth, timeout) {
    const start = Date.now();
    const tempFile = `/tmp/smoke_trace_${randomUUID()}.mjs`;
    // Create a Proxy-based tracer
    const script = `
import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

const input = ${JSON.stringify(input)};
const result = { success: false, returnValue: null, error: null, accessPath: [] };

// Create a tracing proxy
function createTracingProxy(obj, path = '') {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj !== 'object') {
        return obj;
    }

    return new Proxy(obj, {
        get(target, prop) {
            const newPath = path ? path + '.' + String(prop) : String(prop);
            result.accessPath.push(newPath);

            const value = target[prop];

            if (value === null || value === undefined) {
                // Don't wrap null/undefined
                return value;
            }

            if (typeof value === 'object' && newPath.split('.').length < ${traceDepth}) {
                return createTracingProxy(value, newPath);
            }

            return value;
        }
    });
}

try {
    const modulePath = pathToFileURL('${absolutePath.replace(/\\/g, '/')}').href;
    const mod = await import(modulePath);

    const fn = ${exportType === 'default' ? 'mod.default' : `mod.${functionName}`};

    if (typeof fn !== 'function') {
        throw new Error('Export is not a function: ' + typeof fn);
    }

    // Wrap input in tracing proxy
    const tracedInput = createTracingProxy(input, 'input');

    const returnValue = await fn(tracedInput);

    result.success = true;
    result.returnValue = returnValue;
} catch (error) {
    result.success = false;
    result.error = {
        message: error.message,
        type: error.constructor.name,
        stack: error.stack,
        propertyPath: result.accessPath.length > 0 ? result.accessPath[result.accessPath.length - 1] : null
    };

    if (error.stack) {
        const match = error.stack.match(/:(\d+):(\d+)/);
        if (match) {
            result.error.line = parseInt(match[1], 10);
            result.error.column = parseInt(match[2], 10);
        }
    }
}

writeFileSync('${tempFile}.result', JSON.stringify(result));
`;
    try {
        writeFileSync(tempFile, script);
        try {
            execSync(`node "${tempFile}"`, {
                timeout,
                stdio: 'pipe',
                encoding: 'utf-8'
            });
        }
        catch { }
        let resultData;
        try {
            const resultContent = readFileSync(`${tempFile}.result`, 'utf-8');
            resultData = JSON.parse(resultContent);
        }
        catch {
            return {
                success: false,
                error: {
                    message: 'Failed to read trace result',
                    type: 'SandboxError'
                },
                executionTime: Date.now() - start
            };
        }
        return {
            success: resultData.success,
            returnValue: resultData.returnValue,
            error: resultData.error,
            executionTime: Date.now() - start
        };
    }
    finally {
        try {
            unlinkSync(tempFile);
        }
        catch { }
        try {
            unlinkSync(`${tempFile}.result`);
        }
        catch { }
    }
}
function generateRecommendations(errorType) {
    const recs = [];
    switch (errorType) {
        case 'TypeError':
            recs.push('Add null/undefined checks before accessing properties');
            recs.push('Use optional chaining (?.) for nested property access');
            recs.push('Use nullish coalescing (??) to provide default values');
            recs.push('Validate input data with Zod or similar before processing');
            break;
        case 'ReferenceError':
            recs.push('Ensure all variables are defined before use');
            recs.push('Check for typos in variable names');
            recs.push('Verify imports are correct');
            break;
        case 'SyntaxError':
            recs.push('Check for syntax errors in the code');
            recs.push('Ensure proper JSON formatting for data');
            break;
        case 'RangeError':
            recs.push('Check array indices are within bounds');
            recs.push('Verify recursive functions have proper base cases');
            break;
        default:
            recs.push('Review the error message and stack trace');
            recs.push('Add proper error handling with try/catch');
    }
    return recs;
}
//# sourceMappingURL=smoke_test_sandbox.js.map