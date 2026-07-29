# Internal Code MCP Server

Static code analysis MCP server for validating code structure, imports, and dependencies without runtime execution. This server performs "compile-time Ground Truth validation" by checking code assumptions against filesystem and module reality.

## Philosophy

Validates the **Internal Map** (code assumptions about imports, modules, configs) against the **Internal Territory** (actual filesystem, exported symbols, module structure). Complements the external Truth Seeker by focusing on code structure rather than infrastructure.

## Tools

### 1. `validate_import_tree`
Validates all imports in a file or directory resolve correctly.

**Parameters:**
- `filePath` (required): Path to file or directory
- `recursive` (optional): Check all imports recursively
- `checkTypes` (optional): Validate TypeScript exports exist
- `projectRoot` (optional): Project root for tsconfig resolution

**Use case:** "Are all my imports valid? Do the files and exports actually exist?"

### 2. `validate_symbol_usage`
Checks if imported symbols are exported and analyzes their usage.

**Parameters:**
- `filePath` (required): File to analyze
- `symbolName` (required): Symbol to validate
- `projectRoot` (optional): Project root

**Use case:** "Is this function/class actually exported? How is it being used?"

### 3. `validate_config_references`
Validates configuration file references against the codebase.

**Parameters:**
- `configPath` (required): Path to config JSON file
- `referenceType` (required): Type of references (plugins, services, routes, modules)
- `codebasePath` (required): Path to codebase root

**Use case:** "My config references 'python-plugin' - does that file/module actually exist?"

### 4. `analyze_dependency_graph`
Builds and validates module dependency graph, detects circular dependencies and dead code.

**Parameters:**
- `entryPoint` (required): Entry point file
- `checkCircular` (optional): Check for circular dependencies
- `maxDepth` (optional): Maximum dependency depth

**Use case:** "Do I have circular dependencies? Any orphaned modules never imported?"

### 5. `audit_codebase_health`
Comprehensive validation across multiple checks.

**Parameters:**
- `projectRoot` (required): Project root directory
- `checks` (required): Array of checks to run (imports, symbols, dependencies, dead-code)
- `failFast` (optional): Stop on first error

**Use case:** "Run a full audit after refactoring to catch any broken imports or dependencies"

## Setup

1. Install dependencies:
   ```bash
   cd internal-code-mcp
   npm install
   ```

2. Build the server:
   ```bash
   npm run build
   ```

3. Configure in your MCP client:
   ```json
   {
     "mcpServers": {
       "internal-code": {
         "command": "node",
         "args": ["/path/to/internal-code-mcp/dist/index-internal-code.js"]
       }
     }
   }
   ```

## Development

- **Watch mode**: `npm run dev`
- **Build**: `npm run build`
- **Run**: `npm start`

## How It Works

Uses **static analysis** via:
- `ts-morph`: TypeScript AST parsing for import/export validation
- `madge`: Dependency graph analysis for circular dependencies
- `glob`: File pattern matching for config validation

No runtime execution required - analyzes code structure directly from source files.

## Example Usage

### Debugging Import Issues
```typescript
// User: "Getting import errors but don't know why"
await validate_import_tree({
    filePath: "src/plugins/python/index.ts",
    recursive: true,
    checkTypes: true
});
// → Returns: "Import './parser' not found, Symbol 'Parser' not exported from './types'"
```

### Checking Symbol Usage
```typescript
// User: "Is my registerPlugin function being called?"
await validate_symbol_usage({
    filePath: "src/index.ts",
    symbolName: "registerPlugin"
});
// → Returns: "Symbol 'registerPlugin' is a function from './registry', used 3 times"
```

### Finding Circular Dependencies
```typescript
// User: "Getting weird module initialization errors"
await analyze_dependency_graph({
    entryPoint: "src/index.ts",
    checkCircular: true
});
// → Returns: "Circular dependency: AuthService -> UserService -> AuthService"
```

## Integration with Truth Seeker

- **Truth Seeker (External)**: Validates database schemas, API contracts, infrastructure
- **Internal Code (this)**: Validates imports, symbols, dependencies, code structure

Use both together for complete "Map vs. Territory" validation at all layers!
