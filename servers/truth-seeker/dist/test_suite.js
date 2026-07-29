#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();
class TestRunner {
    client = null;
    passed = 0;
    failed = 0;
    results = [];
    async setup() {
        const transport = new StdioClientTransport({
            command: "node",
            args: [resolve(__dirname, "index.js")],
        });
        this.client = new Client({ name: "truth-seeker-test-client", version: "1.0.0" }, { capabilities: {} });
        await this.client.connect(transport);
        console.log("✅ Connected to Truth Seeker MCP Server\n");
    }
    async runTest(test) {
        if (!this.client)
            throw new Error("Client not initialized");
        console.log(`🧪 Testing: ${test.name}`);
        try {
            const result = await this.client.request({
                method: "tools/call",
                params: {
                    name: test.toolName,
                    arguments: test.args,
                },
            }, CallToolResultSchema);
            const content = result.content[0];
            if (content.type !== "text") {
                throw new Error("Unexpected response type");
            }
            const parsed = JSON.parse(content.text);
            // Check status
            const statusMatch = parsed.status === test.expectedStatus;
            // Run custom validation if provided
            const customValid = test.validate ? test.validate(parsed) : true;
            if (statusMatch && customValid) {
                console.log(`  ✅ PASS\n`);
                this.passed++;
                this.results.push({ test: test.name, status: "PASS", result: parsed });
            }
            else {
                console.log(`  ❌ FAIL`);
                console.log(`     Expected status: ${test.expectedStatus}, Got: ${parsed.status}`);
                console.log(`     Custom validation: ${customValid}\n`);
                this.failed++;
                this.results.push({ test: test.name, status: "FAIL", result: parsed });
            }
        }
        catch (error) {
            console.log(`  ❌ ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
            this.failed++;
            this.results.push({ test: test.name, status: "ERROR", error: String(error) });
        }
    }
    printSummary() {
        console.log("\n" + "=".repeat(60));
        console.log("TEST SUMMARY");
        console.log("=".repeat(60));
        console.log(`Total: ${this.passed + this.failed}`);
        console.log(`✅ Passed: ${this.passed}`);
        console.log(`❌ Failed: ${this.failed}`);
        console.log(`Pass Rate: ${((this.passed / (this.passed + this.failed)) * 100).toFixed(1)}%`);
        console.log("=".repeat(60) + "\n");
        if (this.failed > 0) {
            console.log("Failed tests:");
            this.results
                .filter(r => r.status !== "PASS")
                .forEach(r => console.log(`  - ${r.test}`));
        }
    }
    async cleanup() {
        if (this.client) {
            await this.client.close();
        }
    }
}
async function main() {
    const runner = new TestRunner();
    try {
        await runner.setup();
        // Create test fixtures
        const testDir = resolve(__dirname, "../test-fixtures");
        mkdirSync(testDir, { recursive: true });
        // Test 1: validate_env_variables (success case)
        writeFileSync(resolve(testDir, "test.env.example"), "DATABASE_URL=\nSTRIPE_KEY=\n");
        writeFileSync(resolve(testDir, "test-code.ts"), "const db = process.env.DATABASE_URL;\nconst stripe = process.env.STRIPE_KEY;");
        await runner.runTest({
            name: "validate_env_variables - All vars documented",
            toolName: "validate_env_variables",
            args: {
                codebasePath: testDir,
                envExamplePath: resolve(testDir, "test.env.example"),
                checkHardcodedSecrets: false,
            },
            expectedStatus: "success",
            validate: (result) => result.valid === true,
        });
        // Test 2: validate_env_variables (missing documentation)
        writeFileSync(resolve(testDir, "test-code2.ts"), "const api = process.env.UNDOCUMENTED_VAR;");
        await runner.runTest({
            name: "validate_env_variables - Undocumented var",
            toolName: "validate_env_variables",
            args: {
                codebasePath: testDir,
                envExamplePath: resolve(testDir, "test.env.example"),
            },
            expectedStatus: "error",
            validate: (result) => result.issues?.some((i) => i.type === "used_but_not_documented"),
        });
        // Test 3: validate_migration_safety (safe migration)
        await runner.runTest({
            name: "validate_migration_safety - Safe migration (ADD COLUMN)",
            toolName: "validate_migration_safety",
            args: {
                migrationSql: "ALTER TABLE users ADD COLUMN new_field TEXT;",
                codebasePath: testDir,
            },
            expectedStatus: "success",
            validate: (result) => result.safe === true,
        });
        // Test 4: validate_migration_safety (unsafe migration)
        writeFileSync(resolve(testDir, "user-service.ts"), "SELECT id, legacy_field FROM users WHERE legacy_field = 'active'");
        await runner.runTest({
            name: "validate_migration_safety - Unsafe DROP COLUMN",
            toolName: "validate_migration_safety",
            args: {
                migrationSql: "ALTER TABLE users DROP COLUMN legacy_field;",
                codebasePath: testDir,
            },
            expectedStatus: "error",
            validate: (result) => result.safe === false && result.impact?.totalReferences > 0,
        });
        // Test 5: audit_connectivity (database)
        if (process.env.DATABASE_URL) {
            await runner.runTest({
                name: "audit_connectivity - Database connection",
                toolName: "audit_connectivity",
                args: {
                    resourceType: "db",
                    connectionString: process.env.DATABASE_URL,
                },
                expectedStatus: "success",
                validate: (result) => result.connected === true,
            });
        }
        else {
            console.log("⚠️  Skipping audit_connectivity test (no DATABASE_URL)\n");
        }
        // Test 6: validate_api_contract with Zod
        await runner.runTest({
            name: "validate_api_contract - Valid API response",
            toolName: "validate_api_contract",
            args: {
                url: "https://jsonplaceholder.typicode.com/todos/1",
                method: "GET",
                expectedResponseSchema: {
                    type: "object",
                    properties: {
                        userId: { type: "integer" },
                        id: { type: "integer" },
                        title: { type: "string" },
                        completed: { type: "boolean" },
                    },
                    required: ["userId", "id", "title", "completed"],
                },
            },
            expectedStatus: "success",
            validate: (result) => result.match === true && result.valid === true,
        });
        // Test 7: validate_api_contract - Schema mismatch
        await runner.runTest({
            name: "validate_api_contract - Schema mismatch",
            toolName: "validate_api_contract",
            args: {
                url: "https://jsonplaceholder.typicode.com/todos/1",
                method: "GET",
                expectedResponseSchema: {
                    type: "object",
                    properties: {
                        wrongField: { type: "string" },
                    },
                    required: ["wrongField"],
                },
            },
            expectedStatus: "error",
            validate: (result) => result.match === false && result.issues && result.issues.length > 0,
        });
        // Test 8: Batch operations
        await runner.runTest({
            name: "audit_connectivity_batch - Multiple resources",
            toolName: "audit_connectivity_batch",
            args: {
                resources: [
                    { type: "db", connectionString: process.env.DATABASE_URL || "postgresql://invalid" },
                ],
                parallel: true,
            },
            expectedStatus: "success",
            validate: (result) => result.totalResources === 1,
        });
        runner.printSummary();
        process.exit(runner.failed > 0 ? 1 : 0);
    }
    catch (error) {
        console.error("Fatal test error:", error);
        process.exit(1);
    }
    finally {
        await runner.cleanup();
    }
}
main().catch(console.error);
//# sourceMappingURL=test_suite.js.map