/**
 * validate_ai_chat - Dynamic AI Chat Infrastructure Validation Tool
 *
 * Based on Tribal Knowledge from multi-agent collaboration.
 * Validates AI chat infrastructure by checking database schema,
 * model IDs, message persistence, and optionally testing the API directly.
 *
 * DYNAMIC: Supports configurable table names, column mappings, and API providers.
 */
import axios from 'axios';
// ========================================
// MODEL VALIDATION REGISTRY
// ========================================
const MODEL_REGISTRY = {
    anthropic: {
        validModels: [
            'claude-sonnet-4-20250514',
            'claude-3-5-haiku-20241022',
            'claude-opus-4-5-20251101',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-20240620',
        ],
        knownInvalidModels: [
            'claude-sonnet-4-5-20250929', // Does NOT exist - common mistake
            'claude-4-sonnet',
            'claude-sonnet-4',
        ],
        apiEndpoint: 'https://api.anthropic.com/v1/messages',
        apiVersion: '2023-06-01',
        authHeader: 'x-api-key',
    },
    openai: {
        validModels: [
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-4',
            'gpt-3.5-turbo',
            'o1-preview',
            'o1-mini',
        ],
        knownInvalidModels: [
            'gpt-5', // Does not exist
            'gpt4', // Wrong format
        ],
        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
        authHeader: 'Authorization',
    },
    google: {
        validModels: [
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-pro',
        ],
        knownInvalidModels: [],
        apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        authHeader: 'x-goog-api-key',
    },
};
// ========================================
// DEFAULT CONFIGURATION
// ========================================
const DEFAULT_TABLE_CONFIG = {
    conversationsTable: 'ai_conversations',
    messagesTable: 'ai_messages',
    columns: {
        convId: 'id',
        convTitle: 'title',
        convModel: 'model',
        convCreatedAt: 'created_at',
        convUserId: 'user_id',
        msgId: 'id',
        msgConversationId: 'conversation_id',
        msgRole: 'role',
        msgContent: 'content',
        msgToolCalls: 'tool_calls',
        msgToolResults: 'tool_results',
        msgCreatedAt: 'created_at',
    },
};
// ========================================
// HELPER FUNCTIONS
// ========================================
function detectProvider(model) {
    if (model.startsWith('claude') || model.startsWith('anthropic'))
        return 'anthropic';
    if (model.startsWith('gpt') || model.startsWith('o1'))
        return 'openai';
    if (model.startsWith('gemini'))
        return 'google';
    return 'unknown';
}
function isModelValid(model, provider, customModels) {
    // Check custom models first
    if (customModels?.includes(model))
        return true;
    // Check registry
    const registry = MODEL_REGISTRY[provider];
    if (registry) {
        return registry.validModels.includes(model);
    }
    // Unknown provider - can't validate
    return true; // Assume valid for unknown providers
}
function isKnownInvalidModel(model, provider) {
    const registry = MODEL_REGISTRY[provider];
    return registry?.knownInvalidModels.includes(model) || false;
}
// ========================================
// MAIN VALIDATION FUNCTION
// ========================================
export async function validateAIChat(pool, params) {
    const { conversationId, userId, testApiCall = false, apiConfig, validateSchema = true, validateMessages = true, checkToolPersistence = true, limit = 5, } = params;
    // Merge table config with defaults
    const tableConfig = {
        conversationsTable: params.tableConfig?.conversationsTable ?? DEFAULT_TABLE_CONFIG.conversationsTable,
        messagesTable: params.tableConfig?.messagesTable ?? DEFAULT_TABLE_CONFIG.messagesTable,
        columns: {
            ...DEFAULT_TABLE_CONFIG.columns,
            ...params.tableConfig?.columns,
        },
    };
    const { conversationsTable, messagesTable, columns } = tableConfig;
    const issues = [];
    const result = {
        status: 'success',
        valid: true,
        issues: [],
        summary: '',
    };
    try {
        // ========================================
        // PHASE 1: Schema Validation
        // ========================================
        if (validateSchema) {
            result.schema = {
                conversationsTableExists: false,
                messagesTableExists: false,
                schemaMismatches: [],
            };
            // Check conversations table
            const convSchemaResult = await pool.query(`
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = $1
            `, [conversationsTable]);
            if (convSchemaResult.rows.length === 0) {
                issues.push({
                    type: 'schema_missing',
                    severity: 'critical',
                    message: `Table '${conversationsTable}' does not exist`,
                    hint: `Create the ${conversationsTable} table with at least: ${columns.convId}, ${columns.convModel}, ${columns.convCreatedAt}`,
                });
            }
            else {
                result.schema.conversationsTableExists = true;
                result.schema.conversationsSchema = {};
                for (const row of convSchemaResult.rows) {
                    result.schema.conversationsSchema[row.column_name] = row.data_type;
                }
                // Check for critical columns
                const criticalConvColumns = [columns.convId, columns.convModel, columns.convCreatedAt];
                for (const col of criticalConvColumns) {
                    if (!result.schema.conversationsSchema[col]) {
                        issues.push({
                            type: 'schema_mismatch',
                            severity: 'error',
                            message: `Missing critical column '${col}' in ${conversationsTable}`,
                            hint: `Add '${col}' column to ${conversationsTable} table`,
                        });
                        result.schema.schemaMismatches.push(`${conversationsTable}.${col} missing`);
                    }
                }
            }
            // Check messages table
            const msgSchemaResult = await pool.query(`
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = $1
            `, [messagesTable]);
            if (msgSchemaResult.rows.length === 0) {
                issues.push({
                    type: 'schema_missing',
                    severity: 'critical',
                    message: `Table '${messagesTable}' does not exist`,
                    hint: `Create the ${messagesTable} table`,
                });
            }
            else {
                result.schema.messagesTableExists = true;
                result.schema.messagesSchema = {};
                for (const row of msgSchemaResult.rows) {
                    result.schema.messagesSchema[row.column_name] = row.data_type;
                }
                // Check critical message columns
                const criticalMsgColumns = [columns.msgId, columns.msgConversationId, columns.msgRole, columns.msgContent];
                for (const col of criticalMsgColumns) {
                    if (!result.schema.messagesSchema[col]) {
                        issues.push({
                            type: 'schema_mismatch',
                            severity: 'error',
                            message: `Missing critical column '${col}' in ${messagesTable}`,
                            hint: `Add '${col}' column to ${messagesTable} table`,
                        });
                        result.schema.schemaMismatches.push(`${messagesTable}.${col} missing`);
                    }
                }
                // Check tool persistence columns (warnings)
                if (checkToolPersistence && columns.msgToolCalls) {
                    if (!result.schema.messagesSchema[columns.msgToolCalls]) {
                        issues.push({
                            type: 'schema_mismatch',
                            severity: 'warning',
                            message: `Missing '${columns.msgToolCalls}' column for tool call persistence`,
                            hint: `Add JSONB column '${columns.msgToolCalls}' to persist tool interactions`,
                        });
                    }
                    if (columns.msgToolResults && !result.schema.messagesSchema[columns.msgToolResults]) {
                        issues.push({
                            type: 'schema_mismatch',
                            severity: 'warning',
                            message: `Missing '${columns.msgToolResults}' column for tool result persistence`,
                            hint: `Add JSONB column '${columns.msgToolResults}' to persist tool results`,
                        });
                    }
                }
            }
        }
        // ========================================
        // PHASE 2: Conversation & Model Validation
        // ========================================
        if (validateMessages && result.schema?.conversationsTableExists) {
            // Build dynamic query
            let whereConditions = [];
            let queryParams = [];
            let paramIndex = 1;
            if (conversationId) {
                whereConditions.push(`${columns.convId} = $${paramIndex++}`);
                queryParams.push(conversationId);
            }
            if (userId && columns.convUserId) {
                whereConditions.push(`${columns.convUserId} = $${paramIndex++}`);
                queryParams.push(userId);
            }
            const whereClause = whereConditions.length > 0
                ? `WHERE ${whereConditions.join(' AND ')}`
                : '';
            const conversationsQuery = `
                SELECT
                    ${columns.convId} as id,
                    ${columns.convTitle} as title,
                    ${columns.convModel} as model,
                    ${columns.convCreatedAt} as created_at
                    ${columns.convUserId ? `, ${columns.convUserId} as user_id` : ''}
                FROM ${conversationsTable}
                ${whereClause}
                ORDER BY ${columns.convCreatedAt} DESC
                LIMIT $${paramIndex}
            `;
            queryParams.push(limit);
            const convResult = await pool.query(conversationsQuery, queryParams);
            result.conversations = [];
            for (const conv of convResult.rows) {
                const provider = detectProvider(conv.model);
                const modelValid = isModelValid(conv.model, provider, apiConfig?.customModels);
                const isKnownInvalid = isKnownInvalidModel(conv.model, provider);
                if (!modelValid || isKnownInvalid) {
                    const registry = MODEL_REGISTRY[provider];
                    issues.push({
                        type: 'invalid_model',
                        severity: isKnownInvalid ? 'critical' : 'error',
                        message: `Invalid model ID '${conv.model}' in conversation ${conv.id}`,
                        details: {
                            conversationId: conv.id,
                            invalidModel: conv.model,
                            provider,
                            isKnownBadModel: isKnownInvalid,
                        },
                        hint: isKnownInvalid
                            ? `Model '${conv.model}' does NOT exist. ${registry ? `Try: ${registry.validModels[0]}` : ''}`
                            : `Verify model ID is correct for ${provider}`,
                    });
                }
                // Get message stats
                let messageCount = 0;
                let hasToolCalls = false;
                let hasToolResults = false;
                if (result.schema?.messagesTableExists) {
                    const toolCallsCol = columns.msgToolCalls && result.schema.messagesSchema?.[columns.msgToolCalls]
                        ? columns.msgToolCalls
                        : null;
                    const toolResultsCol = columns.msgToolResults && result.schema.messagesSchema?.[columns.msgToolResults]
                        ? columns.msgToolResults
                        : null;
                    const msgStatsQuery = `
                        SELECT
                            COUNT(*) as message_count
                            ${toolCallsCol ? `, COUNT(${toolCallsCol}) FILTER (WHERE ${toolCallsCol} IS NOT NULL) as tool_call_count` : ''}
                            ${toolResultsCol ? `, COUNT(${toolResultsCol}) FILTER (WHERE ${toolResultsCol} IS NOT NULL) as tool_result_count` : ''}
                        FROM ${messagesTable}
                        WHERE ${columns.msgConversationId} = $1
                    `;
                    const msgStatsResult = await pool.query(msgStatsQuery, [conv.id]);
                    const stats = msgStatsResult.rows[0];
                    messageCount = parseInt(stats.message_count);
                    hasToolCalls = toolCallsCol ? parseInt(stats.tool_call_count || 0) > 0 : false;
                    hasToolResults = toolResultsCol ? parseInt(stats.tool_result_count || 0) > 0 : false;
                    // Check for tool persistence issues
                    if (checkToolPersistence && hasToolCalls && !hasToolResults) {
                        issues.push({
                            type: 'persistence_issue',
                            severity: 'warning',
                            message: `Conversation ${conv.id} has tool_calls but no tool_results`,
                            details: { conversationId: conv.id },
                            hint: 'Tool results may not be persisting correctly. Check the persistence logic.',
                        });
                    }
                }
                result.conversations.push({
                    id: conv.id,
                    title: conv.title || '(untitled)',
                    model: conv.model,
                    provider,
                    modelValid,
                    messageCount,
                    hasToolCalls,
                    hasToolResults,
                    createdAt: conv.created_at,
                    userId: conv.user_id,
                });
            }
            if (conversationId && result.conversations.length === 0) {
                issues.push({
                    type: 'warning',
                    severity: 'warning',
                    message: `Conversation '${conversationId}' not found`,
                    hint: 'Check the conversation ID or query without ID to see recent conversations',
                });
            }
        }
        // ========================================
        // PHASE 3: Direct API Test (Optional)
        // ========================================
        if (testApiCall && apiConfig) {
            const { provider, apiKey, endpoint, authHeader, authPrefix, customModels } = apiConfig;
            if (!apiKey) {
                issues.push({
                    type: 'warning',
                    severity: 'warning',
                    message: 'API test requested but no apiKey provided in apiConfig',
                    hint: 'Provide apiKey in apiConfig to test the API directly',
                });
                result.apiTest = {
                    tested: false,
                    success: false,
                    provider,
                    model: '',
                    endpoint: '',
                    error: 'No API key provided',
                };
            }
            else {
                const registry = MODEL_REGISTRY[provider];
                const apiEndpoint = endpoint || registry?.apiEndpoint;
                if (!apiEndpoint) {
                    issues.push({
                        type: 'warning',
                        severity: 'warning',
                        message: `No API endpoint configured for provider '${provider}'`,
                        hint: 'Provide endpoint in apiConfig for custom providers',
                    });
                }
                else {
                    // Get model to test
                    let modelToTest = registry?.validModels[0] || '';
                    if (result.conversations && result.conversations.length > 0) {
                        modelToTest = result.conversations[0].model;
                    }
                    const startTime = Date.now();
                    try {
                        // Build request based on provider
                        let requestBody;
                        let headers = {
                            'Content-Type': 'application/json',
                        };
                        // Set auth header
                        const authHeaderName = authHeader || registry?.authHeader || 'Authorization';
                        const authValue = authPrefix ? `${authPrefix}${apiKey}` : apiKey;
                        headers[authHeaderName] = authValue;
                        // Add API version header for Anthropic
                        if (provider === 'anthropic' && registry?.apiVersion) {
                            headers['anthropic-version'] = registry.apiVersion;
                        }
                        // Build request body based on provider
                        if (provider === 'anthropic') {
                            requestBody = {
                                model: modelToTest,
                                max_tokens: 10,
                                messages: [{ role: 'user', content: 'Hi' }],
                            };
                        }
                        else if (provider === 'openai') {
                            requestBody = {
                                model: modelToTest,
                                max_tokens: 10,
                                messages: [{ role: 'user', content: 'Hi' }],
                            };
                        }
                        else {
                            // Generic request for custom providers
                            requestBody = {
                                model: modelToTest,
                                messages: [{ role: 'user', content: 'Hi' }],
                            };
                        }
                        const response = await axios.post(apiEndpoint, requestBody, {
                            headers,
                            timeout: 30000,
                        });
                        const responseTime = Date.now() - startTime;
                        result.apiTest = {
                            tested: true,
                            success: true,
                            provider,
                            model: modelToTest,
                            endpoint: apiEndpoint,
                            responseTime,
                        };
                    }
                    catch (apiError) {
                        const responseTime = Date.now() - startTime;
                        const errorMessage = apiError.response?.data?.error?.message
                            || apiError.response?.data?.message
                            || apiError.message
                            || 'Unknown error';
                        issues.push({
                            type: 'api_error',
                            severity: 'critical',
                            message: `API call failed (${provider}): ${errorMessage}`,
                            details: {
                                provider,
                                model: modelToTest,
                                endpoint: apiEndpoint,
                                statusCode: apiError.response?.status,
                                error: errorMessage,
                            },
                            hint: errorMessage.toLowerCase().includes('model')
                                ? `The model '${modelToTest}' may be invalid for ${provider}`
                                : 'Check API key and network connectivity',
                        });
                        result.apiTest = {
                            tested: true,
                            success: false,
                            provider,
                            model: modelToTest,
                            endpoint: apiEndpoint,
                            responseTime,
                            error: errorMessage,
                        };
                    }
                }
            }
        }
        // ========================================
        // PHASE 4: Continue Conversation (The Main Feature!)
        // ========================================
        if (params.continueConversation && apiConfig?.apiKey) {
            const { conversationId: contConvId, testMessage, maxTokens = 1024, tools, systemPrompt, executeToolCalls = false, toolExecutor, maxToolSteps = 5, } = params.continueConversation;
            const startTime = Date.now();
            const continuationResult = {
                success: false,
                conversationId: contConvId,
                model: '',
                provider: '',
                messagesLoaded: 0,
                testMessageSent: testMessage,
                responseTime: 0,
            };
            try {
                // 1. Load conversation metadata
                const convQuery = `
                    SELECT ${columns.convId} as id, ${columns.convModel} as model
                    FROM ${conversationsTable}
                    WHERE ${columns.convId} = $1
                `;
                const convResult = await pool.query(convQuery, [contConvId]);
                if (convResult.rows.length === 0) {
                    throw new Error(`Conversation '${contConvId}' not found`);
                }
                const conversation = convResult.rows[0];
                const model = conversation.model;
                const provider = detectProvider(model);
                continuationResult.model = model;
                continuationResult.provider = provider;
                // 2. Check which columns exist in messages table
                const msgSchemaCheck = await pool.query(`
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = $1
                `, [messagesTable]);
                const existingMsgColumns = new Set(msgSchemaCheck.rows.map(r => r.column_name));
                const hasToolCallsCol = columns.msgToolCalls && existingMsgColumns.has(columns.msgToolCalls);
                const hasToolResultsCol = columns.msgToolResults && existingMsgColumns.has(columns.msgToolResults);
                // 3. Load message history (only selecting columns that exist)
                const msgQuery = `
                    SELECT
                        ${columns.msgRole} as role,
                        ${columns.msgContent} as content
                        ${hasToolCallsCol ? `, ${columns.msgToolCalls} as tool_calls` : ''}
                        ${hasToolResultsCol ? `, ${columns.msgToolResults} as tool_results` : ''}
                    FROM ${messagesTable}
                    WHERE ${columns.msgConversationId} = $1
                    ORDER BY ${columns.msgCreatedAt} ASC
                `;
                const msgResult = await pool.query(msgQuery, [contConvId]);
                continuationResult.messagesLoaded = msgResult.rows.length;
                // 4. Format messages for the provider
                const formattedMessages = [];
                // Add system prompt if provided
                if (systemPrompt && provider === 'anthropic') {
                    // Anthropic handles system separately
                }
                else if (systemPrompt) {
                    formattedMessages.push({ role: 'system', content: systemPrompt });
                }
                // Convert database messages to provider format
                for (const msg of msgResult.rows) {
                    if (provider === 'anthropic') {
                        // Anthropic format
                        if (msg.role === 'user' || msg.role === 'assistant') {
                            const formattedMsg = { role: msg.role, content: msg.content };
                            // Handle tool use in assistant messages
                            if (msg.role === 'assistant' && msg.tool_calls) {
                                const toolCalls = typeof msg.tool_calls === 'string'
                                    ? JSON.parse(msg.tool_calls)
                                    : msg.tool_calls;
                                if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                                    formattedMsg.content = [
                                        ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
                                        ...toolCalls.map((tc) => ({
                                            type: 'tool_use',
                                            id: tc.id,
                                            name: tc.name,
                                            input: tc.input || tc.arguments,
                                        })),
                                    ];
                                }
                            }
                            // Handle tool results in user messages
                            if (msg.role === 'user' && msg.tool_results) {
                                const toolResults = typeof msg.tool_results === 'string'
                                    ? JSON.parse(msg.tool_results)
                                    : msg.tool_results;
                                if (Array.isArray(toolResults) && toolResults.length > 0) {
                                    formattedMsg.content = toolResults.map((tr) => ({
                                        type: 'tool_result',
                                        tool_use_id: tr.tool_use_id || tr.id,
                                        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                                    }));
                                }
                            }
                            formattedMessages.push(formattedMsg);
                        }
                    }
                    else {
                        // OpenAI format
                        if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') {
                            const formattedMsg = { role: msg.role, content: msg.content };
                            if (msg.role === 'assistant' && msg.tool_calls) {
                                const toolCalls = typeof msg.tool_calls === 'string'
                                    ? JSON.parse(msg.tool_calls)
                                    : msg.tool_calls;
                                if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                                    formattedMsg.tool_calls = toolCalls.map((tc) => ({
                                        id: tc.id,
                                        type: 'function',
                                        function: {
                                            name: tc.name,
                                            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
                                        },
                                    }));
                                }
                            }
                            formattedMessages.push(formattedMsg);
                        }
                        else if (msg.role === 'tool' && msg.tool_results) {
                            const toolResults = typeof msg.tool_results === 'string'
                                ? JSON.parse(msg.tool_results)
                                : msg.tool_results;
                            if (Array.isArray(toolResults)) {
                                for (const tr of toolResults) {
                                    formattedMessages.push({
                                        role: 'tool',
                                        tool_call_id: tr.tool_use_id || tr.id,
                                        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                                    });
                                }
                            }
                        }
                    }
                }
                // Add the test message
                formattedMessages.push({ role: 'user', content: testMessage });
                // 5. Build and send API request
                const registry = MODEL_REGISTRY[provider];
                const apiEndpoint = apiConfig.endpoint || registry?.apiEndpoint;
                if (!apiEndpoint) {
                    throw new Error(`No API endpoint for provider '${provider}'`);
                }
                const headers = {
                    'Content-Type': 'application/json',
                };
                const authHeaderName = apiConfig.authHeader || registry?.authHeader || 'Authorization';
                const authValue = apiConfig.authPrefix ? `${apiConfig.authPrefix}${apiConfig.apiKey}` : apiConfig.apiKey;
                headers[authHeaderName] = authValue;
                if (provider === 'anthropic' && registry?.apiVersion) {
                    headers['anthropic-version'] = registry.apiVersion;
                }
                // Build request body
                let requestBody;
                if (provider === 'anthropic') {
                    requestBody = {
                        model,
                        max_tokens: maxTokens,
                        messages: formattedMessages,
                    };
                    if (systemPrompt) {
                        requestBody.system = systemPrompt;
                    }
                    if (tools && tools.length > 0) {
                        requestBody.tools = tools;
                    }
                }
                else if (provider === 'openai') {
                    requestBody = {
                        model,
                        max_tokens: maxTokens,
                        messages: formattedMessages,
                    };
                    if (tools && tools.length > 0) {
                        requestBody.tools = tools.map(t => ({
                            type: 'function',
                            function: {
                                name: t.name,
                                description: t.description,
                                parameters: t.input_schema,
                            },
                        }));
                    }
                }
                else {
                    requestBody = {
                        model,
                        max_tokens: maxTokens,
                        messages: formattedMessages,
                    };
                }
                // 6. Execute request (with optional multi-step tool execution)
                let currentMessages = [...formattedMessages];
                let totalToolCalls = 0;
                let stepCount = 0;
                let finalContent = '';
                let lastResponse = null;
                while (stepCount < maxToolSteps) {
                    stepCount++;
                    const response = await axios.post(apiEndpoint, {
                        ...requestBody,
                        messages: currentMessages,
                    }, {
                        headers,
                        timeout: 60000,
                    });
                    lastResponse = response.data;
                    // Parse response based on provider
                    let responseContent = '';
                    let toolCalls = [];
                    let stopReason = '';
                    if (provider === 'anthropic') {
                        stopReason = lastResponse.stop_reason;
                        for (const block of lastResponse.content || []) {
                            if (block.type === 'text') {
                                responseContent += block.text;
                            }
                            else if (block.type === 'tool_use') {
                                toolCalls.push({
                                    id: block.id,
                                    name: block.name,
                                    input: block.input,
                                });
                            }
                        }
                    }
                    else if (provider === 'openai') {
                        const choice = lastResponse.choices?.[0];
                        stopReason = choice?.finish_reason || '';
                        responseContent = choice?.message?.content || '';
                        if (choice?.message?.tool_calls) {
                            for (const tc of choice.message.tool_calls) {
                                toolCalls.push({
                                    id: tc.id,
                                    name: tc.function.name,
                                    input: JSON.parse(tc.function.arguments || '{}'),
                                });
                            }
                        }
                    }
                    finalContent = responseContent;
                    // If no tool calls or not executing them, we're done
                    if (toolCalls.length === 0 || !executeToolCalls || !toolExecutor) {
                        continuationResult.response = {
                            content: responseContent,
                            stopReason,
                            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                            usage: provider === 'anthropic' ? {
                                inputTokens: lastResponse.usage?.input_tokens,
                                outputTokens: lastResponse.usage?.output_tokens,
                            } : provider === 'openai' ? {
                                inputTokens: lastResponse.usage?.prompt_tokens,
                                outputTokens: lastResponse.usage?.completion_tokens,
                            } : undefined,
                        };
                        break;
                    }
                    // Execute tool calls
                    totalToolCalls += toolCalls.length;
                    const toolResults = [];
                    for (const tc of toolCalls) {
                        try {
                            const toolResult = await toolExecutor(tc.name, tc.input);
                            toolResults.push({
                                tool_use_id: tc.id,
                                content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                            });
                        }
                        catch (toolError) {
                            toolResults.push({
                                tool_use_id: tc.id,
                                content: `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
                                is_error: true,
                            });
                        }
                    }
                    // Add assistant response and tool results to messages
                    if (provider === 'anthropic') {
                        currentMessages.push({
                            role: 'assistant',
                            content: lastResponse.content,
                        });
                        currentMessages.push({
                            role: 'user',
                            content: toolResults.map(tr => ({
                                type: 'tool_result',
                                tool_use_id: tr.tool_use_id,
                                content: tr.content,
                                is_error: tr.is_error,
                            })),
                        });
                    }
                    else if (provider === 'openai') {
                        currentMessages.push({
                            role: 'assistant',
                            content: responseContent,
                            tool_calls: toolCalls.map(tc => ({
                                id: tc.id,
                                type: 'function',
                                function: {
                                    name: tc.name,
                                    arguments: JSON.stringify(tc.input),
                                },
                            })),
                        });
                        for (const tr of toolResults) {
                            currentMessages.push({
                                role: 'tool',
                                tool_call_id: tr.tool_use_id,
                                content: tr.content,
                            });
                        }
                    }
                    continuationResult.response = {
                        content: responseContent,
                        stopReason,
                        toolCalls,
                        toolResults,
                        usage: provider === 'anthropic' ? {
                            inputTokens: lastResponse.usage?.input_tokens,
                            outputTokens: lastResponse.usage?.output_tokens,
                        } : undefined,
                    };
                }
                if (executeToolCalls && totalToolCalls > 0) {
                    continuationResult.multiStepExecution = {
                        steps: stepCount,
                        toolCallsExecuted: totalToolCalls,
                        finalResponse: finalContent,
                    };
                }
                continuationResult.success = true;
                continuationResult.responseTime = Date.now() - startTime;
            }
            catch (contError) {
                continuationResult.error = contError.response?.data?.error?.message
                    || contError.message
                    || 'Unknown error';
                continuationResult.responseTime = Date.now() - startTime;
                issues.push({
                    type: 'api_error',
                    severity: 'critical',
                    message: `Conversation continuation failed: ${continuationResult.error}`,
                    details: { conversationId: contConvId },
                    hint: 'Check API key, model ID, and message format',
                });
            }
            result.continuationResult = continuationResult;
        }
        // ========================================
        // PHASE 5: Compile Results
        // ========================================
        result.issues = issues;
        const criticalIssues = issues.filter(i => i.severity === 'critical');
        const errorIssues = issues.filter(i => i.severity === 'error');
        const warningIssues = issues.filter(i => i.severity === 'warning');
        if (criticalIssues.length > 0) {
            result.status = 'error';
            result.valid = false;
            result.summary = `AI Chat validation FAILED: ${criticalIssues.length} critical, ${errorIssues.length} errors, ${warningIssues.length} warnings`;
            result.hint = criticalIssues[0].hint;
        }
        else if (errorIssues.length > 0) {
            result.status = 'error';
            result.valid = false;
            result.summary = `AI Chat validation issues: ${errorIssues.length} errors, ${warningIssues.length} warnings`;
            result.hint = errorIssues[0].hint;
        }
        else if (warningIssues.length > 0) {
            result.status = 'success';
            result.valid = true;
            result.summary = `AI Chat validation passed with ${warningIssues.length} warning(s)`;
        }
        else {
            result.status = 'success';
            result.valid = true;
            result.summary = 'AI Chat infrastructure validation passed';
        }
        // Add conversation summary
        if (result.conversations && result.conversations.length > 0) {
            const validModels = result.conversations.filter(c => c.modelValid).length;
            result.summary += `. Checked ${result.conversations.length} conversation(s): ${validModels} with valid models`;
        }
        // Add continuation summary
        if (result.continuationResult) {
            if (result.continuationResult.success) {
                result.summary += `. Conversation continued successfully (${result.continuationResult.messagesLoaded} messages loaded, ${result.continuationResult.responseTime}ms)`;
                if (result.continuationResult.multiStepExecution) {
                    result.summary += ` - Multi-step: ${result.continuationResult.multiStepExecution.toolCallsExecuted} tool calls in ${result.continuationResult.multiStepExecution.steps} steps`;
                }
            }
            else {
                result.summary += `. Conversation continuation FAILED: ${result.continuationResult.error}`;
            }
        }
        return result;
    }
    catch (error) {
        return {
            status: 'error',
            valid: false,
            issues: [{
                    type: 'schema_missing',
                    severity: 'critical',
                    message: `Database error: ${error instanceof Error ? error.message : String(error)}`,
                    hint: 'Check database connection string and permissions',
                }],
            summary: 'AI Chat validation failed due to database error',
            hint: 'Verify DATABASE_URL and database connectivity',
        };
    }
}
//# sourceMappingURL=validate_ai_chat.js.map