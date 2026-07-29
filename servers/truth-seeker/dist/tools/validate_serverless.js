import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
const execAsync = promisify(exec);
/**
 * Validates serverless functions (AWS Lambda, Vercel, Cloudflare Workers) without deployment.
 * Tests handlers directly by mocking platform-specific events and context.
 *
 * @param input - Configuration for serverless function testing
 * @returns Validation result with status code, body, headers, and validations
 */
export async function validateServerlessFunction(input) {
    const startTime = Date.now();
    const handlerExport = input.handlerExport || 'handler';
    const absolutePath = path.resolve(input.handlerPath);
    try {
        // Create temporary test script
        const tempScriptPath = path.join(process.cwd(), `.mcp-serverless-temp-${Date.now()}.mts`);
        const scriptContent = `
import handlerModule from '${absolutePath.replace(/\\/g, '\\\\')}';

const handler = handlerModule.${handlerExport} || handlerModule.default;
const event = ${JSON.stringify(input.event)};
const context = ${JSON.stringify(input.context || {})};

async function testHandler() {
  try {
    const result = await handler(event, context);
    console.log(JSON.stringify({
      success: true,
      result
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }));
  }
}

testHandler();
`;
        await fs.writeFile(tempScriptPath, scriptContent, 'utf-8');
        // Execute with timeout
        const timeout = input.timeout || 5000;
        const { stdout, stderr } = await execAsync(`npx tsx ${tempScriptPath}`, { timeout });
        // Clean up
        await fs.unlink(tempScriptPath).catch(() => { });
        const executionResult = JSON.parse(stdout.trim());
        const executionTime = Date.now() - startTime;
        if (!executionResult.success) {
            return {
                status: "error",
                platform: input.platform,
                message: executionResult.error,
                stack: executionResult.stack,
                hint: "Check handler path and function signature"
            };
        }
        const result = executionResult.result;
        // Platform-specific response parsing
        let statusCode;
        let body;
        let headers;
        switch (input.platform) {
            case "aws-lambda":
                statusCode = result.statusCode || 200;
                body = result.body ? JSON.parse(result.body) : result;
                headers = result.headers || {};
                break;
            case "vercel":
                statusCode = result.status || 200;
                body = result.body || result;
                headers = result.headers || {};
                break;
            case "cloudflare-workers":
                statusCode = result.status || 200;
                body = result.body || result;
                headers = result.headers || {};
                break;
            default:
                statusCode = 200;
                body = result;
                headers = {};
        }
        // Validation
        const validations = {};
        if (input.expectedStatusCode !== undefined) {
            validations.statusCode = {
                expected: input.expectedStatusCode,
                actual: statusCode,
                match: statusCode === input.expectedStatusCode
            };
        }
        if (input.expectedBody !== undefined) {
            validations.body = {
                expected: input.expectedBody,
                actual: body,
                match: JSON.stringify(body) === JSON.stringify(input.expectedBody)
            };
        }
        if (input.expectedHeaders) {
            validations.headers = {};
            for (const [key, expectedValue] of Object.entries(input.expectedHeaders)) {
                validations.headers[key] = {
                    expected: expectedValue,
                    actual: headers[key],
                    match: headers[key] === expectedValue
                };
            }
        }
        const allValid = Object.values(validations).every((v) => typeof v === 'object' && ('match' in v) ? v.match : true);
        return {
            status: allValid ? "success" : "error",
            platform: input.platform,
            executionTime,
            statusCode,
            body,
            headers,
            validations,
            summary: allValid
                ? `Serverless function executed successfully`
                : `Validation failed - check validations for details`
        };
    }
    catch (error) {
        return {
            status: "error",
            platform: input.platform,
            message: error instanceof Error ? error.message : String(error),
            hint: "Check handler path, ensure dependencies installed, verify function signature"
        };
    }
}
//# sourceMappingURL=validate_serverless.js.map