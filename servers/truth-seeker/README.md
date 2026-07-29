# Truth Seeker MCP Server

This is a standalone Model Context Protocol (MCP) server for the Truth Seeker project. It provides tools to validate database schemas, simulate transactions, and audit infrastructure connectivity.

## Tools

- **`validate_schema_contract`**: Validates that the database schema matches the expected contract.
- **`simulate_transaction`**: Executes a SQL operation within a rollback transaction to test validity.
- **`generate_reproduction_script`**: Generates a standalone TypeScript script to reproduce a database state or bug.
- **`audit_connectivity`**: Checks connectivity to infrastructure resources (DB, Redis, S3).

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Build the server:
    ```bash
    npm run build
    ```
    This command cleans the `dist` directory and compiles the TypeScript code, generating `.js`, `.d.ts`, and `.js.map` files.

3.  Configure environment variables:
    Create a `.env` file in the root directory with your database connection string:
    ```
    DATABASE_URL=postgres://user:password@localhost:5432/dbname
    ```

## Running the Server

To run the server with an MCP client (like Claude Desktop or an IDE extension), use the following command configuration:

```json
{
  "mcpServers": {
    "truth-seeker": {
      "command": "node",
      "args": ["/path/to/truth-seeker-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}
```

## Development

- **Watch mode**: `npm run dev`
- **Test client**: `node dist/test_client.js` (after build)
