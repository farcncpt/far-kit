/**
 * validate_ai_chat - Dynamic AI Chat Infrastructure Validation Tool
 *
 * Based on Tribal Knowledge from multi-agent collaboration.
 * Validates AI chat infrastructure by checking database schema,
 * model IDs, message persistence, and optionally testing the API directly.
 *
 * DYNAMIC: Supports configurable table names, column mappings, and API providers.
 */
import { Pool } from 'pg';
export interface TableConfigColumns {
    convId?: string;
    convTitle?: string;
    convModel?: string;
    convCreatedAt?: string;
    convUserId?: string;
    msgId?: string;
    msgConversationId?: string;
    msgRole?: string;
    msgContent?: string;
    msgToolCalls?: string;
    msgToolResults?: string;
    msgCreatedAt?: string;
}
export interface TableConfig {
    conversationsTable?: string;
    messagesTable?: string;
    columns?: TableConfigColumns;
}
export interface ApiConfig {
    provider: 'anthropic' | 'openai' | 'google' | 'custom';
    endpoint?: string;
    apiKey?: string;
    authHeader?: string;
    authPrefix?: string;
    customModels?: string[];
}
export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: Record<string, any>;
}
export interface ContinueConversationConfig {
    conversationId: string;
    testMessage: string;
    maxTokens?: number;
    tools?: ToolDefinition[];
    systemPrompt?: string;
    executeToolCalls?: boolean;
    toolExecutor?: (toolName: string, toolInput: any) => Promise<any>;
    maxToolSteps?: number;
}
export interface DbMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls?: any[];
    toolResults?: any[];
}
export interface ToolCall {
    id: string;
    name: string;
    input: Record<string, any>;
}
export interface ConversationContinuationResult {
    success: boolean;
    conversationId: string;
    model: string;
    provider: string;
    messagesLoaded: number;
    testMessageSent: string;
    response?: {
        content: string;
        stopReason: string;
        toolCalls?: ToolCall[];
        toolResults?: any[];
        usage?: {
            inputTokens: number;
            outputTokens: number;
        };
    };
    multiStepExecution?: {
        steps: number;
        toolCallsExecuted: number;
        finalResponse: string;
    };
    responseTime: number;
    error?: string;
}
export interface ValidateAIChatParams {
    connectionString: string;
    tableConfig?: TableConfig;
    conversationId?: string;
    userId?: string;
    limit?: number;
    testApiCall?: boolean;
    apiConfig?: ApiConfig;
    validateSchema?: boolean;
    validateMessages?: boolean;
    checkToolPersistence?: boolean;
    continueConversation?: ContinueConversationConfig;
}
export interface ValidationIssue {
    type: 'schema_missing' | 'schema_mismatch' | 'invalid_model' | 'api_error' | 'persistence_issue' | 'warning';
    severity: 'critical' | 'error' | 'warning';
    message: string;
    details?: any;
    hint?: string;
}
export interface ConversationInfo {
    id: string;
    title: string;
    model: string;
    provider: string;
    modelValid: boolean;
    messageCount: number;
    hasToolCalls: boolean;
    hasToolResults: boolean;
    createdAt: string;
    userId?: string;
}
export interface ValidateAIChatResult {
    status: 'success' | 'error';
    valid: boolean;
    issues: ValidationIssue[];
    schema?: {
        conversationsTableExists: boolean;
        messagesTableExists: boolean;
        conversationsSchema?: Record<string, string>;
        messagesSchema?: Record<string, string>;
        schemaMismatches: string[];
    };
    conversations?: ConversationInfo[];
    apiTest?: {
        tested: boolean;
        success: boolean;
        provider: string;
        model: string;
        endpoint: string;
        responseTime?: number;
        error?: string;
    };
    continuationResult?: ConversationContinuationResult;
    summary: string;
    hint?: string;
}
export declare function validateAIChat(pool: Pool, params: ValidateAIChatParams): Promise<ValidateAIChatResult>;
