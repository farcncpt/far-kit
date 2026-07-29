import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
async function main() {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
    });
    const client = new Client({
        name: "test-client",
        version: "1.0.0",
    }, {
        capabilities: {},
    });
    await client.connect(transport);
    console.log("Connected to MCP Server");
    const result = await client.request({ method: "tools/list" }, ListToolsResultSchema);
    console.log("Available Tools:", result.tools.map((t) => t.name));
    await client.close();
}
main().catch(console.error);
//# sourceMappingURL=test_client.js.map