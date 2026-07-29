import { z } from 'zod';
export declare const validateAgentConversationSchema: z.ZodObject<{
    url: z.ZodOptional<z.ZodString>;
    handlerPath: z.ZodOptional<z.ZodString>;
    protocol: z.ZodDefault<z.ZodEnum<["vercel-ai-sdk-data-stream"]>>;
    conversation: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<["user", "assistant"]>;
        content: z.ZodString;
        expect: z.ZodOptional<z.ZodObject<{
            toolCall: z.ZodOptional<z.ZodString>;
            toolArgs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
            dbVerification: z.ZodOptional<z.ZodObject<{
                table: z.ZodString;
                condition: z.ZodRecord<z.ZodString, z.ZodAny>;
            }, "strip", z.ZodTypeAny, {
                table: string;
                condition: Record<string, any>;
            }, {
                table: string;
                condition: Record<string, any>;
            }>>;
        }, "strip", z.ZodTypeAny, {
            toolCall?: string | undefined;
            toolArgs?: Record<string, any> | undefined;
            dbVerification?: {
                table: string;
                condition: Record<string, any>;
            } | undefined;
        }, {
            toolCall?: string | undefined;
            toolArgs?: Record<string, any> | undefined;
            dbVerification?: {
                table: string;
                condition: Record<string, any>;
            } | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        content: string;
        role: "user" | "assistant";
        expect?: {
            toolCall?: string | undefined;
            toolArgs?: Record<string, any> | undefined;
            dbVerification?: {
                table: string;
                condition: Record<string, any>;
            } | undefined;
        } | undefined;
    }, {
        content: string;
        role: "user" | "assistant";
        expect?: {
            toolCall?: string | undefined;
            toolArgs?: Record<string, any> | undefined;
            dbVerification?: {
                table: string;
                condition: Record<string, any>;
            } | undefined;
        } | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    protocol: "vercel-ai-sdk-data-stream";
    conversation: {
        content: string;
        role: "user" | "assistant";
        expect?: {
            toolCall?: string | undefined;
            toolArgs?: Record<string, any> | undefined;
            dbVerification?: {
                table: string;
                condition: Record<string, any>;
            } | undefined;
        } | undefined;
    }[];
    url?: string | undefined;
    handlerPath?: string | undefined;
}, {
    conversation: {
        content: string;
        role: "user" | "assistant";
        expect?: {
            toolCall?: string | undefined;
            toolArgs?: Record<string, any> | undefined;
            dbVerification?: {
                table: string;
                condition: Record<string, any>;
            } | undefined;
        } | undefined;
    }[];
    url?: string | undefined;
    handlerPath?: string | undefined;
    protocol?: "vercel-ai-sdk-data-stream" | undefined;
}>;
export declare function validateAgentConversation(args: z.infer<typeof validateAgentConversationSchema>): Promise<{
    summary: string;
    results: any[];
}>;
