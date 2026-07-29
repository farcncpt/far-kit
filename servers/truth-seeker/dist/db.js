import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();
// We will load the connection string from the environment variable provided by the client
// or default to a local connection if testing.
// In a real MCP scenario, the client might pass connection details, or the server
// might be configured with a specific database in mind.
// For the Truth Seeker, it is designed to use the project's .env.
const pools = new Map();
export const getDbConnection = (connectionString) => {
    const connectionStringUrl = connectionString || process.env.DATABASE_URL;
    if (!connectionStringUrl) {
        throw new Error("DATABASE_URL is not defined and no connection string was provided.");
    }
    if (pools.has(connectionStringUrl)) {
        return pools.get(connectionStringUrl);
    }
    const pool = new Pool({
        connectionString: connectionStringUrl,
        ssl: connectionStringUrl.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    pools.set(connectionStringUrl, pool);
    return pool;
};
export const closeDbConnection = async () => {
    for (const pool of pools.values()) {
        await pool.end();
    }
    pools.clear();
};
//# sourceMappingURL=db.js.map