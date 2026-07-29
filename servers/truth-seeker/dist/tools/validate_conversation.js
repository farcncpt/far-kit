import axios from 'axios';
import { z } from 'zod';
import { Client } from 'pg';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
class StreamParser {
    buffer = '';
    parse(chunk) {
        this.buffer += chunk;
        const parts = [];
        // Split by newline, but handle incomplete lines
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep the last incomplete line in buffer
        for (const line of lines) {
            if (!line.trim())
                continue;
            // Vercel AI SDK Data Stream Protocol: index:content
            const match = line.match(/^(\d+):(.*)$/);
            if (!match) {
                parts.push({ type: 'unknown', content: line });
                continue;
            }
            const [, typeStr, contentStr] = match;
            const type = parseInt(typeStr, 10);
            try {
                // 0: text
                if (type === 0) {
                    // JSON string encoded text
                    const content = JSON.parse(contentStr);
                    parts.push({ type: 'text', content });
                }
                // 9: tool_call (start/full?) - AI SDK 3.3+ uses complex protocol
                // Simplified parsing for common "9" type which is often the tool call payload
                else if (type === 9) {
                    const content = JSON.parse(contentStr);
                    // Identifying tool calls in the stream
                    if (content.toolCallId && content.toolName) {
                        parts.push({
                            type: 'tool_call',
                            toolCallId: content.toolCallId,
                            toolName: content.toolName,
                            args: content.args
                        });
                    }
                }
                // e: error
                else if (line.startsWith('e:')) {
                    const content = JSON.parse(line.substring(2));
                    parts.push({ type: 'error', content });
                }
            }
            catch (e) {
                console.warn('Failed to parse stream line:', line, e);
                parts.push({ type: 'unknown', content: line });
            }
        }
        return parts;
    }
}
// --- Tool Implementation ---
export const validateAgentConversationSchema = z.object({
    url: z.string().optional().describe("The API endpoint URL (e.g., http://localhost:3000/api/chat)"),
    handlerPath: z.string().optional().describe("Path to the route handler file (e.g., src/app/api/chat/route.ts) for direct execution"),
    protocol: z.enum(["vercel-ai-sdk-data-stream"]).default("vercel-ai-sdk-data-stream"),
    conversation: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
        expect: z.object({
            toolCall: z.string().optional().describe("Name of the tool expected to be called"),
            toolArgs: z.record(z.any()).optional().describe("Partial match of arguments expected"),
            dbVerification: z.object({
                table: z.string(),
                condition: z.record(z.any())
            }).optional().describe("Database verification condition")
        }).optional()
    })).describe("The conversation script to simulate and validate")
});
export async function validateAgentConversation(args) {
    const { url, handlerPath, conversation } = args;
    if (!url && !handlerPath) {
        return {
            summary: "Validation failed",
            results: [{ step: "Init", status: "error", error: "Either 'url' or 'handlerPath' must be provided." }]
        };
    }
    const results = [];
    let history = [];
    for (const step of conversation) {
        if (step.role === 'user') {
            // Prepare payload
            const payload = {
                messages: [...history, { role: 'user', content: step.content }],
                selectedChatModel: 'chat-model'
            };
            let streamData = "";
            try {
                if (handlerPath) {
                    // --- Script Execution Mode ---
                    const absoluteHandlerPath = resolve(handlerPath);
                    // Convert to file URL for ESM import compatibility on Windows
                    const handlerUrl = pathToFileURL(absoluteHandlerPath).href;
                    const scriptId = randomUUID();
                    // Use .mts to ensure ts-node treats it as ESM
                    const tempScriptPath = resolve(tmpdir(), `mcp-agent-test-${scriptId}.mts`);
                    // Generate script to invoke handler
                    // We mock the Request object and capture the response stream
                    const scriptContent = `
                        import { POST } from '${handlerUrl}';
                        
                        // Mock Request
                        const req = new Request('http://localhost/api/chat', {
                            method: 'POST',
                            body: JSON.stringify(${JSON.stringify(payload)})
                        });

                        async function run() {
                            try {
                                const res = await POST(req);
                                if (!res.body) {
                                    console.error("No response body");
                                    process.exit(1);
                                }
                                
                                const reader = res.body.getReader();
                                const decoder = new TextDecoder();
                                
                                while (true) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    process.stdout.write(decoder.decode(value));
                                }
                            } catch (error) {
                                console.error(error);
                                process.exit(1);
                            }
                        }

                        run();
                    `;
                    writeFileSync(tempScriptPath, scriptContent);
                    try {
                        // Execute script using ts-node
                        // We assume ts-node is available in the environment
                        // Use --skip-project to avoid picking up local tsconfig which might conflict with temp file location
                        // Also use --transpile-only for speed and to ignore some type errors
                        // Pass compiler options via env var to ensure NodeNext compatibility
                        const compilerOptions = {
                            module: "NodeNext",
                            moduleResolution: "NodeNext",
                            target: "ES2022",
                            esModuleInterop: true
                        };
                        streamData = execSync(`npx ts-node --skip-project --transpile-only "${tempScriptPath}"`, {
                            encoding: 'utf-8',
                            env: {
                                ...process.env,
                                TS_NODE_COMPILER_OPTIONS: JSON.stringify(compilerOptions)
                            }
                            // Note: execSync uses shell by default, quotes handle spaces cross-platform
                        });
                    }
                    catch (execError) {
                        throw new Error(`Script execution failed: ${execError.message}\nStderr: ${execError.stderr}`);
                    }
                    finally {
                        if (process.env.KEEP_TEMP_SCRIPTS !== 'true') {
                            unlinkSync(tempScriptPath);
                        }
                    }
                }
                else if (url) {
                    // --- HTTP Mode ---
                    const response = await axios.post(url, payload, {
                        responseType: 'stream'
                    });
                    // Collect stream data
                    const stream = response.data;
                    for await (const chunk of stream) {
                        streamData += chunk.toString();
                    }
                }
                const parser = new StreamParser();
                let fullText = '';
                const toolCalls = [];
                // Parse collected stream data
                const parts = parser.parse(streamData);
                for (const part of parts) {
                    if (part.type === 'text')
                        fullText += part.content;
                    if (part.type === 'tool_call')
                        toolCalls.push(part);
                }
                // Update history
                history.push({ role: 'user', content: step.content });
                history.push({ role: 'assistant', content: fullText, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
                // Validation
                if (step.expect) {
                    const validationResult = { step: step.content, status: 'pass' };
                    // 1. Validate Tool Call
                    const expect = step.expect;
                    if (expect.toolCall) {
                        const foundTool = toolCalls.find(tc => tc.toolName === expect.toolCall);
                        if (!foundTool) {
                            validationResult.status = 'fail';
                            validationResult.error = `Expected tool '${expect.toolCall}' was not called.`;
                            validationResult.actualTools = toolCalls.map(tc => tc.toolName);
                        }
                        else if (step.expect.toolArgs) {
                            // Verify args
                            let argsMatch = true;
                            for (const [key, val] of Object.entries(step.expect.toolArgs)) {
                                if (foundTool.args[key] !== val) {
                                    argsMatch = false;
                                    validationResult.status = 'fail';
                                    validationResult.error = `Tool '${step.expect.toolCall}' called with wrong args. Expected ${key}=${val}, got ${foundTool.args[key]}`;
                                }
                            }
                        }
                    }
                    // 2. Validate DB Side Effects
                    if (step.expect.dbVerification && validationResult.status === 'pass') {
                        const { table, condition } = step.expect.dbVerification;
                        // Connect to DB (assuming DATABASE_URL is available in env)
                        if (!process.env.DATABASE_URL) {
                            validationResult.status = 'fail';
                            validationResult.error = "DATABASE_URL not set, cannot verify DB state.";
                        }
                        else {
                            const client = new Client({ connectionString: process.env.DATABASE_URL });
                            await client.connect();
                            try {
                                const whereClause = Object.keys(condition).map((k, i) => `${k} = $${i + 1}`).join(' AND ');
                                const values = Object.values(condition);
                                const res = await client.query(`SELECT * FROM ${table} WHERE ${whereClause}`, values);
                                if (res.rowCount === 0) {
                                    validationResult.status = 'fail';
                                    validationResult.error = `DB Verification failed. No record found in ${table} matching ${JSON.stringify(condition)}`;
                                }
                            }
                            catch (dbErr) {
                                validationResult.status = 'fail';
                                validationResult.error = `DB Error: ${dbErr.message}`;
                            }
                            finally {
                                await client.end();
                            }
                        }
                    }
                    results.push(validationResult);
                }
            }
            catch (error) {
                results.push({
                    step: step.content,
                    status: 'error',
                    error: error.message,
                    details: error.response ? `Status: ${error.response.status}` : undefined
                });
            }
        }
    }
    return {
        summary: results.every(r => r.status === 'pass') ? 'All steps passed' : 'Validation failed',
        results
    };
}
//# sourceMappingURL=validate_conversation.js.map