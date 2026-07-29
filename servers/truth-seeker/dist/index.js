#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import axios from "axios";
import { getDbConnection } from "./db.js";
import { Client } from 'pg';
import { readFileSync } from "fs";
import { resolve } from "path";
import { getSuggestions } from "./utils.js";
import { validateAgentConversationSchema } from "./tools/validate_conversation.js";
// Lazy-loaded heavy dependencies (loaded on first use to speed up server startup)
let _Project = null;
let _projectCache = null;
let _glob = null;
let _Redis = null;
let _S3Client = null;
let _ListBucketsCommand = null;
// Lazy loaders
async function getProject() {
    if (!_Project) {
        const tsMorph = await import("ts-morph");
        _Project = tsMorph.Project;
    }
    return _Project;
}
async function getProjectCache() {
    if (!_projectCache) {
        const cache = await import("./cache.js");
        _projectCache = cache.projectCache;
    }
    return _projectCache;
}
async function getGlob() {
    if (!_glob) {
        const globModule = await import("glob");
        _glob = globModule.glob;
    }
    return _glob;
}
async function getRedis() {
    if (!_Redis) {
        const ioredis = await import("ioredis");
        _Redis = ioredis.default;
    }
    return _Redis;
}
async function getS3() {
    if (!_S3Client || !_ListBucketsCommand) {
        const s3 = await import("@aws-sdk/client-s3");
        _S3Client = s3.S3Client;
        _ListBucketsCommand = s3.ListBucketsCommand;
    }
    return { S3Client: _S3Client, ListBucketsCommand: _ListBucketsCommand };
}
// Lazy-loaded tool imports
let _validateAgentConversation = null;
let _validateAgentConversationSchema = null;
let _invokeHandlerDirectly = null;
let _validateMiddleware = null;
let _validateAPIErrorHandling = null;
let _validateSSRRendering = null;
let _validateServerlessFunction = null;
let _validateAIChat = null;
let _runtimeTypes = null;
let _smokeTestSandbox = null;
async function getValidateConversation() {
    if (!_validateAgentConversation) {
        const mod = await import("./tools/validate_conversation.js");
        _validateAgentConversation = mod.validateAgentConversation;
        _validateAgentConversationSchema = mod.validateAgentConversationSchema;
    }
    return { validateAgentConversation: _validateAgentConversation, validateAgentConversationSchema: _validateAgentConversationSchema };
}
async function getHttpBypass() {
    if (!_invokeHandlerDirectly) {
        const mod = await import("./tools/http_bypass.js");
        _invokeHandlerDirectly = mod.invokeHandlerDirectly;
    }
    return _invokeHandlerDirectly;
}
async function getValidateMiddleware() {
    if (!_validateMiddleware) {
        const mod = await import("./tools/validate_middleware.js");
        _validateMiddleware = mod.validateMiddleware;
    }
    return _validateMiddleware;
}
async function getValidateAPIErrorHandling() {
    if (!_validateAPIErrorHandling) {
        const mod = await import("./tools/validate_error_handling.js");
        _validateAPIErrorHandling = mod.validateAPIErrorHandling;
    }
    return _validateAPIErrorHandling;
}
async function getValidateSSRRendering() {
    if (!_validateSSRRendering) {
        const mod = await import("./tools/validate_ssr.js");
        _validateSSRRendering = mod.validateSSRRendering;
    }
    return _validateSSRRendering;
}
async function getValidateServerlessFunction() {
    if (!_validateServerlessFunction) {
        const mod = await import("./tools/validate_serverless.js");
        _validateServerlessFunction = mod.validateServerlessFunction;
    }
    return _validateServerlessFunction;
}
async function getValidateAIChat() {
    if (!_validateAIChat) {
        const mod = await import("./tools/validate_ai_chat.js");
        _validateAIChat = mod.validateAIChat;
    }
    return _validateAIChat;
}
async function getRuntimeTypes() {
    if (!_runtimeTypes) {
        _runtimeTypes = await import("./tools/validate_runtime_types.js");
    }
    return _runtimeTypes;
}
async function getSmokeTestSandbox() {
    if (!_smokeTestSandbox) {
        _smokeTestSandbox = await import("./tools/smoke_test_sandbox.js");
    }
    return _smokeTestSandbox;
}
// Initialize Server
const server = new Server({
    name: "truth-seeker-mcp",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Helper to format JSON response
const formatResponse = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: data.status === "error",
});
// --- Cross-Layer Validation Helpers ---
async function validateOrmModel(args) {
    const { modelFilePath, tableName, connectionString } = args;
    const pool = getDbConnection(connectionString);
    try {
        // 1. Get Actual DB Schema
        const dbResult = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = $1
        `, [tableName]);
        if (dbResult.rows.length === 0) {
            return {
                status: "error",
                message: `Table '${tableName}' does not exist in the database`,
                hint: "Check table name or run migrations"
            };
        }
        const dbColumns = new Map(dbResult.rows.map((row) => [row.column_name, row]));
        // 2. Parse ORM Model (TypeORM/Entity style)
        const fileDir = modelFilePath.substring(0, modelFilePath.lastIndexOf('/'));
        const Project = await getProject();
        const projectCache = await getProjectCache();
        let project = projectCache.get(fileDir);
        if (!project) {
            project = new Project({
                skipAddingFilesFromTsConfig: true,
            });
            projectCache.set(fileDir, project);
        }
        if (!project.getSourceFile(modelFilePath)) {
            project.addSourceFileAtPath(modelFilePath);
        }
        const sourceFile = project.getSourceFile(modelFilePath);
        if (!sourceFile) {
            return {
                status: "error",
                message: `Model file not found: ${modelFilePath}`,
                hint: "Check file path"
            };
        }
        // Find class that looks like an entity
        const classes = sourceFile.getClasses();
        let entityClass = classes.find((c) => c.getDecorators().some((d) => d.getName() === "Entity"));
        // Fallback: use first class if no @Entity decorator found (for flexibility)
        if (!entityClass && classes.length > 0) {
            entityClass = classes[0];
        }
        if (!entityClass) {
            return {
                status: "error",
                message: `No class found in ${modelFilePath}`,
                hint: "Ensure file contains a class definition"
            };
        }
        // 3. Compare
        const issues = [];
        const modelProperties = entityClass.getProperties();
        for (const prop of modelProperties) {
            const propName = prop.getName();
            // Simple heuristic: assume property name matches column name (or snake_case version)
            // Check exact match
            let dbCol = dbColumns.get(propName);
            // Check snake_case match (common convention)
            if (!dbCol) {
                const snakeName = propName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
                dbCol = dbColumns.get(snakeName);
            }
            if (!dbCol) {
                // Check if it has @JoinColumn or @OneToMany etc (relations often don't have direct columns)
                const isRelation = prop.getDecorators().some((d) => ["OneToOne", "OneToMany", "ManyToOne", "ManyToMany", "JoinColumn"].includes(d.getName()));
                if (!isRelation) {
                    issues.push({
                        type: "missing_column_in_db",
                        property: propName,
                        message: `Property '${propName}' exists in model but no matching column found in DB table '${tableName}'`,
                        hint: "Run migration to add column",
                        suggestions: getSuggestions(propName, Array.from(dbColumns.keys()))
                    });
                }
            }
        }
        // Check for extra columns in DB (that are not in model)
        const modelColumnNames = new Set(modelProperties.map((p) => p.getName()));
        modelProperties.forEach((p) => modelColumnNames.add(p.getName().replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)));
        for (const [colName, _] of dbColumns) {
            if (!modelColumnNames.has(colName)) {
                issues.push({
                    type: "extra_column_in_db",
                    column: colName,
                    message: `Column '${colName}' exists in DB but not in model`,
                    hint: "Update model to include this column"
                });
            }
        }
        return {
            status: issues.length > 0 ? "error" : "success",
            valid: issues.length === 0,
            tableName,
            modelName: entityClass.getName(),
            issues,
            summary: issues.length > 0
                ? `Found ${issues.length} discrepancies between model '${entityClass.getName()}' and table '${tableName}'`
                : `Model '${entityClass.getName()}' matches table '${tableName}'`,
            hint: issues.length > 0 ? "Sync model and database" : null
        };
    }
    catch (error) {
        return {
            status: "error",
            message: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
            hint: "Check database connection and file paths"
        };
    }
}
async function validateApiTypes(args) {
    const { typeFilePath, typeName, apiUrl, handlerPath, method, headers, body } = args;
    // Validation: need either apiUrl or handlerPath
    if (!apiUrl && !handlerPath) {
        return {
            status: "error",
            message: "Either 'apiUrl' or 'handlerPath' must be provided",
            hint: "Use 'apiUrl' for HTTP mode or 'handlerPath' for direct handler invocation (HTTP bypass)"
        };
    }
    try {
        // 1. Parse TypeScript Interface
        const fileDir = typeFilePath.substring(0, typeFilePath.lastIndexOf('/'));
        const Project = await getProject();
        const projectCache = await getProjectCache();
        let project = projectCache.get(fileDir);
        if (!project) {
            project = new Project({
                skipAddingFilesFromTsConfig: true,
            });
            projectCache.set(fileDir, project);
        }
        if (!project.getSourceFile(typeFilePath)) {
            project.addSourceFileAtPath(typeFilePath);
        }
        const sourceFile = project.getSourceFile(typeFilePath);
        if (!sourceFile) {
            return {
                status: "error",
                message: `Type file not found: ${typeFilePath}`,
                hint: "Check file path"
            };
        }
        const interfaceDecl = sourceFile.getInterface(typeName);
        if (!interfaceDecl) {
            return {
                status: "error",
                message: `Interface '${typeName}' not found in ${typeFilePath}`,
                hint: "Ensure interface is exported"
            };
        }
        // 2. Fetch API Response (HTTP or Direct Invocation)
        let apiData;
        let responseStatus;
        let mode;
        if (handlerPath) {
            // --- Direct Handler Invocation Mode (HTTP Bypass) ---
            mode = "direct";
            const invokeHandlerDirectly = await getHttpBypass();
            const result = await invokeHandlerDirectly({
                handlerPath,
                method: method.toUpperCase(),
                url: apiUrl,
                body,
                headers
            });
            responseStatus = result.status;
            apiData = result.body;
            // Parse JSON string if needed
            if (typeof apiData === 'string') {
                try {
                    apiData = JSON.parse(apiData);
                }
                catch (e) {
                    // Keep as string if not JSON
                }
            }
        }
        else {
            // --- HTTP Mode (Original) ---
            mode = "http";
            const response = await axios({
                method,
                url: apiUrl,
                headers,
                validateStatus: () => true,
            });
            responseStatus = response.status;
            apiData = response.data;
        }
        if (responseStatus >= 400) {
            return {
                status: "error",
                mode,
                message: `Response returned error status: ${responseStatus}`,
                hint: "Check URL/handler and credentials"
            };
        }
        // 3. Validate
        const issues = [];
        const properties = interfaceDecl.getProperties();
        // Check for missing fields in API response
        for (const prop of properties) {
            const propName = prop.getName();
            if (!(propName in apiData) && !prop.hasQuestionToken()) {
                issues.push({
                    type: "missing_field",
                    field: propName,
                    message: `Field '${propName}' is required by type '${typeName}' but missing in API response`,
                    suggestions: getSuggestions(propName, Object.keys(apiData))
                });
            }
        }
        // Check for extra fields in API response (optional, but good for strictness)
        const typeFields = new Set(properties.map((p) => p.getName()));
        for (const key of Object.keys(apiData)) {
            if (!typeFields.has(key)) {
                issues.push({
                    type: "extra_field",
                    field: key,
                    message: `Field '${key}' present in API response but not in type '${typeName}'`,
                    hint: "Add field to interface or ignore"
                });
            }
        }
        const source = handlerPath ? `handler ${handlerPath}` : apiUrl;
        return {
            status: issues.length > 0 ? "error" : "success",
            valid: issues.length === 0,
            mode,
            typeName,
            source: handlerPath || apiUrl,
            issues,
            summary: issues.length > 0
                ? `Found ${issues.length} discrepancies between type '${typeName}' and response from ${source}`
                : `Type '${typeName}' matches response from ${source}`,
        };
    }
    catch (error) {
        return {
            status: "error",
            message: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
// --- Tool Handlers ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "validate_schema_contract",
                description: "Validates that the database schema matches the expected contract.",
                inputSchema: zodToJsonSchema(z.object({
                    tableName: z.string(),
                    expectedSchema: z.record(z.string()),
                    connectionString: z.string().optional(),
                })),
            },
            {
                name: "simulate_webhook_event",
                description: "Simulates a webhook event. Supports both HTTP POST to URL and direct handler invocation (bypass).",
                inputSchema: zodToJsonSchema(z.object({
                    webhookUrl: z.string().optional().describe("Webhook endpoint URL for HTTP mode"),
                    handlerPath: z.string().optional().describe("Path to webhook handler file for direct invocation (bypasses HTTP)"),
                    payload: z.record(z.any()).describe("Webhook payload/body"),
                    signatureHeader: z.object({
                        name: z.string(),
                        value: z.string(),
                    }).optional().describe("Optional signature header for webhook verification"),
                })),
            },
            {
                name: "generate_reproduction_script",
                description: "Generates a standalone TypeScript script to reproduce a database state or bug.",
                inputSchema: zodToJsonSchema(z.object({
                    issueDescription: z.string(),
                    sql: z.string(),
                    steps: z.array(z.string()),
                })),
            },
            {
                name: "audit_connectivity",
                description: "Checks connectivity to infrastructure resources.",
                inputSchema: zodToJsonSchema(z.object({
                    resourceType: z.enum(["db", "redis", "s3"]),
                    connectionString: z.string(),
                })),
            },
            {
                name: "simulate_transaction",
                description: "Executes a SQL operation within a rollback transaction to test validity.",
                inputSchema: zodToJsonSchema(z.object({
                    sql: z.string(),
                    parameters: z.array(z.any()).optional(),
                    connectionString: z.string().optional(),
                })),
            },
            {
                name: "validate_schema_contracts_batch",
                description: "Validates multiple database tables in a single operation.",
                inputSchema: zodToJsonSchema(z.object({
                    tables: z.array(z.object({
                        tableName: z.string(),
                        expectedSchema: z.record(z.string()),
                    })),
                    connectionString: z.string().optional(),
                    checkForeignKeys: z.boolean().optional(),
                })),
            },
            {
                name: "validate_api_contracts_batch",
                description: "Validates multiple API endpoints in a single operation. Supports both HTTP and direct handler invocation (bypass).",
                inputSchema: zodToJsonSchema(z.object({
                    endpoints: z.array(z.object({
                        url: z.string().optional().describe("API URL for HTTP mode"),
                        handlerPath: z.string().optional().describe("Handler path for direct invocation (bypass)"),
                        method: z.string().describe("HTTP method"),
                        expectedResponseSchema: z.record(z.any()).describe("Expected response schema"),
                        body: z.any().optional().describe("Request body (for POST/PUT/PATCH)"),
                    })),
                    headers: z.record(z.string()).optional().describe("Common headers for all endpoints"),
                    parallel: z.boolean().optional().describe("Execute in parallel (default: true)"),
                })),
            },
            {
                name: "audit_connectivity_batch",
                description: "Tests connectivity to multiple infrastructure resources.",
                inputSchema: zodToJsonSchema(z.object({
                    resources: z.array(z.object({
                        type: z.enum(["db", "redis", "s3"]),
                        connectionString: z.string(),
                    })),
                    timeout: z.number().optional(),
                    parallel: z.boolean().optional(),
                })),
            },
            {
                name: "validate_api_contract",
                description: "Validates API responses against expected JSON schema using Zod. Supports both HTTP requests and direct handler invocation (bypass).",
                inputSchema: zodToJsonSchema(z.object({
                    url: z.string().optional().describe("API endpoint URL for HTTP mode"),
                    handlerPath: z.string().optional().describe("Path to route handler file for direct invocation (bypasses HTTP)"),
                    method: z.string().describe("HTTP method (GET, POST, etc.)"),
                    expectedResponseSchema: z.record(z.any()).describe("JSON Schema for expected response"),
                    headers: z.record(z.string()).optional().describe("HTTP headers"),
                    body: z.any().optional().describe("Request body (for POST/PUT/PATCH in direct mode)"),
                })),
            },
            {
                name: "validate_orm_model",
                description: "Validates a TypeScript ORM model against the actual database schema",
                inputSchema: zodToJsonSchema(z.object({
                    modelFilePath: z.string(),
                    tableName: z.string(),
                    connectionString: z.string().optional(),
                })),
            },
            {
                name: "validate_api_types",
                description: "Validates TypeScript interface against live API response. Supports both HTTP requests and direct handler invocation (bypass).",
                inputSchema: zodToJsonSchema(z.object({
                    typeFilePath: z.string().describe("Path to TypeScript file containing the interface"),
                    typeName: z.string().describe("Name of the interface to validate"),
                    apiUrl: z.string().optional().describe("API endpoint URL for HTTP mode"),
                    handlerPath: z.string().optional().describe("Path to route handler file for direct invocation (bypasses HTTP)"),
                    method: z.string().describe("HTTP method (GET, POST, etc.)"),
                    headers: z.record(z.string()).optional().describe("HTTP headers"),
                    body: z.any().optional().describe("Request body (for POST/PUT/PATCH)"),
                })),
            },
            {
                name: "validate_env_variables",
                description: "Validates that all environment variables used in code are documented and available",
                inputSchema: zodToJsonSchema(z.object({
                    codebasePath: z.string(),
                    envExamplePath: z.string(),
                    envPath: z.string().optional(),
                    checkHardcodedSecrets: z.boolean().optional(),
                })),
            },
            {
                name: "validate_migration_safety",
                description: "Validates that a database migration won't break existing code by checking for references to affected columns/tables",
                inputSchema: zodToJsonSchema(z.object({
                    migrationSql: z.string(),
                    codebasePath: z.string(),
                    dryRun: z.boolean().optional(),
                })),
            },
            {
                name: "validate_agent_conversation",
                description: "Simulates a conversation with an AI agent, validating streaming protocols and tool calls.",
                inputSchema: zodToJsonSchema(validateAgentConversationSchema)
            },
            {
                name: "inspect_server_logs",
                description: "Retrieves server logs to explain 500 errors. Correlates the Map (Request ID) with the Territory (Log Entries).",
                inputSchema: zodToJsonSchema(z.object({
                    lines: z.number().optional().default(50),
                    filter: z.string().optional(),
                    logFilePath: z.string().optional(),
                })),
            },
            {
                name: "validate_middleware",
                description: "Tests middleware functions without full HTTP stack. Validates middleware behavior in isolation.",
                inputSchema: zodToJsonSchema(z.object({
                    middlewarePath: z.string().describe("Path to middleware file"),
                    middlewareExport: z.string().optional().describe("Export name (default: 'default')"),
                    request: z.object({
                        method: z.string().optional().describe("HTTP method"),
                        url: z.string().optional().describe("Request URL"),
                        headers: z.record(z.string()).optional().describe("Request headers"),
                        body: z.any().optional().describe("Request body"),
                        cookies: z.record(z.string()).optional().describe("Request cookies"),
                    }).describe("Mock request configuration"),
                    expectedAction: z.enum(["allow", "deny", "redirect", "modify"]).describe("Expected middleware action"),
                    expectedStatusCode: z.number().optional().describe("Expected HTTP status code"),
                    expectedHeaders: z.record(z.string()).optional().describe("Expected response headers"),
                    expectedRedirect: z.string().optional().describe("Expected redirect URL"),
                })),
            },
            {
                name: "validate_api_error_handling",
                description: "Tests API error responses and edge cases. Supports both HTTP and direct handler invocation (bypass).",
                inputSchema: zodToJsonSchema(z.object({
                    url: z.string().optional().describe("API URL for HTTP mode"),
                    handlerPath: z.string().optional().describe("Path to route handler for direct invocation (bypass)"),
                    method: z.string().describe("HTTP method"),
                    invalidBody: z.any().optional().describe("Invalid request body to trigger error"),
                    invalidHeaders: z.record(z.string()).optional().describe("Invalid headers"),
                    invalidParams: z.record(z.string()).optional().describe("Invalid parameters"),
                    expectedError: z.object({
                        status: z.number().describe("Expected HTTP status code"),
                        code: z.string().optional().describe("Expected error code"),
                        message: z.string().optional().describe("Expected error message"),
                        fields: z.array(z.string()).optional().describe("Expected error fields"),
                    }).describe("Expected error response"),
                })),
            },
            {
                name: "validate_ssr_rendering",
                description: "Validates server-side rendering by directly invoking Next.js pages, layouts, or React Server Components. Supports both HTTP requests and direct component invocation (bypass).",
                inputSchema: zodToJsonSchema(z.object({
                    url: z.string().optional().describe("URL for HTTP mode"),
                    pagePath: z.string().optional().describe("Page path for direct mode"),
                    componentPath: z.string().optional().describe("Component path for direct mode"),
                    params: z.record(z.string()).optional().describe("Route params"),
                    searchParams: z.record(z.string()).optional().describe("Query params"),
                    expectedContent: z.array(z.string()).optional().describe("Expected content strings"),
                    expectedMetadata: z.object({
                        title: z.string().optional(),
                        description: z.string().optional(),
                        openGraph: z.record(z.any()).optional(),
                    }).optional().describe("Expected metadata"),
                    checkHydration: z.boolean().optional().describe("Check for hydration errors"),
                    cookies: z.record(z.string()).optional().describe("Request cookies"),
                    headers: z.record(z.string()).optional().describe("Request headers"),
                })),
            },
            {
                name: "validate_serverless_function",
                description: "Validates serverless functions (AWS Lambda, Vercel, Cloudflare Workers, Netlify) without deployment. Tests handlers directly by mocking platform-specific events and context.",
                inputSchema: zodToJsonSchema(z.object({
                    handlerPath: z.string().describe("Path to serverless handler file"),
                    handlerExport: z.string().optional().describe("Export name (default: 'handler')"),
                    platform: z.enum(["aws-lambda", "vercel", "cloudflare-workers", "netlify"]).describe("Serverless platform"),
                    event: z.any().describe("Platform-specific event object"),
                    context: z.any().optional().describe("Platform-specific context object"),
                    expectedStatusCode: z.number().optional().describe("Expected HTTP status code"),
                    expectedBody: z.any().optional().describe("Expected response body"),
                    expectedHeaders: z.record(z.string()).optional().describe("Expected response headers"),
                    timeout: z.number().optional().describe("Execution timeout in milliseconds"),
                })),
            },
            {
                name: "validate_ai_chat",
                description: "Validates AI chat infrastructure and can CONTINUE conversations from the database. Checks schema, model IDs, persistence, and can send test messages to get AI responses - bypassing the need for a local server. Supports multi-step tool execution.",
                inputSchema: zodToJsonSchema(z.object({
                    connectionString: z.string().describe("PostgreSQL connection string"),
                    tableConfig: z.object({
                        conversationsTable: z.string().optional().describe("Conversations table name (default: ai_conversations)"),
                        messagesTable: z.string().optional().describe("Messages table name (default: ai_messages)"),
                        columns: z.object({
                            convId: z.string().optional().describe("Conversation ID column (default: id)"),
                            convTitle: z.string().optional().describe("Conversation title column (default: title)"),
                            convModel: z.string().optional().describe("Model column (default: model)"),
                            convCreatedAt: z.string().optional().describe("Created at column (default: created_at)"),
                            convUserId: z.string().optional().describe("User ID column (default: user_id)"),
                            msgId: z.string().optional().describe("Message ID column (default: id)"),
                            msgConversationId: z.string().optional().describe("Conversation ID FK column (default: conversation_id)"),
                            msgRole: z.string().optional().describe("Role column (default: role)"),
                            msgContent: z.string().optional().describe("Content column (default: content)"),
                            msgToolCalls: z.string().optional().describe("Tool calls column (default: tool_calls)"),
                            msgToolResults: z.string().optional().describe("Tool results column (default: tool_results)"),
                            msgCreatedAt: z.string().optional().describe("Message created at column (default: created_at)"),
                        }).optional(),
                    }).optional().describe("Custom table and column configuration"),
                    conversationId: z.string().optional().describe("Specific conversation ID to validate"),
                    userId: z.string().optional().describe("Filter conversations by user ID"),
                    limit: z.number().optional().describe("Number of recent conversations to check (default: 5)"),
                    testApiCall: z.boolean().optional().describe("Test the AI provider API directly"),
                    apiConfig: z.object({
                        provider: z.enum(["anthropic", "openai", "google", "custom"]).describe("AI provider"),
                        endpoint: z.string().optional().describe("Custom API endpoint"),
                        apiKey: z.string().optional().describe("API key for testing"),
                        authHeader: z.string().optional().describe("Custom auth header name"),
                        authPrefix: z.string().optional().describe("Auth prefix (e.g., 'Bearer ')"),
                        customModels: z.array(z.string()).optional().describe("Additional valid models"),
                    }).optional().describe("API configuration for testing"),
                    validateSchema: z.boolean().optional().describe("Validate database schema (default: true)"),
                    validateMessages: z.boolean().optional().describe("Validate conversations and messages (default: true)"),
                    checkToolPersistence: z.boolean().optional().describe("Check tool_calls/tool_results persistence (default: true)"),
                    continueConversation: z.object({
                        conversationId: z.string().describe("Conversation ID to continue"),
                        testMessage: z.string().describe("Message to send to continue the conversation"),
                        maxTokens: z.number().optional().describe("Max response tokens (default: 1024)"),
                        systemPrompt: z.string().optional().describe("Override system prompt"),
                        tools: z.array(z.object({
                            name: z.string().describe("Tool name"),
                            description: z.string().describe("Tool description"),
                            input_schema: z.any().describe("JSON Schema for tool parameters"),
                        })).optional().describe("Tools available for AI to call"),
                        executeToolCalls: z.boolean().optional().describe("Execute tool calls and continue (multi-step)"),
                        maxToolSteps: z.number().optional().describe("Max tool execution iterations (default: 5)"),
                    }).optional().describe("Continue a conversation from the database and get AI response"),
                })),
            },
            {
                name: "validate_runtime_types",
                description: "Detects runtime type errors that TypeScript misses: .trim() on undefined, null method calls, missing params, nullable DB fields. Analyzes code patterns OR validates actual data. Critical for catching 'cannot read property X of undefined' errors BEFORE they happen. BATCH MODES: code_patterns_batch validates multiple files, db_schema_batch validates multiple tables.",
                inputSchema: zodToJsonSchema(z.object({
                    mode: z.enum(["code_patterns", "db_row", "params", "data_flow", "code_patterns_batch", "db_schema_batch"]).describe("Validation mode: 'code_patterns' analyzes single file, 'code_patterns_batch' analyzes multiple files, 'db_row' validates single row, 'db_schema_batch' validates multiple tables, 'params' validates route/query/body params, 'data_flow' traces data from DB to usage"),
                    // For code_patterns mode
                    code: z.string().optional().describe("Source code to analyze (for code_patterns mode)"),
                    filename: z.string().optional().describe("Filename for error reporting"),
                    // For code_patterns_batch mode
                    files: z.array(z.object({
                        path: z.string().describe("File path for error reporting"),
                        code: z.string().describe("Source code to analyze"),
                    })).optional().describe("Array of files to analyze (for code_patterns_batch mode)"),
                    stopOnFirstError: z.boolean().optional().describe("Stop batch processing on first error (default: false)"),
                    // For db_row mode
                    row: z.record(z.any()).optional().describe("Database row to validate (for db_row mode)"),
                    expectedShape: z.record(z.object({
                        type: z.enum(["string", "number", "boolean", "object", "array", "date"]),
                        nullable: z.boolean().optional(),
                        optional: z.boolean().optional(),
                    })).optional().describe("Expected shape of the database row"),
                    context: z.string().optional().describe("Context for error messages (e.g., table name)"),
                    // For db_schema_batch mode
                    tables: z.array(z.object({
                        tableName: z.string().describe("Database table name"),
                        expectedShape: z.record(z.object({
                            type: z.enum(["string", "number", "boolean", "object", "array", "date"]),
                            nullable: z.boolean().optional(),
                            optional: z.boolean().optional(),
                        })).describe("Expected schema of the table"),
                        query: z.string().optional().describe("Optional query to fetch sample row"),
                    })).optional().describe("Array of tables to validate (for db_schema_batch mode)"),
                    // For params mode
                    params: z.record(z.any()).optional().describe("Params object to validate (for params mode)"),
                    expectedParams: z.record(z.object({
                        type: z.enum(["string", "number", "boolean", "uuid", "slug"]),
                        required: z.boolean().optional(),
                    })).optional().describe("Expected params schema"),
                    source: z.enum(["route", "query", "body"]).optional().describe("Source of params (default: route)"),
                    // For data_flow mode
                    connectionString: z.string().optional().describe("Database connection string (for data_flow and db_schema_batch modes)"),
                    tableName: z.string().optional().describe("Table name to validate against"),
                    query: z.string().optional().describe("SQL query to test"),
                    expectedFields: z.record(z.object({
                        type: z.enum(["string", "number", "boolean", "object", "array", "date"]),
                        nullable: z.boolean().optional(),
                        usedAs: z.array(z.string()).optional().describe("Methods called on this field (e.g., ['trim', 'toLowerCase'])"),
                    })).optional().describe("Expected fields and how they are used in code"),
                })),
            },
            {
                name: "smoke_test_sandbox",
                description: "Execute code in an isolated sandbox to catch runtime errors BEFORE deployment. Run functions with real DB data or mock data. Catches TypeError, null/undefined access, and other runtime issues that static analysis misses. BATCH MODE: execute_functions_batch tests multiple functions at once.",
                inputSchema: zodToJsonSchema(z.object({
                    mode: z.enum(["execute_function", "execute_snippet", "trace_execution", "execute_functions_batch"]).describe("Test mode: 'execute_function' runs single function, 'execute_functions_batch' runs multiple functions, 'execute_snippet' runs arbitrary code, 'trace_execution' traces property accesses"),
                    // For execute_function mode
                    functionPath: z.string().optional().describe("Path to the file containing the function (for execute_function/trace_execution)"),
                    functionName: z.string().optional().describe("Name of the function to execute"),
                    exportType: z.enum(["named", "default"]).optional().describe("Export type (default: 'named')"),
                    testInputs: z.array(z.any()).optional().describe("Array of test inputs to pass to the function"),
                    dataSource: z.object({
                        type: z.enum(["db_query", "mock", "file"]).describe("Data source type"),
                        connectionString: z.string().optional().describe("Database connection string (for db_query)"),
                        query: z.string().optional().describe("SQL query to fetch test data (for db_query)"),
                        mockData: z.array(z.any()).optional().describe("Mock data array (for mock)"),
                        filePath: z.string().optional().describe("Path to JSON file with test data (for file)"),
                    }).optional().describe("Data source for test inputs (alternative to testInputs)"),
                    // For execute_functions_batch mode
                    functions: z.array(z.object({
                        functionPath: z.string().describe("Path to file containing the function"),
                        functionName: z.string().describe("Name of the function to execute"),
                        exportType: z.enum(["named", "default"]).optional().describe("Export type (default: 'named')"),
                        testInputs: z.array(z.any()).describe("Array of test inputs"),
                        label: z.string().optional().describe("Label for reporting (default: functionName@functionPath)"),
                    })).optional().describe("Array of functions to test (for execute_functions_batch mode)"),
                    stopOnFirstError: z.boolean().optional().describe("Stop batch on first error (default: false)"),
                    // For execute_snippet mode
                    code: z.string().optional().describe("Code snippet to execute (for execute_snippet)"),
                    variables: z.record(z.any()).optional().describe("Variables to inject into the snippet"),
                    // For trace_execution mode
                    testInput: z.any().optional().describe("Single test input for tracing (for trace_execution)"),
                    traceDepth: z.number().optional().describe("Depth of property access tracing (default: 3)"),
                    // Common options
                    timeout: z.number().optional().describe("Execution timeout in ms (default: 5000)"),
                    captureWarnings: z.boolean().optional().describe("Capture console.warn output (default: true)"),
                })),
            },
        ],
    };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Handle nested params structure (args might be {params: {...}} or {...})
    const toolArgs = args.params || args;
    // Debug logging
    console.error('[TS Debug] Tool called:', name);
    console.error('[TS Debug] Arguments received:', JSON.stringify(args, null, 2));
    try {
        if (name === "validate_schema_contract") {
            const { tableName, expectedSchema, connectionString, focus_columns } = toolArgs;
            try {
                const db = getDbConnection(connectionString);
                const result = await db.query(`SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_name = $1`, [tableName]);
                const actualSchema = result.rows.reduce((acc, row) => {
                    acc[row.column_name] = row.data_type;
                    return acc;
                }, {});
                const discrepancies = [];
                const missing_columns = [];
                const type_mismatches = [];
                // Filter expected schema if focus_columns is provided
                const columnsToCheck = focus_columns
                    ? Object.entries(expectedSchema).filter(([col]) => focus_columns.includes(col))
                    : Object.entries(expectedSchema);
                for (const [col, type] of columnsToCheck) {
                    if (!actualSchema[col]) {
                        discrepancies.push(`Missing column: ${col}`);
                        missing_columns.push(col);
                    }
                    else if (actualSchema[col] !== type) {
                        discrepancies.push(`Type mismatch for ${col}: expected ${type}, got ${actualSchema[col]}`);
                        type_mismatches.push(`${col} (expected ${type}, got ${actualSchema[col]})`);
                    }
                }
                if (discrepancies.length > 0) {
                    return formatResponse({
                        status: "error",
                        match: false,
                        diff: { missing_columns, type_mismatches },
                        summary: `Schema validation failed for table '${tableName}'. Found ${discrepancies.length} discrepancies.`,
                        hint: missing_columns.length > 0 ? "You may need to run a migration to add the missing columns." : "Check your column type definitions."
                    });
                }
                return formatResponse({
                    status: "success",
                    match: true,
                    diff: { missing_columns: [], type_mismatches: [] },
                    summary: `Schema validation passed for table '${tableName}'.`,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Database error: ${errorMessage}`,
                    hint: "Check your database connection string and ensure the table exists."
                });
            }
        }
        if (name === "simulate_transaction") {
            const { sql, parameters, connectionString } = toolArgs;
            try {
                const db = getDbConnection(connectionString);
                const client = await db.connect();
                try {
                    await client.query("BEGIN");
                    const result = await client.query(sql, parameters || []);
                    await client.query("ROLLBACK");
                    return formatResponse({
                        status: "success",
                        valid: true,
                        result: result.rows,
                        summary: "Transaction simulation successful. The query is valid and violates no constraints.",
                    });
                }
                catch (txError) {
                    await client.query("ROLLBACK");
                    const errorMessage = txError instanceof Error ? txError.message : String(txError);
                    return formatResponse({
                        status: "error",
                        valid: false,
                        message: `Transaction simulation failed: ${errorMessage}`,
                        hint: "Check your SQL syntax and foreign key constraints."
                    });
                }
                finally {
                    client.release();
                }
            }
            catch (connError) {
                const errorMessage = connError instanceof Error ? connError.message : String(connError);
                return formatResponse({
                    status: "error",
                    message: `Connection error: ${errorMessage}`,
                    hint: "Ensure the database is reachable and credentials are correct."
                });
            }
        }
        if (name === "validate_api_contract") {
            const { url, handlerPath, method, expectedResponseSchema, headers, body } = toolArgs;
            // Validation: need either url or handlerPath
            if (!url && !handlerPath) {
                return formatResponse({
                    status: "error",
                    message: "Either 'url' or 'handlerPath' must be provided",
                    hint: "Use 'url' for HTTP mode or 'handlerPath' for direct handler invocation (HTTP bypass)"
                });
            }
            try {
                let responseData;
                let responseStatus;
                let mode;
                if (handlerPath) {
                    // --- Direct Handler Invocation Mode (HTTP Bypass) ---
                    mode = "direct";
                    const invokeHandlerDirectly = await getHttpBypass();
                    const result = await invokeHandlerDirectly({
                        handlerPath,
                        method: method.toUpperCase(),
                        url,
                        body,
                        headers
                    });
                    responseStatus = result.status;
                    responseData = result.body;
                    // Parse JSON string if needed
                    if (typeof responseData === 'string') {
                        try {
                            responseData = JSON.parse(responseData);
                        }
                        catch (e) {
                            // Keep as string if not JSON
                        }
                    }
                }
                else {
                    // --- HTTP Mode (Original) ---
                    mode = "http";
                    const response = await axios({
                        method,
                        url,
                        headers,
                        validateStatus: () => true,
                    });
                    responseStatus = response.status;
                    responseData = response.data;
                }
                if (responseStatus >= 400) {
                    return formatResponse({
                        status: "error",
                        match: false,
                        http_status: responseStatus,
                        mode,
                        message: `API returned error status: ${responseStatus}`,
                        hint: "Check API URL and credentials"
                    });
                }
                // Build Zod schema from JSON Schema-like object
                const buildZodSchema = (schema) => {
                    if (schema.type === "object") {
                        const shape = {};
                        for (const [key, value] of Object.entries(schema.properties || {})) {
                            const fieldSchema = value;
                            let zodField;
                            switch (fieldSchema.type) {
                                case "string":
                                    zodField = fieldSchema.format === "email"
                                        ? z.string().email()
                                        : z.string();
                                    break;
                                case "number":
                                    zodField = z.number();
                                    break;
                                case "integer":
                                    zodField = z.number().int();
                                    break;
                                case "boolean":
                                    zodField = z.boolean();
                                    break;
                                case "array":
                                    zodField = z.array(z.any());
                                    break;
                                case "object":
                                    zodField = buildZodSchema(fieldSchema);
                                    break;
                                default:
                                    zodField = z.any();
                            }
                            // Make optional if not in required array
                            if (!schema.required || !schema.required.includes(key)) {
                                zodField = zodField.optional();
                            }
                            shape[key] = zodField;
                        }
                        return z.object(shape);
                    }
                    else if (schema.type === "array") {
                        return z.array(z.any());
                    }
                    return z.any();
                };
                try {
                    const zodSchema = buildZodSchema(expectedResponseSchema);
                    const validated = zodSchema.parse(responseData);
                    const source = handlerPath ? `handler ${handlerPath}` : `${method} ${url}`;
                    return formatResponse({
                        status: "success",
                        match: true,
                        valid: true,
                        mode,
                        http_status: responseStatus,
                        data: validated,
                        summary: `Response from ${source} matches expected schema`,
                    });
                }
                catch (validationError) {
                    if (validationError instanceof z.ZodError) {
                        const source = handlerPath ? `handler ${handlerPath}` : `${method} ${url}`;
                        return formatResponse({
                            status: "error",
                            match: false,
                            valid: false,
                            mode,
                            http_status: responseStatus,
                            issues: validationError.issues.map(issue => ({
                                path: issue.path.join('.'),
                                message: issue.message,
                                code: issue.code,
                            })),
                            summary: `Response from ${source} doesn't match expected schema`,
                            hint: "Update your TypeScript types or check the API documentation"
                        });
                    }
                    throw validationError;
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Request/Invocation failed: ${errorMessage}`,
                    hint: handlerPath ? "Check handler path and ensure it exports the method function" : "Check the URL, network connectivity, and API keys."
                });
            }
        }
        if (name === "simulate_webhook_event") {
            const { webhookUrl, handlerPath, payload, signatureHeader } = toolArgs;
            // Validation: need either webhookUrl or handlerPath
            if (!webhookUrl && !handlerPath) {
                return formatResponse({
                    status: "error",
                    message: "Either 'webhookUrl' or 'handlerPath' must be provided",
                    hint: "Use 'webhookUrl' for HTTP mode or 'handlerPath' for direct handler invocation (HTTP bypass)"
                });
            }
            try {
                let responseData;
                let responseStatus;
                let mode;
                const headers = {
                    "Content-Type": "application/json",
                };
                if (signatureHeader) {
                    headers[signatureHeader.name] = signatureHeader.value;
                }
                if (handlerPath) {
                    // --- Direct Handler Invocation Mode (HTTP Bypass) ---
                    mode = "direct";
                    const invokeHandlerDirectly = await getHttpBypass();
                    const result = await invokeHandlerDirectly({
                        handlerPath,
                        method: 'POST',
                        url: webhookUrl,
                        body: payload,
                        headers
                    });
                    responseStatus = result.status;
                    responseData = result.body;
                    // Parse JSON string if needed
                    if (typeof responseData === 'string') {
                        try {
                            responseData = JSON.parse(responseData);
                        }
                        catch (e) {
                            // Keep as string if not JSON
                        }
                    }
                }
                else {
                    // --- HTTP Mode (Original) ---
                    mode = "http";
                    const response = await axios.post(webhookUrl, payload, { headers });
                    responseStatus = response.status;
                    responseData = response.data;
                }
                const source = handlerPath ? `handler ${handlerPath}` : webhookUrl;
                return formatResponse({
                    status: "success",
                    mode,
                    http_status: responseStatus,
                    data: responseData,
                    summary: `Webhook event simulated successfully to ${source}`,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Webhook simulation failed: ${errorMessage}`,
                    hint: handlerPath ? "Check handler path and ensure it exports the POST function" : "Ensure the webhook endpoint is running and reachable."
                });
            }
        }
        if (name === "audit_connectivity") {
            const { resourceType, connectionString } = toolArgs;
            try {
                if (resourceType === "db") {
                    const db = getDbConnection(connectionString);
                    await db.query("SELECT 1");
                    return formatResponse({
                        status: "success",
                        connected: true,
                        resource: "database",
                        summary: "Successfully connected to the database."
                    });
                }
                if (resourceType === "redis") {
                    const Redis = await getRedis();
                    const redis = new Redis(connectionString, {
                        lazyConnect: true,
                        connectTimeout: 5000,
                        retryStrategy: () => null // Don't retry
                    });
                    try {
                        await redis.connect();
                        await redis.ping();
                        await redis.quit();
                        return formatResponse({
                            status: "success",
                            connected: true,
                            resource: "redis",
                            summary: "Successfully connected to Redis."
                        });
                    }
                    catch (err) {
                        // Ensure connection is closed
                        try {
                            await redis.quit();
                        }
                        catch { }
                        throw err;
                    }
                }
                if (resourceType === "s3") {
                    const { S3Client, ListBucketsCommand } = await getS3();
                    const s3 = new S3Client({});
                    await s3.send(new ListBucketsCommand({}));
                    return formatResponse({
                        status: "success",
                        connected: true,
                        resource: "s3",
                        summary: "Successfully connected to AWS S3."
                    });
                }
                return formatResponse({
                    status: "error",
                    message: `Unsupported resource type: ${resourceType}`,
                    hint: "Supported types: 'db', 'redis', 's3'."
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    connected: false,
                    message: `Connectivity check failed: ${errorMessage}`,
                    hint: "Check your connection string, firewall rules, and ensure the service is running."
                });
            }
        }
        if (name === "generate_reproduction_script") {
            const { issueDescription, sql, steps } = toolArgs;
            const scriptContent = `
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function reproduce() {
  console.log("Reproducing Issue: ${issueDescription}");
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("Connected to DB");

    console.log("Setting up state...");
    await client.query(\`BEGIN\`);
    await client.query(\`${sql.replace(/`/g, "\\`")}\`);
    
    console.log("Running steps...");
    ${steps.map((step) => `console.log("Step: ${step.replace(/"/g, '\\"')}");`).join("\n    ")}
    
    // Add your reproduction logic here based on the steps
    
    await client.query(\`ROLLBACK\`); // Always rollback in repro script unless specified
    console.log("Reproduction finished (Rolled back).");
  } catch (error) {
    console.error("Error during reproduction:", error);
    await client.query(\`ROLLBACK\`);
  } finally {
    await client.end();
  }
}

reproduce();
`;
            return {
                content: [
                    {
                        type: "text",
                        text: scriptContent,
                    },
                ],
            };
        }
        if (name === "validate_schema_contracts_batch") {
            const { tables, connectionString, checkForeignKeys } = toolArgs;
            try {
                const db = getDbConnection(connectionString);
                const tableNames = tables.map((t) => t.tableName);
                // 1. Fetch all columns for all requested tables
                const columnsResult = await db.query(`SELECT table_name, column_name, data_type, is_nullable
                     FROM information_schema.columns
                     WHERE table_name = ANY($1)`, [tableNames]);
                // Group columns by table
                const actualSchemas = {};
                columnsResult.rows.forEach((row) => {
                    if (!actualSchemas[row.table_name]) {
                        actualSchemas[row.table_name] = {};
                    }
                    actualSchemas[row.table_name][row.column_name] = row.data_type;
                });
                // 2. Validate each table
                const results = tables.map((table) => {
                    const actualSchema = actualSchemas[table.tableName] || {};
                    const discrepancies = [];
                    const missing_columns = [];
                    const type_mismatches = [];
                    for (const [col, type] of Object.entries(table.expectedSchema)) {
                        if (!actualSchema[col]) {
                            discrepancies.push(`Missing column: ${col}`);
                            missing_columns.push(col);
                        }
                        else if (actualSchema[col] !== type) {
                            discrepancies.push(`Type mismatch for ${col}: expected ${type}, got ${actualSchema[col]}`);
                            type_mismatches.push(`${col} (expected ${type}, got ${actualSchema[col]})`);
                        }
                    }
                    if (discrepancies.length > 0) {
                        return {
                            tableName: table.tableName,
                            status: "error",
                            match: false,
                            diff: { missing_columns, type_mismatches },
                            issues: discrepancies,
                        };
                    }
                    return {
                        tableName: table.tableName,
                        status: "success",
                        match: true,
                    };
                });
                // 3. Validate Foreign Keys (if requested)
                const foreignKeyValidation = {};
                if (checkForeignKeys) {
                    const fkResult = await db.query(`SELECT
                             tc.table_name,
                             kcu.column_name,
                             ccu.table_name AS foreign_table_name,
                             ccu.column_name AS foreign_column_name
                         FROM information_schema.table_constraints AS tc
                         JOIN information_schema.key_column_usage AS kcu
                           ON tc.constraint_name = kcu.constraint_name
                         JOIN information_schema.constraint_column_usage AS ccu
                           ON ccu.constraint_name = tc.constraint_name
                         WHERE tc.constraint_type = 'FOREIGN KEY'
                           AND tc.table_name = ANY($1)`, [tableNames]);
                    fkResult.rows.forEach((row) => {
                        const key = `${row.table_name}.${row.column_name} -> ${row.foreign_table_name}.${row.foreign_column_name}`;
                        foreignKeyValidation[key] = "valid";
                    });
                }
                const validTables = results.filter((r) => r.status === "success").length;
                const invalidTables = results.length - validTables;
                return formatResponse({
                    status: invalidTables === 0 ? "success" : "error",
                    summary: `Validated ${tables.length} tables: ${validTables} valid, ${invalidTables} invalid.`,
                    results,
                    foreignKeyValidation: checkForeignKeys ? foreignKeyValidation : undefined,
                    totalTables: tables.length,
                    validTables,
                    invalidTables,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Batch schema validation failed: ${errorMessage}`,
                    hint: "Check database connection and table names."
                });
            }
        }
        if (name === "validate_api_contracts_batch") {
            const { endpoints, headers, parallel } = toolArgs;
            const buildZodSchema = (schema) => {
                if (schema.type === "object") {
                    const shape = {};
                    for (const [key, value] of Object.entries(schema.properties || {})) {
                        const fieldSchema = value;
                        let zodField;
                        switch (fieldSchema.type) {
                            case "string":
                                zodField = fieldSchema.format === "email" ? z.string().email() : z.string();
                                break;
                            case "number":
                                zodField = z.number();
                                break;
                            case "integer":
                                zodField = z.number().int();
                                break;
                            case "boolean":
                                zodField = z.boolean();
                                break;
                            case "array":
                                zodField = z.array(z.any());
                                break;
                            case "object":
                                zodField = buildZodSchema(fieldSchema);
                                break;
                            default:
                                zodField = z.any();
                        }
                        if (!schema.required || !schema.required.includes(key)) {
                            zodField = zodField.optional();
                        }
                        shape[key] = zodField;
                    }
                    return z.object(shape);
                }
                else if (schema.type === "array") {
                    return z.array(z.any());
                }
                return z.any();
            };
            const validateEndpoint = async (endpoint) => {
                const start = Date.now();
                // Validation: need either url or handlerPath
                if (!endpoint.url && !endpoint.handlerPath) {
                    return {
                        source: "unknown",
                        method: endpoint.method,
                        status: "error",
                        message: "Either 'url' or 'handlerPath' must be provided",
                        responseTime: Date.now() - start,
                    };
                }
                try {
                    let responseData;
                    let responseStatus;
                    let mode;
                    if (endpoint.handlerPath) {
                        // --- Direct Handler Invocation Mode (HTTP Bypass) ---
                        mode = "direct";
                        const invokeHandlerDirectly = await getHttpBypass();
                        const result = await invokeHandlerDirectly({
                            handlerPath: endpoint.handlerPath,
                            method: endpoint.method.toUpperCase(),
                            url: endpoint.url,
                            body: endpoint.body,
                            headers
                        });
                        responseStatus = result.status;
                        responseData = result.body;
                        // Parse JSON string if needed
                        if (typeof responseData === 'string') {
                            try {
                                responseData = JSON.parse(responseData);
                            }
                            catch (e) {
                                // Keep as string if not JSON
                            }
                        }
                    }
                    else {
                        // --- HTTP Mode (Original) ---
                        mode = "http";
                        const response = await axios({
                            method: endpoint.method,
                            url: endpoint.url,
                            headers,
                            validateStatus: () => true,
                        });
                        responseStatus = response.status;
                        responseData = response.data;
                    }
                    const duration = Date.now() - start;
                    const source = endpoint.handlerPath ? `handler ${endpoint.handlerPath}` : endpoint.url;
                    if (responseStatus >= 400) {
                        return {
                            source,
                            method: endpoint.method,
                            mode,
                            status: "error",
                            match: false,
                            http_status: responseStatus,
                            responseTime: duration,
                            message: `HTTP ${responseStatus}`,
                        };
                    }
                    try {
                        const zodSchema = buildZodSchema(endpoint.expectedResponseSchema);
                        zodSchema.parse(responseData);
                        return {
                            source,
                            method: endpoint.method,
                            mode,
                            status: "success",
                            match: true,
                            http_status: responseStatus,
                            responseTime: duration,
                        };
                    }
                    catch (validationError) {
                        if (validationError instanceof z.ZodError) {
                            return {
                                source,
                                method: endpoint.method,
                                mode,
                                status: "error",
                                match: false,
                                http_status: responseStatus,
                                responseTime: duration,
                                issues: validationError.issues.map(issue => issue.message),
                            };
                        }
                        throw validationError;
                    }
                }
                catch (error) {
                    const duration = Date.now() - start;
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const source = endpoint.handlerPath ? `handler ${endpoint.handlerPath}` : endpoint.url;
                    return {
                        source,
                        method: endpoint.method,
                        mode: endpoint.handlerPath ? "direct" : "http",
                        status: "error",
                        match: false,
                        message: errorMessage,
                        responseTime: duration,
                    };
                }
            };
            try {
                let results;
                if (parallel !== false) {
                    results = await Promise.all(endpoints.map(validateEndpoint));
                }
                else {
                    results = [];
                    for (const endpoint of endpoints) {
                        results.push(await validateEndpoint(endpoint));
                    }
                }
                const validEndpoints = results.filter((r) => r.status === "success").length;
                const totalTime = results.reduce((acc, r) => acc + r.responseTime, 0);
                const avgTime = Math.round(totalTime / results.length);
                return formatResponse({
                    status: "success",
                    summary: `Validated ${endpoints.length} endpoints: ${validEndpoints} valid. Avg response: ${avgTime}ms`,
                    results,
                    totalEndpoints: endpoints.length,
                    validEndpoints,
                    invalidEndpoints: endpoints.length - validEndpoints,
                    averageResponseTime: avgTime,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Batch API validation failed: ${errorMessage}`,
                });
            }
        }
        if (name === "audit_connectivity_batch") {
            const { resources, timeout, parallel } = toolArgs;
            const checkResource = async (res) => {
                const start = Date.now();
                try {
                    if (res.type === "db") {
                        const client = new Client({
                            connectionString: res.connectionString,
                            connectionTimeoutMillis: timeout || 5000,
                        });
                        await client.connect();
                        await client.query("SELECT 1");
                        await client.end();
                        return {
                            type: res.type,
                            status: "success",
                            connected: true,
                            latency: Date.now() - start,
                        };
                    }
                    if (res.type === "redis") {
                        const Redis = await getRedis();
                        const redis = new Redis(res.connectionString, {
                            lazyConnect: true,
                            connectTimeout: timeout || 5000,
                            retryStrategy: () => null
                        });
                        try {
                            await redis.connect();
                            await redis.ping();
                            await redis.quit();
                            return {
                                type: res.type,
                                status: "success",
                                connected: true,
                                latency: Date.now() - start,
                            };
                        }
                        catch (err) {
                            try {
                                await redis.quit();
                            }
                            catch { }
                            throw err;
                        }
                    }
                    if (res.type === "s3") {
                        const { S3Client, ListBucketsCommand } = await getS3();
                        const s3 = new S3Client({});
                        await s3.send(new ListBucketsCommand({}));
                        return {
                            type: res.type,
                            status: "success",
                            connected: true,
                            latency: Date.now() - start,
                        };
                    }
                    return {
                        type: res.type,
                        status: "error",
                        connected: false,
                        message: "Unsupported resource type",
                        latency: Date.now() - start,
                    };
                }
                catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        type: res.type,
                        status: "error",
                        connected: false,
                        message: errorMessage,
                        latency: Date.now() - start,
                    };
                }
            };
            try {
                let results;
                if (parallel !== false) {
                    results = await Promise.all(resources.map(checkResource));
                }
                else {
                    results = [];
                    for (const res of resources) {
                        results.push(await checkResource(res));
                    }
                }
                const reachable = results.filter(r => r.connected).length;
                return formatResponse({
                    status: "success",
                    summary: `Connectivity audit: ${reachable}/${resources.length} resources reachable`,
                    results,
                    totalResources: resources.length,
                    reachable,
                    unreachable: resources.length - reachable,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Batch connectivity audit failed: ${errorMessage}`,
                });
            }
        }
        if (name === "validate_orm_model") {
            const params = toolArgs;
            return formatResponse(await validateOrmModel(params));
        }
        if (name === "validate_api_types") {
            const params = toolArgs;
            return formatResponse(await validateApiTypes(params));
        }
        if (name === "validate_migration_safety") {
            const { migrationSql, codebasePath, dryRun } = toolArgs;
            if (!migrationSql || !codebasePath) {
                return formatResponse({
                    status: "error",
                    message: "migrationSql and codebasePath parameters are required",
                    hint: "Provide valid SQL migration and codebase path"
                });
            }
            try {
                const absoluteCodebase = resolve(codebasePath);
                // Parse SQL to identify operations
                const changes = [];
                const sql = migrationSql.toUpperCase();
                // Pattern matching for SQL operations
                const dropColumnPattern = /ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/gi;
                const renameColumnPattern = /ALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/gi;
                const dropTablePattern = /DROP\s+TABLE\s+(\w+)/gi;
                const renameTablePattern = /ALTER\s+TABLE\s+(\w+)\s+RENAME\s+TO\s+(\w+)/gi;
                // Find DROP COLUMN
                let match;
                while ((match = dropColumnPattern.exec(sql)) !== null) {
                    changes.push({
                        type: "drop_column",
                        table: match[1].toLowerCase(),
                        column: match[2].toLowerCase(),
                        severity: "breaking"
                    });
                }
                // Find RENAME COLUMN
                dropColumnPattern.lastIndex = 0; // Reset regex
                while ((match = renameColumnPattern.exec(sql)) !== null) {
                    changes.push({
                        type: "rename_column",
                        table: match[1].toLowerCase(),
                        oldColumn: match[2].toLowerCase(),
                        newColumn: match[3].toLowerCase(),
                        severity: "breaking"
                    });
                }
                // Find DROP TABLE
                while ((match = dropTablePattern.exec(sql)) !== null) {
                    changes.push({
                        type: "drop_table",
                        table: match[1].toLowerCase(),
                        severity: "critical"
                    });
                }
                // Find RENAME TABLE
                while ((match = renameTablePattern.exec(sql)) !== null) {
                    changes.push({
                        type: "rename_table",
                        oldTable: match[1].toLowerCase(),
                        newTable: match[2].toLowerCase(),
                        severity: "critical"
                    });
                }
                if (changes.length === 0) {
                    return formatResponse({
                        status: "success",
                        safe: true,
                        changes: [],
                        summary: "No breaking schema changes detected in migration"
                    });
                }
                // Search codebase for references
                const glob = await getGlob();
                const files = await glob(`${absoluteCodebase}/**/*.{ts,js,tsx,jsx,sql}`, {
                    ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**']
                });
                const references = [];
                for (const file of files) {
                    try {
                        const content = readFileSync(file, 'utf-8');
                        const lines = content.split('\n');
                        for (const change of changes) {
                            if (change.type === "drop_column" || change.type === "rename_column") {
                                const columnPattern = new RegExp(`\\b${change.column}\\b`, 'gi');
                                const tablePattern = new RegExp(`\\b${change.table}\\b`, 'gi');
                                lines.forEach((line, index) => {
                                    if (columnPattern.test(line) || (tablePattern.test(line) && columnPattern.test(line))) {
                                        references.push({
                                            file: file.replace(absoluteCodebase, ''),
                                            line: index + 1,
                                            code: line.trim(),
                                            change: change.type === "drop_column"
                                                ? `DROP COLUMN ${change.table}.${change.column}`
                                                : `RENAME COLUMN ${change.table}.${change.oldColumn} TO ${change.newColumn}`,
                                            severity: change.severity
                                        });
                                    }
                                });
                            }
                            else if (change.type === "drop_table" || change.type === "rename_table") {
                                const tablePattern = new RegExp(`\\b${change.table || change.oldTable}\\b`, 'gi');
                                lines.forEach((line, index) => {
                                    if (tablePattern.test(line)) {
                                        references.push({
                                            file: file.replace(absoluteCodebase, ''),
                                            line: index + 1,
                                            code: line.trim(),
                                            change: change.type === "drop_table"
                                                ? `DROP TABLE ${change.table}`
                                                : `RENAME TABLE ${change.oldTable} TO ${change.newTable}`,
                                            severity: change.severity
                                        });
                                    }
                                });
                            }
                        }
                    }
                    catch (err) {
                        // Skip files that can't be read
                    }
                }
                const safe = references.length === 0;
                return formatResponse({
                    status: safe ? "success" : "error",
                    safe,
                    changes,
                    impact: {
                        filesAffected: new Set(references.map(r => r.file)).size,
                        totalReferences: references.length,
                        references: references.slice(0, 50) // Limit to first 50
                    },
                    summary: safe
                        ? "Migration appears safe - no code references found"
                        : `Migration will affect ${new Set(references.map(r => r.file)).size} files with ${references.length} references`,
                    recommendation: safe
                        ? "Safe to run migration"
                        : "Update code before running migration",
                    hint: safe ? null : "Review and update all affected files before applying migration"
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Migration validation failed: ${errorMessage}`,
                    hint: "Check SQL syntax and file paths"
                });
            }
        }
        if (name === "validate_env_variables") {
            const { codebasePath, envExamplePath, envPath, checkHardcodedSecrets } = toolArgs;
            if (!codebasePath || !envExamplePath) {
                return formatResponse({
                    status: "error",
                    message: "codebasePath and envExamplePath parameters are required",
                    hint: "Provide valid codebase path and .env.example path"
                });
            }
            try {
                const absoluteCodebase = resolve(codebasePath);
                const absoluteEnvExample = resolve(envExamplePath);
                // 1. Find all environment variable usage in code
                const glob = await getGlob();
                const files = await glob(`${absoluteCodebase}/**/*.{ts,js,tsx,jsx}`, {
                    ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**']
                });
                const usedEnvVars = new Set();
                const hardcodedSecrets = [];
                // Regex patterns
                const processEnvPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
                const secretPatterns = [
                    { pattern: /(api[_-]?key|secret|token|password)\s*=\s*['"]([^'"]{8,})['"]/, type: 'potential_secret' },
                    { pattern: /sk_live_[a-zA-Z0-9]{24,}/, type: 'stripe_secret_key' },
                    { pattern: /sk_test_[a-zA-Z0-9]{24,}/, type: 'stripe_test_key' },
                ];
                for (const file of files) {
                    try {
                        const content = readFileSync(file, 'utf-8');
                        // Find process.env usage
                        let match;
                        while ((match = processEnvPattern.exec(content)) !== null) {
                            usedEnvVars.add(match[1]);
                        }
                        // Check for hardcoded secrets
                        if (checkHardcodedSecrets !== false) {
                            for (const { pattern, type } of secretPatterns) {
                                const secretMatch = content.match(pattern);
                                if (secretMatch) {
                                    const lines = content.substring(0, secretMatch.index).split('\n');
                                    hardcodedSecrets.push({
                                        type: 'hardcoded_secret',
                                        secretType: type,
                                        file: file.replace(absoluteCodebase, ''),
                                        line: lines.length,
                                        message: `Potential hardcoded secret detected`,
                                        severity: 'critical',
                                        hint: 'Move to environment variable'
                                    });
                                }
                            }
                        }
                    }
                    catch (err) {
                        // Skip files that can't be read
                    }
                }
                // 2. Read .env.example
                let documentedEnvVars = new Set();
                try {
                    const envExampleContent = readFileSync(absoluteEnvExample, 'utf-8');
                    const envLines = envExampleContent.split('\n');
                    for (const line of envLines) {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('#')) {
                            const [key] = trimmed.split('=');
                            if (key) {
                                documentedEnvVars.add(key.trim());
                            }
                        }
                    }
                }
                catch (err) {
                    return formatResponse({
                        status: "error",
                        message: `Failed to read ${envExamplePath}: ${err instanceof Error ? err.message : String(err)}`,
                        hint: "Ensure .env.example file exists"
                    });
                }
                // 3. Optionally check .env file
                let missingFromEnv = [];
                if (envPath) {
                    try {
                        const absoluteEnv = resolve(envPath);
                        const envContent = readFileSync(absoluteEnv, 'utf-8');
                        const setEnvVars = new Set();
                        const envLines = envContent.split('\n');
                        for (const line of envLines) {
                            const trimmed = line.trim();
                            if (trimmed && !trimmed.startsWith('#')) {
                                const [key, value] = trimmed.split('=');
                                if (key && value) {
                                    setEnvVars.add(key.trim());
                                }
                            }
                        }
                        // Check if used vars are set
                        for (const varName of usedEnvVars) {
                            if (!setEnvVars.has(varName)) {
                                missingFromEnv.push(varName);
                            }
                        }
                    }
                    catch (err) {
                        // .env file might not exist, that's okay
                    }
                }
                // 4. Compare and report
                const issues = [];
                // Variables used but not documented
                for (const varName of usedEnvVars) {
                    if (!documentedEnvVars.has(varName)) {
                        issues.push({
                            type: "used_but_not_documented",
                            variable: varName,
                            message: `Environment variable '${varName}' used in code but not documented in .env.example`,
                            hint: `Add ${varName}= to .env.example`
                        });
                    }
                }
                // Variables documented but never used
                for (const varName of documentedEnvVars) {
                    if (!usedEnvVars.has(varName)) {
                        issues.push({
                            type: "documented_but_unused",
                            variable: varName,
                            message: `Environment variable '${varName}' documented but never used in code`,
                            hint: `Remove from .env.example or use in code`
                        });
                    }
                }
                // Add hardcoded secrets to issues
                issues.push(...hardcodedSecrets);
                // Add missing from .env
                if (envPath && missingFromEnv.length > 0) {
                    for (const varName of missingFromEnv) {
                        issues.push({
                            type: "used_but_not_set",
                            variable: varName,
                            message: `Environment variable '${varName}' used in code but not set in .env`,
                            hint: `Add ${varName}=<value> to .env`
                        });
                    }
                }
                return formatResponse({
                    status: issues.length > 0 ? "error" : "success",
                    valid: issues.length === 0,
                    issues,
                    summary: issues.length > 0
                        ? `Found ${issues.length} environment variable issues`
                        : `All environment variables are properly documented and used`,
                    stats: {
                        usedInCode: usedEnvVars.size,
                        documentedInExample: documentedEnvVars.size,
                        filesScanned: files.length,
                        hardcodedSecretsFound: hardcodedSecrets.length
                    }
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Environment variable validation failed: ${errorMessage}`,
                    hint: "Check file paths and permissions"
                });
            }
        }
        if (name === "validate_agent_conversation") {
            const { url, handlerPath, protocol, conversation } = toolArgs;
            const { validateAgentConversation } = await getValidateConversation();
            return formatResponse(await validateAgentConversation({
                url,
                handlerPath,
                protocol: protocol || "vercel-ai-sdk-data-stream",
                conversation
            }));
        }
        if (name === "inspect_server_logs") {
            const { lines, filter, logFilePath } = toolArgs;
            try {
                if (!logFilePath) {
                    return formatResponse({
                        status: "error",
                        message: "Log file path is required to inspect logs.",
                        hint: "Provide the absolute path to the server log file (e.g., npm-debug.log or a custom log file)."
                    });
                }
                const absoluteLogPath = resolve(logFilePath);
                const content = readFileSync(absoluteLogPath, 'utf-8');
                const logLines = content.split('\n');
                let filteredLines = logLines;
                if (filter) {
                    filteredLines = logLines.filter(line => line.includes(filter));
                }
                const recentLines = filteredLines.slice(-(lines || 50));
                return formatResponse({
                    status: "success",
                    logFilePath: absoluteLogPath,
                    totalLines: logLines.length,
                    returnedLines: recentLines.length,
                    logs: recentLines,
                    summary: `Retrieved last ${recentLines.length} lines from ${absoluteLogPath}${filter ? ` matching filter '${filter}'` : ''}`
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Failed to read log file: ${errorMessage}`,
                    hint: "Check file path and permissions."
                });
            }
        }
        if (name === "validate_middleware") {
            const params = toolArgs;
            const validateMiddleware = await getValidateMiddleware();
            return formatResponse(await validateMiddleware(params));
        }
        if (name === "validate_api_error_handling") {
            const params = toolArgs;
            const validateAPIErrorHandling = await getValidateAPIErrorHandling();
            return formatResponse(await validateAPIErrorHandling(params));
        }
        if (name === "validate_ssr_rendering") {
            const params = toolArgs;
            const validateSSRRendering = await getValidateSSRRendering();
            return formatResponse(await validateSSRRendering(params));
        }
        if (name === "validate_serverless_function") {
            const params = toolArgs;
            const validateServerlessFunction = await getValidateServerlessFunction();
            return formatResponse(await validateServerlessFunction(params));
        }
        if (name === "validate_ai_chat") {
            const { connectionString, tableConfig, conversationId, userId, limit, testApiCall, apiConfig, validateSchema, validateMessages, checkToolPersistence, continueConversation, } = toolArgs;
            const pool = getDbConnection(connectionString);
            const validateAIChat = await getValidateAIChat();
            return formatResponse(await validateAIChat(pool, {
                connectionString,
                tableConfig,
                conversationId,
                userId,
                limit,
                testApiCall,
                apiConfig,
                validateSchema,
                validateMessages,
                checkToolPersistence,
                continueConversation,
            }));
        }
        if (name === "validate_runtime_types") {
            const { mode, code, filename, files, stopOnFirstError, row, expectedShape, context, tables, params: paramsToValidate, expectedParams, source, connectionString, tableName, query, expectedFields, } = toolArgs;
            try {
                const { validateCodePatterns, validateDbRow, validateParams, validateDataFlow, validateCodePatternsBatch, validateDbSchemaBatch } = await getRuntimeTypes();
                switch (mode) {
                    case 'code_patterns': {
                        if (!code) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'code' parameter for code_patterns mode",
                                hint: "Provide the source code string to analyze"
                            });
                        }
                        return formatResponse(validateCodePatterns({ code, filename }));
                    }
                    case 'db_row': {
                        if (!row || !expectedShape) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'row' or 'expectedShape' for db_row mode",
                                hint: "Provide the database row object and expected shape schema"
                            });
                        }
                        return formatResponse(validateDbRow({ row, expectedShape, context }));
                    }
                    case 'params': {
                        if (!paramsToValidate || !expectedParams) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'params' or 'expectedParams' for params mode",
                                hint: "Provide the params object and expected params schema"
                            });
                        }
                        return formatResponse(validateParams({ params: paramsToValidate, expectedParams, source }));
                    }
                    case 'data_flow': {
                        if (!connectionString || !tableName || !query || !expectedFields) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing required parameters for data_flow mode",
                                hint: "Provide connectionString, tableName, query, and expectedFields"
                            });
                        }
                        const pool = getDbConnection(connectionString);
                        return formatResponse(await validateDataFlow(pool, { connectionString, tableName, query, expectedFields }));
                    }
                    case 'code_patterns_batch': {
                        if (!files || files.length === 0) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'files' array for code_patterns_batch mode",
                                hint: "Provide an array of { path, code } objects to analyze"
                            });
                        }
                        return formatResponse(validateCodePatternsBatch({ files, stopOnFirstError }));
                    }
                    case 'db_schema_batch': {
                        if (!tables || tables.length === 0) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'tables' array for db_schema_batch mode",
                                hint: "Provide an array of { tableName, expectedShape } objects to validate"
                            });
                        }
                        if (!connectionString) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'connectionString' for db_schema_batch mode",
                                hint: "Provide a database connection string"
                            });
                        }
                        const pool = getDbConnection(connectionString);
                        return formatResponse(await validateDbSchemaBatch(pool, { tables }));
                    }
                    default:
                        return formatResponse({
                            status: 'error',
                            message: `Unknown mode: ${mode}`,
                            hint: "Use one of: code_patterns, code_patterns_batch, db_row, db_schema_batch, params, data_flow"
                        });
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: 'error',
                    message: `Runtime type validation failed: ${errorMessage}`,
                    hint: "Check parameters and try again"
                });
            }
        }
        if (name === "smoke_test_sandbox") {
            const { mode, functionPath, functionName, exportType, testInputs, dataSource, functions, stopOnFirstError, code, variables, testInput, traceDepth, timeout, captureWarnings, } = toolArgs;
            try {
                const { executeFunction, executeSnippet, traceExecution, executeFunctionsBatch } = await getSmokeTestSandbox();
                switch (mode) {
                    case 'execute_function': {
                        if (!functionPath || !functionName) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'functionPath' or 'functionName' for execute_function mode",
                                hint: "Provide the path to the file and the function name to execute"
                            });
                        }
                        // Get database pool if needed
                        let pool = null;
                        if (dataSource?.type === 'db_query' && dataSource.connectionString) {
                            pool = getDbConnection(dataSource.connectionString);
                        }
                        return formatResponse(await executeFunction(pool, {
                            functionPath,
                            functionName,
                            exportType,
                            testInputs,
                            dataSource,
                            timeout,
                            captureWarnings
                        }));
                    }
                    case 'execute_snippet': {
                        if (!code) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'code' for execute_snippet mode",
                                hint: "Provide the code snippet to execute"
                            });
                        }
                        return formatResponse(await executeSnippet({
                            code,
                            variables,
                            timeout
                        }));
                    }
                    case 'trace_execution': {
                        if (!functionPath || !functionName) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'functionPath' or 'functionName' for trace_execution mode",
                                hint: "Provide the path to the file and the function name to trace"
                            });
                        }
                        if (testInput === undefined) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'testInput' for trace_execution mode",
                                hint: "Provide a test input object to trace"
                            });
                        }
                        return formatResponse(await traceExecution({
                            functionPath,
                            functionName,
                            exportType,
                            testInput,
                            traceDepth,
                            timeout
                        }));
                    }
                    case 'execute_functions_batch': {
                        if (!functions || functions.length === 0) {
                            return formatResponse({
                                status: 'error',
                                message: "Missing 'functions' array for execute_functions_batch mode",
                                hint: "Provide an array of { functionPath, functionName, testInputs } objects"
                            });
                        }
                        // Get database pool if any function uses db_query
                        let pool = null;
                        if (dataSource?.type === 'db_query' && dataSource.connectionString) {
                            pool = getDbConnection(dataSource.connectionString);
                        }
                        return formatResponse(await executeFunctionsBatch(pool, {
                            functions,
                            stopOnFirstError,
                            timeout
                        }));
                    }
                    default:
                        return formatResponse({
                            status: 'error',
                            message: `Unknown mode: ${mode}`,
                            hint: "Use one of: execute_function, execute_functions_batch, execute_snippet, trace_execution"
                        });
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: 'error',
                    message: `Smoke test failed: ${errorMessage}`,
                    hint: "Check parameters and file paths"
                });
            }
        }
        throw new Error(`Unknown tool: ${name}`);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return formatResponse({
            status: "error",
            message: `Error: ${errorMessage}`,
            hint: "Check tool arguments and server logs",
        });
    }
});
// Start Server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Truth Seeker MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map