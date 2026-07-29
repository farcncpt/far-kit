import { Project, Node } from "ts-morph";
import { z } from "zod";
export const validateToolUsageSchema = z.object({
    filePath: z.string().describe("Path to the file containing tool definitions"),
    projectRoot: z.string().optional().describe("Optional project root for tsconfig resolution")
});
export async function validateToolUsage(args) {
    const { filePath, projectRoot } = args;
    const issues = [];
    try {
        const project = new Project({
            skipAddingFilesFromTsConfig: true,
        });
        project.addSourceFileAtPath(filePath);
        const sourceFile = project.getSourceFile(filePath);
        if (!sourceFile) {
            return {
                status: "error",
                message: `File not found: ${filePath}`
            };
        }
        // Find all 'tool' calls
        // Looking for: export const myTool = tool({ ... })
        const variableDeclarations = sourceFile.getVariableDeclarations();
        for (const varDecl of variableDeclarations) {
            const initializer = varDecl.getInitializer();
            if (initializer && Node.isCallExpression(initializer)) {
                const expression = initializer.getExpression();
                if (Node.isIdentifier(expression) && expression.getText() === "tool") {
                    const toolName = varDecl.getName();
                    const args = initializer.getArguments();
                    if (args.length === 0) {
                        issues.push({
                            tool: toolName,
                            type: "missing_arguments",
                            message: "tool() called without arguments"
                        });
                        continue;
                    }
                    const configObj = args[0];
                    if (!Node.isObjectLiteralExpression(configObj)) {
                        issues.push({
                            tool: toolName,
                            type: "invalid_config",
                            message: "tool() argument must be an object literal"
                        });
                        continue;
                    }
                    // Check properties
                    const descriptionProp = configObj.getProperty("description");
                    const inputSchemaProp = configObj.getProperty("inputSchema");
                    const executeProp = configObj.getProperty("execute");
                    if (!descriptionProp) {
                        issues.push({
                            tool: toolName,
                            type: "missing_description",
                            message: "Tool definition missing 'description'"
                        });
                    }
                    if (!inputSchemaProp) {
                        issues.push({
                            tool: toolName,
                            type: "missing_schema",
                            message: "Tool definition missing 'inputSchema'"
                        });
                    }
                    if (!executeProp) {
                        issues.push({
                            tool: toolName,
                            type: "missing_execute",
                            message: "Tool definition missing 'execute' function"
                        });
                    }
                    else {
                        // Validate execute function signature matches schema (basic check)
                        // This is hard to do perfectly statically, but we can check if it's an async function
                        if (Node.isPropertyAssignment(executeProp)) {
                            const initializer = executeProp.getInitializer();
                            if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
                                if (!initializer.isAsync()) {
                                    issues.push({
                                        tool: toolName,
                                        type: "sync_execute",
                                        message: "'execute' function should be async"
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        return {
            status: issues.length > 0 ? "error" : "success",
            valid: issues.length === 0,
            issues,
            summary: issues.length > 0
                ? `Found ${issues.length} issues in tool definitions`
                : "All tool definitions appear valid"
        };
    }
    catch (error) {
        return {
            status: "error",
            message: `Analysis failed: ${error.message}`
        };
    }
}
//# sourceMappingURL=validate_tool_usage.js.map