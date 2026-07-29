# Refactor Runtime

A deterministic code refactoring engine that uses dependency graph analysis to provide precise, auditable refactoring operations. Built in TypeScript (ts-morph) and Rust (tree-sitter).

## Architecture

```
Config Loader → Scanner → Parser → Graph Builder → Operations → Audit
     ↓              ↓         ↓          ↓              ↓          ↓
  tsconfig      Find files  AST parse  Build edges    Move/Impact  Rollback
  aliases       by glob     imports    forward+       Rewrite      Log all
  includes      patterns    exports    reverse deps   Auto-fix     changes
```

### Key Design Decision: Deterministic First, AI Second

This tool does NOT use AI for refactoring. It uses deterministic graph analysis to compute exact blast radius. AI enters only for genuinely ambiguous cases, packaged as micro-tasks (20-30 lines of context each).

**Mechanical coverage by operation:**
- File/folder move + import rewriting: 95%+
- Delete file + clean imports: 90%+
- Rename symbol across codebase: 85-90%
- Dead code elimination: 90%+
- Unused dependency detection: 85%
- Env variable drift detection: 85%
- UI audit (React/JSX): 60-70%
- Breaking change detection: 80-85%

## Project Structure

```
ts/                          # TypeScript implementation
├── src/
│   ├── config/loader.ts     # tsconfig.json parsing, path alias resolution
│   ├── core/
│   │   ├── types.ts         # All shared interfaces
│   │   ├── scanner.ts       # File discovery via glob
│   │   ├── parser.ts        # AST parsing via ts-morph (imports/exports)
│   │   └── graph.ts         # Dependency graph (forward + reverse edges)
│   ├── move/
│   │   ├── mover.ts         # computeMove, computeBulkMoves, computeFolderMove
│   │   ├── rewriter.ts      # Apply import rewrites to files on disk
│   │   └── route-scanner.ts # Next.js route detection + URL rewriting
│   ├── impact/
│   │   ├── detector.ts      # Detect signature changes (diff old vs new)
│   │   ├── tracer.ts        # Trace cascade effects through graph
│   │   ├── classifier.ts    # Classify effects by severity
│   │   ├── auto-fixer.ts    # Apply mechanical fixes
│   │   └── task-generator.ts# Generate structured tasks for AI review
│   ├── audit/
│   │   ├── logger.ts        # Record all changes for rollback
│   │   └── rollback.ts      # Undo operations from audit log
│   ├── delete/
│   │   ├── deleter.ts       # computeDelete — find and remove imports referencing deleted file
│   │   └── rewriter.ts      # Apply delete rewrites (remove import lines/specifiers)
│   ├── rename/
│   │   └── renamer.ts       # computeRename — rename exported symbol across codebase
│   ├── deadcode/
│   │   └── analyzer.ts      # findDeadCode — BFS from entry points, find unreachable files/exports
│   ├── ui-audit/
│   │   └── auditor.ts       # auditUI — missing handlers, unused state, missing keys, dead components
│   ├── deps-audit/
│   │   └── auditor.ts       # auditDeps — unused/undeclared npm dependencies
│   ├── env-audit/
│   │   └── auditor.ts       # auditEnv — env variable drift between code and .env files
│   ├── cli/
│   │   ├── commands/        # CLI command handlers (11 commands)
│   │   └── output.ts        # Formatting (table, JSON, CSV)
│   └── mcp/
│       ├── server.ts        # MCP server (stdio transport, 15 tools)
│       └── tools.ts         # Tool implementations with caching
├── tests/                   # 83 tests across 14 files
└── dist/bin/refactor-runtime.js  # CLI ENTRY POINT (not dist/src/cli/index.js)

rust/                        # Rust implementation
├── src/
│   ├── config/loader.rs     # tsconfig parsing
│   ├── core/
│   │   ├── types.rs         # Shared types (mirror of TS types)
│   │   ├── scanner.rs       # File discovery
│   │   ├── parser.rs        # AST parsing via tree-sitter
│   │   ├── graph.rs         # Dependency graph (petgraph)
│   │   └── resolver.rs      # Path resolution
│   ├── move_op/
│   │   ├── mover.rs         # Move operations (single, bulk, folder)
│   │   ├── rewriter.rs      # Apply rewrites
│   │   └── route_scanner.rs # Next.js route detection
│   ├── impact/              # Impact analysis (detector, tracer, classifier, auto_fixer, task_generator)
│   ├── delete_op/           # Delete file + clean imports
│   ├── rename_op/           # Rename symbol across codebase
│   ├── deadcode/            # Dead code detection via entry point BFS
│   ├── ui_audit/            # React/JSX UI issue detection
│   ├── deps_audit/          # Unused/undeclared npm dependency detection
│   ├── env_audit/           # Env variable drift detection
│   ├── audit/               # Audit logging + rollback
│   └── main.rs              # CLI entry point (11 commands)
└── tests/                   # 68 tests (57 unit + 11 integration)
```

## MCP Tools (15 total)

