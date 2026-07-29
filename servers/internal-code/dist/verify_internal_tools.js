import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
async function main() {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index-internal-code.js"],
    });
    const client = new Client({
        name: "test-client-internal",
        version: "1.0.0",
    }, {
        capabilities: {},
    });
    await client.connect(transport);
    console.log("Connected to Internal Code MCP Server");
    // 1. List Tools
    console.log("\n--- Listing Tools ---");
    const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
    console.log("Tools:", tools.tools.map((t) => t.name).join(", "));
    // Helper to parse and log result
    const logResult = (toolName, result) => {
        console.log(`\n--- Result for ${toolName} ---`);
        if (result.content && result.content[0] && result.content[0].type === "text") {
            try {
                const parsed = JSON.parse(result.content[0].text);
                console.log(JSON.stringify(parsed, null, 2));
            }
            catch (e) {
                console.log("Raw Text (Not JSON):", result.content[0].text);
            }
        }
        else {
            console.log("Result:", JSON.stringify(result, null, 2));
        }
    };
    // 2. Test validate_import_tree_batch
    console.log("\n--- Testing validate_import_tree_batch ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "validate_import_tree_batch",
                arguments: {
                    filePaths: [
                        resolve("src/index-internal-code.ts"),
                        // Add a non-existent file to test error handling
                        resolve("src/non-existent.ts")
                    ],
                    recursive: false,
                    checkTypes: true
                },
            }
        }, CallToolResultSchema);
        logResult("validate_import_tree_batch", result);
    }
    catch (error) {
        console.error("Error calling validate_import_tree_batch:", error);
    }
    // 3. Test validate_symbol_usage_batch
    console.log("\n--- Testing validate_symbol_usage_batch ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "validate_symbol_usage_batch",
                arguments: {
                    symbols: [
                        {
                            filePath: resolve("src/index-internal-code.ts"),
                            symbolName: "Server"
                        },
                        {
                            filePath: resolve("src/index-internal-code.ts"),
                            symbolName: "NonExistentSymbol"
                        }
                    ]
                },
            }
        }, CallToolResultSchema);
        logResult("validate_symbol_usage_batch", result);
    }
    catch (error) {
        console.error("Error calling validate_symbol_usage_batch:", error);
    }
    await client.close();
}
main().catch(console.error);
//# sourceMappingURL=verify_internal_tools.js.map