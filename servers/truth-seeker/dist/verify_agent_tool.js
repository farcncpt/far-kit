import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import http from 'http';
const MOCK_PORT = 3457;
// 1. Start Mock Agent Server
const mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        // Simulate Vercel AI SDK Data Stream
        // 0: text
        // 9: tool call (simplified for this test, usually it's complex JSON)
        const chunks = [
            '0:"Hello"\n',
            '0:" world"\n',
            // Simulating a tool call in a way our simple parser might catch or just text for now
            // Our current parser in index.ts handles 0:"text"
            // Let's test text content first
        ];
        let i = 0;
        const interval = setInterval(() => {
            if (i < chunks.length) {
                res.write(chunks[i]);
                i++;
            }
            else {
                clearInterval(interval);
                res.end();
            }
        }, 50);
    }
    else {
        res.writeHead(404);
        res.end();
    }
});
mockServer.listen(MOCK_PORT, async () => {
    console.log(`Mock Agent Server running on port ${MOCK_PORT}`);
    try {
        // 2. Connect to MCP Server
        const transport = new StdioClientTransport({
            command: "node",
            args: ["dist/index.js"],
        });
        const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
        console.log("Connected to MCP Server");
        // 3. Call validate_agent_conversation
        console.log("Calling validate_agent_conversation...");
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "validate_agent_conversation",
                arguments: {
                    handlerPath: "src/mock_route.ts",
                    protocol: "vercel-ai-sdk-data-stream",
                    conversation: [
                        {
                            role: "user",
                            content: "Hello",
                            expect: {
                            // content: "Hello world"
                            }
                        }
                    ]
                }
            }
        }, CallToolResultSchema);
        console.log("Tool Result:", JSON.stringify(result, null, 2));
        // 4. Verify Result
        const content = JSON.parse(result.content[0].text);
        if (content.summary === 'All steps passed') {
            console.log("SUCCESS: Tool verification passed.");
        }
        else {
            console.error("FAILURE: Tool verification failed.");
            process.exit(1);
        }
        await client.close();
    }
    catch (error) {
        console.error("Error during verification:", error);
        process.exit(1);
    }
    finally {
        mockServer.close();
    }
});
//# sourceMappingURL=verify_agent_tool.js.map