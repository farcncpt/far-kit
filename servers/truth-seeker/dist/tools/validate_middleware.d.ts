interface ValidateMiddlewareInput {
    middlewarePath: string;
    middlewareExport?: string;
    request: {
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        body?: any;
        cookies?: Record<string, string>;
    };
    expectedAction: "allow" | "deny" | "redirect" | "modify";
    expectedStatusCode?: number;
    expectedHeaders?: Record<string, string>;
    expectedRedirect?: string;
}
export declare function validateMiddleware(input: ValidateMiddlewareInput): Promise<any>;
export {};
