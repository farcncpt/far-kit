import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import dotenv from "dotenv";
import { Client as PgClient } from "pg";
dotenv.config();
async function main() {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
    });
    const client = new Client({
        name: "cross-layer-test-client",
        version: "1.0.0",
    }, {
        capabilities: {},
    });
    await client.connect(transport);
    console.log("Connected to MCP Server");
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
    // DB setup for testing
    const pgClient = new PgClient({
        connectionString: process.env.DATABASE_URL,
    });
    let dbConnected = false;
    try {
        await pgClient.connect();
        console.log("Connected to database for verification setup.");
        dbConnected = true;
        // Setup: Create dummy table
        await pgClient.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
    }
    catch (error) {
        console.warn("Skipping DB setup and ORM test due to connection error:", error);
    }
    // 1. Test validate_orm_model
    if (dbConnected) {
        console.log("\n--- Testing validate_orm_model ---");
        try {
            const modelPath = path.resolve(process.cwd(), "src/test_model.ts");
            console.log("Testing model at:", modelPath);
            const result = await client.request({
                method: "tools/call",
                params: {
                    name: "validate_orm_model",
                    arguments: {
                        modelFilePath: modelPath,
                        tableName: "users",
                        connectionString: process.env.DATABASE_URL,
                    },
                }
            }, CallToolResultSchema);
            logResult("validate_orm_model", result);
        }
        catch (error) {
            console.error("Error calling validate_orm_model:", error);
        }
    }
    else {
        console.log("\n--- Skipping validate_orm_model (No DB Connection) ---");
    }
    // 2. Test validate_api_types
    console.log("\n--- Testing validate_api_types ---");
    try {
        const typePath = path.resolve(process.cwd(), "src/test_types.ts");
        console.log("Testing type at:", typePath);
        const result = await client.request({
            method: "tools/call",
            params: {
                name: "validate_api_types",
                arguments: {
                    typeFilePath: typePath,
                    typeName: "Todo",
                    apiUrl: "https://jsonplaceholder.typicode.com/todos/1",
                    method: "GET",
                },
            }
        }, CallToolResultSchema);
        logResult("validate_api_types", result);
    }
    catch (error) {
        console.error("Error calling validate_api_types:", error);
    }
    // Cleanup
    if (dbConnected) {
        try {
            await pgClient.query("DROP TABLE IF EXISTS users");
            await pgClient.end();
        }
        catch (e) {
            console.error("Error during cleanup:", e);
        }
    }
    await client.close();
}
main().catch(console.error);
//# sourceMappingURL=verify_cross_layer.js.map