import { Project } from "ts-morph";
declare class ProjectCache {
    private cache;
    private maxAge;
    private enabled;
    get(projectRoot: string, tsconfigPath?: string): Project | null;
    set(projectRoot: string, project: Project, tsconfigPath?: string): void;
    clear(): void;
    getStats(): {
        enabled: boolean;
        entryCount: number;
        maxAge: number;
        keys: string[];
    };
}
export declare const projectCache: ProjectCache;
export {};
