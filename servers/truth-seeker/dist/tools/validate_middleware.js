import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
const execAsync = promisify(exec);
export async function validateMiddleware(input) {
    const startTime = Date.now();
    const middlewareExport = input.middlewareExport || "default";
    const absolutePath = path.resolve(input.middlewarePath);
    try {
        // Create temporary test script
        const tempScriptPath = path.join(process.cwd(), `.mcp-middleware-test-${Date.now()}.mts`);
        const importStatement = middlewareExport === "default"
            ? `import middleware from '${absolutePath.replace(/\\/g, '\\\\')}';`
            : `import { ${middlewareExport} as middleware } from '${absolutePath.replace(/\\/g, '\\\\')}';`;
        const scriptContent = `
${importStatement}

// Mock Next.js Request object
class MockRequest {
  method: string;
  url: string;
  headers: Map<string, string>;
  cookies: Map<string, string>;
  body: any;

  constructor(config: any) {
    this.method = config.method || 'GET';
    this.url = config.url || '/';
    this.headers = new Map(Object.entries(config.headers || {}));
    this.cookies = new Map(Object.entries(config.cookies || {}));
    this.body = config.body;
  }
}

async function testMiddleware() {
  try {
    const mockReq = new MockRequest(${JSON.stringify(input.request)});
    const result = await middleware(mockReq);

    console.log(JSON.stringify({
      success: true,
      result: {
        action: result?.action || 'allow',
        status: result?.status,
        headers: result?.headers ? Object.fromEntries(result.headers) : {},
        redirect: result?.redirect
      }
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }));
  }
}

testMiddleware();
`;
        await fs.writeFile(tempScriptPath, scriptContent, 'utf-8');
        // Execute
        const { stdout, stderr } = await execAsync(`npx tsx ${tempScriptPath}`);
        // Clean up
        await fs.unlink(tempScriptPath).catch(() => { });
        const testResult = JSON.parse(stdout.trim());
        const executionTime = Date.now() - startTime;
        if (!testResult.success) {
            return {
                status: "error",
                message: testResult.error,
                hint: "Check middleware path and ensure it exports a valid middleware function"
            };
        }
        const result = testResult.result;
        const validations = {};
        // Validate action
        validations.action = {
            expected: input.expectedAction,
            actual: result.action,
            match: result.action === input.expectedAction
        };
        // Validate status code
        if (input.expectedStatusCode !== undefined) {
            validations.statusCode = {
                expected: input.expectedStatusCode,
                actual: result.status,
                match: result.status === input.expectedStatusCode
            };
        }
        // Validate headers
        if (input.expectedHeaders) {
            validations.headers = {};
            for (const [key, expectedValue] of Object.entries(input.expectedHeaders)) {
                validations.headers[key] = {
                    expected: expectedValue,
                    actual: result.headers[key],
                    match: result.headers[key] === expectedValue
                };
            }
        }
        // Validate redirect
        if (input.expectedRedirect !== undefined) {
            validations.redirect = {
                expected: input.expectedRedirect,
                actual: result.redirect,
                match: result.redirect === input.expectedRedirect
            };
        }
        const allValid = Object.values(validations).every((v) => typeof v === 'object' && ('match' in v) ? v.match : true);
        return {
            status: allValid ? "success" : "error",
            executionTime,
            action: result.action,
            statusCode: result.status,
            headers: result.headers,
            redirect: result.redirect,
            validations,
            summary: allValid
                ? "Middleware behaved as expected"
                : "Middleware validation failed - check validations"
        };
    }
    catch (error) {
        return {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
            hint: "Check middleware path and request configuration"
        };
    }
}
//# sourceMappingURL=validate_middleware.js.map