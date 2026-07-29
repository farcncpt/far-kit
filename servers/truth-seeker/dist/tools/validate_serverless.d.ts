interface ValidateServerlessInput {
    handlerPath: string;
    handlerExport?: string;
    platform: "aws-lambda" | "vercel" | "cloudflare-workers" | "netlify";
    event: any;
    context?: any;
    expectedStatusCode?: number;
    expectedBody?: any;
    expectedHeaders?: Record<string, string>;
    timeout?: number;
}
/**
 * Validates serverless functions (AWS Lambda, Vercel, Cloudflare Workers) without deployment.
 * Tests handlers directly by mocking platform-specific events and context.
 *
 * @param input - Configuration for serverless function testing
 * @returns Validation result with status code, body, headers, and validations
 */
export declare function validateServerlessFunction(input: ValidateServerlessInput): Promise<any>;
export {};
