import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from 'path';
async function main() {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    try {
        await client.connect(transport);
        console.log("Connected to MCP Server");
        const handlerPath = resolve("src/mock_json_route.ts");
        const typeFilePath = resolve("src/test_types.ts");
        // Test 1: validate_api_contract (GET)
        console.log("\n--- Test 1: validate_api_contract (GET) ---");
        const result1 = await client.request({
            method: "tools/call",
            params: {
                name: "validate_api_contract",
                arguments: {
                    handlerPath,
                    method: "GET",
                    expectedResponseSchema: {
                        type: "object",
                        properties: {
                            id: { type: "number" },
                            name: { type: "string" },
                            email: { type: "string", format: "email" }
                        },
                        required: ["id", "name", "email"]
                    }
                }
            }
        }, CallToolResultSchema);
        console.log("Result:", JSON.stringify(result1, null, 2));
        const content1 = JSON.parse(result1.content[0].text);
        if (content1.status !== 'success' || !content1.match) {
            throw new Error("Test 1 Failed");
        }
        // Test 2: validate_api_contract (POST)
        console.log("\n--- Test 2: validate_api_contract (POST) ---");
        const result2 = await client.request({
            method: "tools/call",
            params: {
                name: "validate_api_contract",
                arguments: {
                    handlerPath,
                    method: "POST",
                    body: { foo: "bar" },
                    expectedResponseSchema: {
                        type: "object",
                        properties: {
                            status: { type: "string" },
                            received: { type: "object" }
                        },
                        required: ["status", "received"]
                    }
                }
            }
        }, CallToolResultSchema);
        console.log("Result:", JSON.stringify(result2, null, 2));
        const content2 = JSON.parse(result2.content[0].text);
        if (content2.status !== 'success' || !content2.match) {
            throw new Error("Test 2 Failed");
        }
        // Test 3: validate_api_types (GET)
        console.log("\n--- Test 3: validate_api_types (GET) ---");
        const result3 = await client.request({
            method: "tools/call",
            params: {
                name: "validate_api_types",
                arguments: {
                    handlerPath,
                    method: "GET",
                    typeFilePath,
                    typeName: "UserProfile"
                }
            }
        }, CallToolResultSchema);
        console.log("Result:", JSON.stringify(result3, null, 2));
        const content3 = JSON.parse(result3.content[0].text);
        if (content3.status !== 'success' || !content3.valid) {
            throw new Error("Test 3 Failed");
        }
        console.log("\nSUCCESS: All HTTP bypass tests passed.");
    }
    catch (error) {
        console.error("Error during verification:", error);
        process.exit(1);
    }
    finally {
        await client.close();
    }
}
main();
//# sourceMappingURL=verify_http_bypass.js.map