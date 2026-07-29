interface ValidateErrorInput {
    url?: string;
    handlerPath?: string;
    method: string;
    invalidBody?: any;
    invalidHeaders?: Record<string, string>;
    invalidParams?: Record<string, string>;
    expectedError: {
        status: number;
        code?: string;
        message?: string;
        fields?: string[];
    };
}
export declare function validateAPIErrorHandling(input: ValidateErrorInput): Promise<any>;
export {};