| Tool | Purpose |
|------|---------|
| `refactor_scan` | Scan codebase, build dependency graph |
| `refactor_move` | Move file or folder, rewrite all imports |
| `refactor_move_bulk` | Process multiple moves with cross-reference handling |
| `refactor_analyze_impact` | Detect signature changes, trace cascade effects |
| `refactor_auto_fix` | Apply mechanical fixes from impact report |
| `refactor_dependency_graph` | Query graph structure, circular deps, orphans |
| `refactor_dry_run` | Preview moves without applying |
| `refactor_rollback` | Undo operation via audit log |
| `refactor_scan_routes` | List all Next.js route handlers and URL paths |
| `refactor_delete` | Delete a file and auto-clean all imports referencing it |
| `refactor_rename` | Rename an exported symbol across the entire codebase |
| `refactor_dead_code` | Find unreachable dead code from entry points |
| `refactor_ui_audit` | Detect UI issues: missing handlers, unused state, missing keys |
| `refactor_deps_audit` | Find unused npm dependencies and undeclared imports |
| `refactor_env_audit` | Detect env variable drift between code and .env files |

## Development

```bash
# TypeScript
cd ts
npm install
npm run build
npm test                    # 83 tests across 14 files, ~210s on WSL (ts-morph overhead)

# Rust
cd rust
cargo build
cargo test                  # 68 tests (57 unit + 11 integration), <1s

# CLI (11 commands)
node ts/dist/bin/refactor-runtime.js scan /path/to/project
node ts/dist/bin/refactor-runtime.js move src/old.ts src/new.ts --dry-run
node ts/dist/bin/refactor-runtime.js delete src/unused.ts --dry-run
node ts/dist/bin/refactor-runtime.js rename src/lib.ts oldFunc newFunc --dry-run
node ts/dist/bin/refactor-runtime.js dead-code /path/to/project --entry-points src/index.ts
node ts/dist/bin/refactor-runtime.js ui-audit /path/to/project
node ts/dist/bin/refactor-runtime.js deps-audit /path/to/project
node ts/dist/bin/refactor-runtime.js env-audit /path/to/project

# MCP Server (Rust backend — fast)
node ts/dist/src/mcp/server-rust.js  # Starts on stdio, 15 tools, delegates to Rust binary

# MCP Server (TS backend — slow, legacy)
node ts/dist/src/mcp/server.js       # Uses ts-morph directly (~2min startup per call on WSL)
```

## Key Implementation Details

### Bugs Fixed (don't regress these)
- **tsconfig comment stripping**: Character-by-character parser that skips string contents. Regex-based stripping breaks on strings containing `//` or `/*`.
- **Re-exports as imports**: `export { x } from 'y'` must create graph edges. Without this, dependents of re-exporting files are invisible.
- **computeBulkMoves reverse map**: Graph indexes by old paths, but after bulk moves, affected entries reference new paths. A reverse map (newPath→oldPath) is required for lookups.
- **tsconfig include normalization**: `include: ["src"]` must expand to `src/**/*.{ts,tsx,js,jsx}` glob patterns.
- **No-op rewrite filtering**: After bulk cross-reference correction, sibling imports (relative paths unchanged by move) must be filtered out.

### CLI Entry Point
The correct CLI entry point is `dist/bin/refactor-runtime.js`. Using `dist/src/cli/index.js` exports the program object but doesn't call `program.parse()` — you'll get zero output.

### MCP Server Architecture
The MCP server (`server-rust.ts`) delegates to the Rust binary via `child_process.execFile`. This eliminates the ts-morph startup overhead (2+ minutes → ~8 seconds per tool call on WSL). The `.mcp.json` points to `ts/dist/src/mcp/server-rust.js`. The legacy `server.ts` (ts-morph based) still exists but should not be used for MCP.

### Performance on WSL
Tests take ~87s due to ts-morph AST parsing + WSL `/mnt/c/` filesystem overhead. This is expected. The Rust version completes the same scope in <1s.

### Graph is Read-Only
The dependency graph is built once from disk and treated as immutable during operations. All move/rewrite computations work against the snapshot. After applying changes, invalidate the cache to rebuild.

### Parser Enrichments
The parser supports optional enrichment extraction via `parseFile(path, config, enrichments?)`:
- `symbolUsages` — tracks all identifier references with type classification
- `jsxElements` — extracts JSX elements with props, event handlers, children
- `envReferences` — finds `process.env.X` and `import.meta.env.X` patterns
- `callSites` — extracts function/method calls with receiver, arg count, chaining

These are only computed when explicitly requested (zero overhead for existing operations).

## Roadmap

Full feature roadmap with designs and edge cases documented in agent-com under `refactor-runtime/roadmap/INDEX`. Key planned features:

- **Redirect/swap imports between files** (85% mechanical)
- **Breaking change detection** for callers of modified signatures (80-85% mechanical)
- **AI-validated refactoring architecture**: deterministic analysis → task generation → cheap AI validation (Haiku) → audit trail

Recently implemented:
- ~~Delete file + auto-clean imports~~ (90%+ mechanical) — **done**
- ~~Dead code elimination via entry point tracing~~ (90%+ mechanical) — **done**
- ~~AST-aware rename symbol across codebase~~ (85-90% mechanical) — **done**
- ~~UI audit (React/JSX issues)~~ (60-70% mechanical) — **done**
- ~~Unused dependency detection~~ (85% mechanical) — **done**
- ~~Env variable drift detection~~ (85% mechanical) — **done**

See `.claude/skills/refactor-agent.md` for the full agent skill with workflow patterns and decision rules.
