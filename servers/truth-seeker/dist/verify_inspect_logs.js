import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
const TEST_LOG_FILE = resolve("test_server.log");
async function main() {
    // Create a dummy log file
    const logContent = [
        "2023-10-27 10:00:00 [INFO] Server started",
        "2023-10-27 10:00:01 [DEBUG] Init modules",
        "2023-10-27 10:00:02 [ERROR] Connection failed",
        "2023-10-27 10:00:03 [INFO] Retrying...",
        "2023-10-27 10:00:04 [INFO] Connected"
    ].join('\n');
    writeFileSync(TEST_LOG_FILE, logContent);
    try {
        const transport = new StdioClientTransport({
            command: "node",
            args: ["dist/index.js"],
        });
        const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
        console.log("Connected to MCP Server");
        // Call inspect_server_logs
        console.log("Calling inspect_server_logs...");
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "inspect_server_logs",
                arguments: {
                    logFilePath: TEST_LOG_FILE,
                    lines: 3,
                    filter: "INFO"
                }
            }
        }, CallToolResultSchema);
        console.log("Tool Result:", JSON.stringify(result, null, 2));
        const content = JSON.parse(result.content[0].text);
        // Verify results
        // The tool filters FIRST, then slices.
        // Total INFO lines: 3.
        // Slice last 3: 3 lines.
        if (content.status === 'success' && content.returnedLines === 3) {
            console.log("SUCCESS: inspect_server_logs verification passed.");
        }
        else {
            console.error("FAILURE: inspect_server_logs verification failed.", content);
            process.exit(1);
        }
        await client.close();
    }
    catch (error) {
        console.error("Error during verification:", error);
        process.exit(1);
    }
    finally {
        try {
            unlinkSync(TEST_LOG_FILE);
        }
        catch (e) { }
    }
}
main();
//# sourceMappingURL=verify_inspect_logs.js.map