interface ValidateSSRInput {
    url?: string;
    pagePath?: string;
    layoutPath?: string;
    componentPath?: string;
    params?: Record<string, string>;
    searchParams?: Record<string, string>;
    expectedContent?: string[];
    expectedMetadata?: {
        title?: string;
        description?: string;
        openGraph?: Record<string, any>;
    };
    checkHydration?: boolean;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
}
/**
 * Validates server-side rendering by directly invoking Next.js pages or components.
 * Supports both HTTP requests and direct component invocation (bypass).
 *
 * @param input - Configuration for SSR validation
 * @returns Validation result with render time, content matches, and metadata validation
 */
export declare function validateSSRRendering(input: ValidateSSRInput): Promise<any>;
export {};
