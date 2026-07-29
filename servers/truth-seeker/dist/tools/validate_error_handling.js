import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
const execAsync = promisify(exec);
export async function validateAPIErrorHandling(input) {
    const startTime = Date.now();
    // HTTP Mode
    if (input.url) {
        return await validateErrorHTTP(input);
    }
    // Direct Mode
    if (input.handlerPath) {
        return await validateErrorDirect(input);
    }
    throw new Error("Either 'url' or 'handlerPath' must be provided");
}
async function validateErrorHTTP(input) {
    const startTime = Date.now();
    try {
        const response = await fetch(input.url, {
            method: input.method,
            headers: {
                'Content-Type': 'application/json',
                ...input.invalidHeaders
            },
            body: input.invalidBody ? JSON.stringify(input.invalidBody) : undefined
        });
        const data = await response.json();
        const executionTime = Date.now() - startTime;
        return validateErrorResponse(data, response.status, input.expectedError, executionTime, "http");
    }
    catch (error) {
        return {
            status: "error",
            mode: "http",
            message: error instanceof Error ? error.message : String(error),
            hint: "Check URL and ensure server is running"
        };
    }
}
async function validateErrorDirect(input) {
    const startTime = Date.now();
    const absolutePath = path.resolve(input.handlerPath);
    try {
        // Create temporary test script
        const tempScriptPath = path.join(process.cwd(), `.mcp-error-test-${Date.now()}.mts`);
        const scriptContent = `
import handler from '${absolutePath.replace(/\\/g, '\\\\')}';

// Mock Next.js Request
class MockRequest {
  method = '${input.method}';
  json = async () => ${JSON.stringify(input.invalidBody || {})};
  headers = new Map(Object.entries(${JSON.stringify(input.invalidHeaders || {})}));
}

async function testError() {
  try {
    const mockReq = new MockRequest();
    const response = await handler.${input.method}(mockReq);

    const data = await response.json();

    console.log(JSON.stringify({
      success: true,
      status: response.status,
      data
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  }
}

testError();
`;
        await fs.writeFile(tempScriptPath, scriptContent, 'utf-8');
        const { stdout, stderr } = await execAsync(`npx tsx ${tempScriptPath}`);
        await fs.unlink(tempScriptPath).catch(() => { });
        const result = JSON.parse(stdout.trim());
        const executionTime = Date.now() - startTime;
        if (!result.success) {
            return {
                status: "error",
                mode: "direct",
                message: result.error,
                hint: "Check handler path and method"
            };
        }
        return validateErrorResponse(result.data, result.status, input.expectedError, executionTime, "direct");
    }
    catch (error) {
        return {
            status: "error",
            mode: "direct",
            message: error instanceof Error ? error.message : String(error),
            hint: "Check handler path and ensure dependencies are installed"
        };
    }
}
function validateErrorResponse(data, actualStatus, expected, executionTime, mode) {
    const validations = {};
    // Validate status code
    validations.statusCode = {
        expected: expected.status,
        actual: actualStatus,
        match: actualStatus === expected.status
    };
    // Validate error code
    if (expected.code) {
        validations.code = {
            expected: expected.code,
            actual: data.code,
            match: data.code === expected.code
        };
    }
    // Validate error message
    if (expected.message) {
        validations.message = {
            expected: expected.message,
            actual: data.message,
            match: data.message?.includes(expected.message)
        };
    }
    // Validate error fields
    if (expected.fields) {
        const actualFields = data.fields || data.errors?.map((e) => e.field) || [];
        validations.fields = {
            expected: expected.fields,
            actual: actualFields,
            match: expected.fields.every((f) => actualFields.includes(f))
        };
    }
    const allValid = Object.values(validations).every((v) => v.match);
    return {
        status: allValid ? "success" : "error",
        mode,
        executionTime,
        errorResponse: data,
        validations,
        summary: allValid
            ? "Error handling validated successfully"
            : "Error response doesn't match expectations"
    };
}
//# sourceMappingURL=validate_error_handling.js.map