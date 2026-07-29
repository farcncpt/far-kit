import { Pool } from "pg";
export declare const getDbConnection: (connectionString?: string) => Pool;
export declare const closeDbConnection: () => Promise<void>;
