import { z } from "zod";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
export const validateFunctionBehaviorSchema = z.object({
    filePath: z.string().describe("Path to file containing the function"),
    functionName: z.string().describe("Name of the function to test"),
    exportType: z.enum(["named", "default"]).default("named").describe("Export type (named or default)"),
    testCases: z.array(z.object({
        name: z.string().optional().describe("Optional test case name"),
        input: z.array(z.any()).describe("Array of function arguments"),
        expected: z.any().describe("Expected return value"),
        expectError: z.boolean().optional().describe("Set to true if expecting an error"),
        errorMessage: z.string().optional().describe("Expected error message substring")
    })).describe("Array of test cases to execute"),
    strictEquality: z.boolean().default(false).optional().describe("Use === instead of JSON.stringify comparison"),
    compareType: z.boolean().default(false).optional().describe("Compare types in addition to values"),
    timeout: z.number().default(5000).optional().describe("Execution timeout in milliseconds")
});
export async function validateFunctionBehavior(params) {
    const startTime = Date.now();
    const { filePath, functionName, exportType, testCases, timeout } = params;
    try {
        // Step 1: Validate input file exists
        const absolutePath = resolve(filePath);
        if (!existsSync(absolutePath)) {
            return {
                status: "error",
                message: `File not found: ${filePath}`,
                hint: "Ensure the file path is correct and the file exists"
            };
        }
        // Step 2: Generate temporary test script
        const tempScriptPath = generateTestScript(absolutePath, functionName, exportType, testCases);
        // Step 3: Execute script with timeout
        const result = executeTestScript(tempScriptPath, timeout || 5000);
        // Step 4: Cleanup
        cleanupTempFiles(tempScriptPath);
        // Step 5: Parse and format results
        const totalTime = Date.now() - startTime;
        const testResult = JSON.parse(result.stdout.trim());
        if (!testResult.success) {
            return {
                status: "error",
                message: testResult.error,
                stack: testResult.stack,
                hint: "Check function path, export type, and ensure function exists"
            };
        }
        const { results } = testResult;
        const passed = results.filter((r) => r.status === 'pass').length;
        const failed = results.filter((r) => r.status === 'fail').length;
        return {
            status: failed === 0 ? "success" : "error",
            totalTests: results.length,
            passed,
            failed,
            executionTime: totalTime,
            results,
            summary: failed === 0
                ? `All ${passed} test cases passed in ${totalTime}ms`
                : `${failed} of ${results.length} tests failed`
        };
    }
    catch (error) {
        return {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
            hint: "Check file path, function name, export type, and test cases"
        };
    }
}
function generateTestScript(absolutePath, functionName, exportType, testCases) {
    const scriptId = randomUUID();
    const tempScriptPath = resolve(tmpdir(), `mcp-function-test-${scriptId}.mts`);
    // Handle Windows path escaping (backslashes → double backslashes)
    const escapedPath = absolutePath.replace(/\\/g, '\\\\');
    // Generate import statement based on export type
    const importStatement = exportType === "default"
        ? `import testFunction from '${escapedPath}';`
        : `import { ${functionName} as testFunction } from '${escapedPath}';`;
    const scriptContent = `
${importStatement}

const testCases = ${JSON.stringify(testCases)};

async function runTests() {
    const results = [];

    for (const testCase of testCases) {
        const testStartTime = Date.now();

        try {
            const result = await testFunction(...testCase.input);
            const executionTime = Date.now() - testStartTime;

            if (testCase.expectError) {
                // Expected error but function succeeded
                results.push({
                    name: testCase.name || 'Unnamed Test',
                    status: 'fail',
                    input: testCase.input,
                    expected: 'Error',
                    actual: result,
                    message: 'Expected error but function succeeded',
                    executionTime
                });
            } else {
                // Normal success case - compare results
                const matches = JSON.stringify(result) === JSON.stringify(testCase.expected);
                results.push({
                    name: testCase.name || 'Unnamed Test',
                    status: matches ? 'pass' : 'fail',
                    input: testCase.input,
                    expected: testCase.expected,
                    actual: result,
                    executionTime
                });
            }
        } catch (error) {
            const executionTime = Date.now() - testStartTime;

            if (testCase.expectError) {
                // Expected error and got one - check message match
                const errorMatches = !testCase.errorMessage ||
                    error.message.includes(testCase.errorMessage);
                results.push({
                    name: testCase.name || 'Unnamed Test',
                    status: errorMatches ? 'pass' : 'fail',
                    input: testCase.input,
                    expected: testCase.errorMessage || 'Error',
                    actual: error.message,
                    executionTime
                });
            } else {
                // Unexpected error
                results.push({
                    name: testCase.name || 'Unnamed Test',
                    status: 'fail',
                    input: testCase.input,
                    expected: testCase.expected,
                    actual: 'Error: ' + error.message,
                    message: error.message,
                    executionTime
                });
            }
        }
    }

    console.log(JSON.stringify({ success: true, results }));
}

runTests().catch(error => {
    console.log(JSON.stringify({
        success: false,
        error: error.message,
        stack: error.stack
    }));
});
`;
    writeFileSync(tempScriptPath, scriptContent, 'utf-8');
    return tempScriptPath;
}
function executeTestScript(tempScriptPath, timeout) {
    try {
        const result = execSync(`npx tsx ${tempScriptPath}`, {
            timeout,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
        });
        return { stdout: result, stderr: '' };
    }
    catch (error) {
        // Handle timeout errors
        if (error.killed && error.signal === 'SIGTERM') {
            throw new Error(`Function execution timed out after ${timeout}ms`);
        }
        // Handle execution errors
        throw new Error(`Script execution failed: ${error.message}\nStderr: ${error.stderr}`);
    }
}
function cleanupTempFiles(tempScriptPath) {
    try {
        if (existsSync(tempScriptPath)) {
            unlinkSync(tempScriptPath);
        }
    }
    catch (error) {
        // Silently fail - cleanup is best-effort
        console.error(`Warning: Failed to cleanup temp file ${tempScriptPath}`);
    }
}
//# sourceMappingURL=validate_function_behavior.js.map