import { z } from "zod";
import { readFileSync, statSync, existsSync } from "fs";
import { resolve } from "path";
export const inspectServerLogsSchema = z.object({
    logFilePath: z.string().describe("Path to the log file to inspect"),
    lines: z.number().default(50).describe("Number of recent lines to retrieve"),
    filter: z.string().optional().describe("Optional text to filter lines by (grep-like)")
});
export async function inspectServerLogs(args) {
    const { logFilePath, lines, filter } = args;
    try {
        const absolutePath = resolve(logFilePath);
        if (!existsSync(absolutePath)) {
            return {
                status: "error",
                message: `Log file not found: ${logFilePath}`,
                hint: "Ensure the server is writing to a log file and the path is correct"
            };
        }
        const stats = statSync(absolutePath);
        if (stats.size === 0) {
            return {
                status: "success",
                logs: [],
                summary: "Log file is empty"
            };
        }
        // Read file (simple implementation: read whole file then slice, 
        // for huge files we'd want to read from end, but for dev logs this is usually fine)
        // If file is > 10MB, warn or read only last chunk.
        let content = "";
        if (stats.size > 10 * 1024 * 1024) {
            // Read last 1MB
            const buffer = Buffer.alloc(1024 * 1024);
            const fd = await import('fs').then(fs => fs.openSync(absolutePath, 'r'));
            await import('fs').then(fs => fs.readSync(fd, buffer, 0, buffer.length, stats.size - buffer.length));
            content = buffer.toString('utf-8');
        }
        else {
            content = readFileSync(absolutePath, 'utf-8');
        }
        let logLines = content.split('\n');
        // Filter
        if (filter) {
            logLines = logLines.filter(line => line.includes(filter));
        }
        // Get last N lines
        const recentLogs = logLines.slice(-lines);
        return {
            status: "success",
            logFilePath,
            lineCount: recentLogs.length,
            logs: recentLogs,
            summary: `Retrieved ${recentLogs.length} lines from ${logFilePath}`
        };
    }
    catch (error) {
        return {
            status: "error",
            message: `Failed to read logs: ${error.message}`
        };
    }
}
//# sourceMappingURL=inspect_server_logs.js.map