/**
 * MCP Server backed by a persistent Rust refactor-runtime process.
 *
 * Spawns `refactor-runtime serve <projectRoot>` once and communicates via
 * JSON-line protocol over stdin/stdout. Graph stays in memory across calls.
 * Expected latency: <500ms per tool call after initial scan.
 */
export {};
//# sourceMappingURL=server-rust.d.ts.map