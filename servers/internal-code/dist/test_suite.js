#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
class TestRunner {
    client = null;
    passed = 0;
    failed = 0;
    results = [];
    async setup() {
        const transport = new StdioClientTransport({
            command: "node",
            args: [resolve(__dirname, "index-internal-code.js")],
        });
        this.client = new Client({ name: "internal-code-test-client", version: "1.0.0" }, { capabilities: {} });
        await this.client.connect(transport);
        console.log("✅ Connected to Internal Code MCP Server\n");
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
        const srcDir = resolve(testDir, "src");
        mkdirSync(srcDir, { recursive: true });
        // Test 1: validate_import_tree - Valid imports
        writeFileSync(resolve(srcDir, "utils.ts"), "export const helper = () => 'test';");
        writeFileSync(resolve(srcDir, "index.ts"), "import { helper } from './utils';\nconsole.log(helper());");
        await runner.runTest({
            name: "validate_import_tree - Valid imports",
            toolName: "validate_import_tree",
            args: {
                filePath: resolve(srcDir, "index.ts"),
                checkTypes: true,
            },
            expectedStatus: "success",
            validate: (result) => result.valid === true && result.issues.length === 0,
        });
        // Test 2: validate_import_tree - Missing import with fuzzy suggestions
        writeFileSync(resolve(srcDir, "broken.ts"), "import { missing } from './nonexistent';");
        await runner.runTest({
            name: "validate_import_tree - Missing import with suggestions",
            toolName: "validate_import_tree",
            args: {
                filePath: resolve(srcDir, "broken.ts"),
                projectRoot: testDir,
            },
            expectedStatus: "error",
            validate: (result) => {
                const issue = result.issues?.[0];
                return (issue?.type === "missing_import" &&
                    issue?.autoFixAvailable === true &&
                    Array.isArray(issue?.suggestions));
            },
        });
        // Test 3: validate_import_tree - Missing export
        writeFileSync(resolve(srcDir, "exports.ts"), "export const foo = 'bar';");
        writeFileSync(resolve(srcDir, "importer.ts"), "import { wrongSymbol } from './exports';");
        await runner.runTest({
            name: "validate_import_tree - Missing export symbol",
            toolName: "validate_import_tree",
            args: {
                filePath: resolve(srcDir, "importer.ts"),
                checkTypes: true,
            },
            expectedStatus: "error",
            validate: (result) => result.issues?.some((i) => i.type === "missing_export"),
        });
        // Test 4: validate_symbol_usage - Symbol found and used
        writeFileSync(resolve(srcDir, "service.ts"), "import { helper } from './utils';\nconst result = helper();");
        await runner.runTest({
            name: "validate_symbol_usage - Symbol exists and used",
            toolName: "validate_symbol_usage",
            args: {
                filePath: resolve(srcDir, "service.ts"),
                symbolName: "helper",
            },
            expectedStatus: "success",
            validate: (result) => result.found === true && result.usageCount > 0,
        });
        // Test 5: validate_symbol_usage - Symbol not imported
        await runner.runTest({
            name: "validate_symbol_usage - Symbol not imported",
            toolName: "validate_symbol_usage",
            args: {
                filePath: resolve(srcDir, "service.ts"),
                symbolName: "nonExistentSymbol",
            },
            expectedStatus: "error",
            validate: (result) => result.found === false,
        });
        // Test 6: validate_config_references - Valid config
        writeFileSync(resolve(testDir, "config.json"), JSON.stringify({
            plugins: ["utils", "service"],
        }));
        await runner.runTest({
            name: "validate_config_references - Valid plugin references",
            toolName: "validate_config_references",
            args: {
                configPath: resolve(testDir, "config.json"),
                referenceType: "plugins",
                codebasePath: srcDir,
            },
            expectedStatus: "success",
            validate: (result) => result.valid === true,
        });
        // Test 7: validate_config_references - Missing reference
        writeFileSync(resolve(testDir, "bad-config.json"), JSON.stringify({
            plugins: ["utils", "missingPlugin"],
        }));
        await runner.runTest({
            name: "validate_config_references - Missing plugin",
            toolName: "validate_config_references",
            args: {
                configPath: resolve(testDir, "bad-config.json"),
                referenceType: "plugins",
                codebasePath: srcDir,
            },
            expectedStatus: "error",
            validate: (result) => result.valid === false &&
                result.issues?.some((i) => i.type === "missing_reference"),
        });
        // Test 8: Batch validation
        await runner.runTest({
            name: "validate_import_tree_batch - Multiple files",
            toolName: "validate_import_tree_batch",
            args: {
                filePaths: [
                    resolve(srcDir, "index.ts"),
                    resolve(srcDir, "service.ts"),
                ],
                checkTypes: true,
            },
            expectedStatus: "success",
            validate: (result) => result.results && result.results.length === 2,
        });
        // Test 9: validate_symbol_usage_batch
        await runner.runTest({
            name: "validate_symbol_usage_batch - Multiple symbols",
            toolName: "validate_symbol_usage_batch",
            args: {
                symbols: [
                    { filePath: resolve(srcDir, "service.ts"), symbolName: "helper" },
                ],
            },
            expectedStatus: "success",
            validate: (result) => result.summary.includes("symbols"),
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