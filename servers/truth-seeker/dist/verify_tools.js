import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
    // 2. Test audit_connectivity
    console.log("\n--- Testing audit_connectivity ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "audit_connectivity",
                arguments: {
                    resourceType: "db",
                    connectionString: "postgres://user:pass@localhost:5432/db", // Dummy string
                },
            }
        }, CallToolResultSchema);
        logResult("audit_connectivity", result);
    }
    catch (error) {
        console.error("Error calling audit_connectivity:", error);
    }
    // 3. Test generate_reproduction_script
    console.log("\n--- Testing generate_reproduction_script ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "generate_reproduction_script",
                arguments: {
                    issueDescription: "Test Issue",
                    sql: "SELECT * FROM users",
                    steps: ["Step 1", "Step 2"],
                },
            }
        }, CallToolResultSchema);
        logResult("generate_reproduction_script", result);
    }
    catch (error) {
        console.error("Error calling generate_reproduction_script:", error);
    }
    // 4. Test simulate_transaction
    console.log("\n--- Testing simulate_transaction ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "simulate_transaction",
                arguments: {
                    sql: "SELECT 1",
                    connectionString: "postgres://user:pass@localhost:5432/db", // Dummy string
                },
            }
        }, CallToolResultSchema);
        logResult("simulate_transaction", result);
    }
    catch (error) {
        console.error("Error calling simulate_transaction:", error);
    }
    // 5. Test validate_api_contract
    console.log("\n--- Testing validate_api_contract ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "validate_api_contract",
                arguments: {
                    url: "https://jsonplaceholder.typicode.com/todos/1",
                    method: "GET",
                    expectedResponseSchema: { userId: "number", id: "number", title: "string", completed: "boolean" }
                },
            }
        }, CallToolResultSchema);
        logResult("validate_api_contract", result);
    }
    catch (error) {
        console.error("Error calling validate_api_contract:", error);
    }
    // 6. Test simulate_webhook_event
    console.log("\n--- Testing simulate_webhook_event ---");
    try {
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "simulate_webhook_event",
                arguments: {
                    webhookUrl: "http://localhost:9999/webhook", // Dummy URL
                    payload: { event: "test_event", data: { id: 123 } },
                    signatureHeader: { name: "X-Signature", value: "sha256=123456" }
                },
            }
        }, CallToolResultSchema);
        logResult("simulate_webhook_event", result);
    }
    catch (error) {
        console.error("Error calling simulate_webhook_event:", error);
    }
    // 7. Test validate_schema_contracts_batch
    console.log("\nTesting validate_schema_contracts_batch...");
    try {
        const batchSchemaResult = await client.request({
            method: "tools/call",
            params: {
                name: "validate_schema_contracts_batch",
                arguments: {
                    tables: [
                        {
                            tableName: "users",
                            expectedSchema: {
                                id: "integer",
                                username: "character varying",
                                email: "character varying",
                                created_at: "timestamp without time zone",
                            },
                        },
                        {
                            tableName: "posts",
                            expectedSchema: {
                                id: "integer",
                                user_id: "integer",
                                title: "character varying",
                                content: "text",
                            },
                        },
                    ],
                    checkForeignKeys: true,
                },
            }
        }, CallToolResultSchema);
        logResult("validate_schema_contracts_batch", batchSchemaResult);
    }
    catch (error) {
        console.error("Error calling validate_schema_contracts_batch:", error);
    }
    // 8. Test validate_api_contracts_batch
    console.log("\nTesting validate_api_contracts_batch...");
    try {
        const batchApiResult = await client.request({
            method: "tools/call",
            params: {
                name: "validate_api_contracts_batch",
                arguments: {
                    endpoints: [
                        {
                            url: "https://jsonplaceholder.typicode.com/posts/1",
                            method: "GET",
                            expectedResponseSchema: { userId: "number", id: "number", title: "string", body: "string" },
                        },
                        {
                            url: "https://jsonplaceholder.typicode.com/users/1",
                            method: "GET",
                            expectedResponseSchema: { id: "number", name: "string", username: "string", email: "string" },
                        },
                    ],
                    parallel: true,
                },
            }
        }, CallToolResultSchema);
        logResult("validate_api_contracts_batch", batchApiResult);
    }
    catch (error) {
        console.error("Error calling validate_api_contracts_batch:", error);
    }
    // 9. Test audit_connectivity_batch
    console.log("\nTesting audit_connectivity_batch...");
    try {
        const batchConnectivityResult = await client.request({
            method: "tools/call",
            params: {
                name: "audit_connectivity_batch",
                arguments: {
                    resources: [
                        { type: "db", connectionString: process.env.DATABASE_URL || "" },
                        { type: "db", connectionString: "postgres://invalid:invalid@localhost:5432/invalid" }, // Expected failure
                    ],
                    parallel: true,
                },
            }
        }, CallToolResultSchema);
        logResult("audit_connectivity_batch", batchConnectivityResult);
    }
    catch (error) {
        console.error("Error calling audit_connectivity_batch:", error);
    }
    await client.close();
}
main().catch(console.error);
//# sourceMappingURL=verify_tools.js.map