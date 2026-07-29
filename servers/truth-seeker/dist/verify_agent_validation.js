import http from 'http';
import axios from 'axios';
const PORT = 3456;
// Mock Streaming Server
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        const chunks = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"London\\"}"}}]}}]}\n\n',
            'data: [DONE]\n\n'
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
        }, 100);
    }
    else {
        res.writeHead(404);
        res.end();
    }
});
server.listen(PORT, async () => {
    console.log(`Mock server running on port ${PORT}`);
    try {
        console.log("Testing streaming validation logic...");
        const response = await axios({
            url: `http://localhost:${PORT}/chat`,
            method: 'POST',
            data: {},
            headers: { "Content-Type": "application/json" },
            responseType: 'stream'
        });
        let fullContent = "";
        let toolCalls = [];
        const stream = response.data;
        for await (const chunk of stream) {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data.trim() === '[DONE]')
                        continue;
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.choices?.[0]?.delta?.content) {
                            fullContent += parsed.choices[0].delta.content;
                        }
                        if (parsed.choices?.[0]?.delta?.tool_calls) {
                            toolCalls.push(...parsed.choices[0].delta.tool_calls);
                        }
                    }
                    catch (e) {
                        // Ignore
                    }
                }
            }
        }
        console.log("Full Content:", fullContent);
        console.log("Tool Calls:", JSON.stringify(toolCalls, null, 2));
        if (fullContent === "Hello world" && toolCalls.length === 1 && toolCalls[0].function.name === "get_weather") {
            console.log("SUCCESS: Streaming logic verified.");
        }
        else {
            console.error("FAILURE: Logic did not produce expected output.");
            process.exit(1);
        }
    }
    catch (error) {
        console.error("Error during test:", error);
        process.exit(1);
    }
    finally {
        server.close();
    }
});
//# sourceMappingURL=verify_agent_validation.js.map