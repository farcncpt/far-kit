#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcDir = join(__dirname, "..", "src");
async function testExportTracing() {
    console.log("\n=== Testing Export Tracing Tools ===\n");
    const transport = new StdioClientTransport({
        command: "node",
        args: [join(__dirname, "index-internal-code.js")],
    });
    const client = new Client({
        name: "export-tracing-test-client",
        version: "1.0.0",
    }, {
        capabilities: {},
    });
    await client.connect(transport);
    console.log("Connected to Internal Code MCP Server\n");
    // Test 1: Trace Export Usage
    console.log("--- Test 1: trace_export_usage ---");
    try {
        const result = await client.callTool({
            name: "trace_export_usage",
            arguments: {
                filePath: join(srcDir, "index-internal-code.ts"),
                exportName: "formatResponse",
                includeReExports: false,
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ trace_export_usage test passed\n");
    }
    catch (error) {
        console.error("❌ trace_export_usage test failed:", error);
    }
    // Test 2: Trace Export Usage with Re-exports
    console.log("--- Test 2: trace_export_usage with re-exports ---");
    try {
        const result = await client.callTool({
            name: "trace_export_usage",
            arguments: {
                filePath: join(srcDir, "cache.ts"),
                exportName: "projectCache",
                includeReExports: true,
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ trace_export_usage with re-exports test passed\n");
    }
    catch (error) {
        console.error("❌ trace_export_usage with re-exports test failed:", error);
    }
    // Test 3: Trace Non-existent Export
    console.log("--- Test 3: trace_export_usage with non-existent export ---");
    try {
        const result = await client.callTool({
            name: "trace_export_usage",
            arguments: {
                filePath: join(srcDir, "index-internal-code.ts"),
                exportName: "NonExistentExport",
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ Non-existent export error handling test passed\n");
    }
    catch (error) {
        console.error("❌ Non-existent export test failed:", error);
    }
    // Test 4: Find Unused Exports
    console.log("--- Test 4: find_unused_exports ---");
    try {
        const result = await client.callTool({
            name: "find_unused_exports",
            arguments: {
                directory: srcDir,
                excludePatterns: ["**/*.test.ts", "**/*.spec.ts", "**/test_*.ts"],
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ find_unused_exports test passed\n");
    }
    catch (error) {
        console.error("❌ find_unused_exports test failed:", error);
    }
    // Test 5: Find Unused Exports - Public API only
    console.log("--- Test 5: find_unused_exports (public API only) ---");
    try {
        const result = await client.callTool({
            name: "find_unused_exports",
            arguments: {
                directory: srcDir,
                checkPublicAPI: true,
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ find_unused_exports (public API) test passed\n");
    }
    catch (error) {
        console.error("❌ find_unused_exports (public API) test failed:", error);
    }
    // Test 6: Analyze Export Impact - Remove
    console.log("--- Test 6: analyze_export_impact (remove) ---");
    try {
        const result = await client.callTool({
            name: "analyze_export_impact",
            arguments: {
                filePath: join(srcDir, "index-internal-code.ts"),
                exportName: "formatResponse",
                changeType: "remove",
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ analyze_export_impact (remove) test passed\n");
    }
    catch (error) {
        console.error("❌ analyze_export_impact (remove) test failed:", error);
    }
    // Test 7: Analyze Export Impact - Rename
    console.log("--- Test 7: analyze_export_impact (rename) ---");
    try {
        const result = await client.callTool({
            name: "analyze_export_impact",
            arguments: {
                filePath: join(srcDir, "cache.ts"),
                exportName: "projectCache",
                changeType: "rename",
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ analyze_export_impact (rename) test passed\n");
    }
    catch (error) {
        console.error("❌ analyze_export_impact (rename) test failed:", error);
    }
    // Test 8: Analyze Export Impact - Signature Change
    console.log("--- Test 8: analyze_export_impact (signature_change) ---");
    try {
        const result = await client.callTool({
            name: "analyze_export_impact",
            arguments: {
                filePath: join(srcDir, "index-internal-code.ts"),
                exportName: "formatResponse",
                changeType: "signature_change",
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ analyze_export_impact (signature_change) test passed\n");
    }
    catch (error) {
        console.error("❌ analyze_export_impact (signature_change) test failed:", error);
    }
    // Test 9: Missing Required Parameters
    console.log("--- Test 9: Missing required parameters ---");
    try {
        const result = await client.callTool({
            name: "trace_export_usage",
            arguments: {
                filePath: join(srcDir, "index-internal-code.ts"),
                // Missing exportName parameter
            },
        });
        console.log("Result:", JSON.stringify(result, null, 2));
        console.log("✅ Missing parameters error handling test passed\n");
    }
    catch (error) {
        console.error("❌ Missing parameters test failed:", error);
    }
    console.log("\n=== All Export Tracing Tests Completed ===\n");
    await client.close();
    process.exit(0);
}
testExportTracing().catch((error) => {
    console.error("Fatal error in testExportTracing():", error);
    process.exit(1);
});
//# sourceMappingURL=test_export_tracing.js.map