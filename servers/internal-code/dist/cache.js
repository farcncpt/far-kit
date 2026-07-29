class ProjectCache {
    cache = new Map();
    maxAge = 5 * 60 * 1000; // 5 minutes
    enabled = process.env.TRUTH_SEEKER_CACHE_DISABLED !== 'true';
    get(projectRoot, tsconfigPath) {
        if (!this.enabled)
            return null;
        const key = `${projectRoot}:${tsconfigPath || 'default'}`;
        const entry = this.cache.get(key);
        if (!entry)
            return null;
        // Expire old entries
        if (Date.now() - entry.timestamp > this.maxAge) {
            this.cache.delete(key);
            return null;
        }
        return entry.project;
    }
    set(projectRoot, project, tsconfigPath) {
        if (!this.enabled)
            return;
        const key = `${projectRoot}:${tsconfigPath || 'default'}`;
        this.cache.set(key, {
            project,
            timestamp: Date.now(),
            tsconfigPath
        });
    }
    clear() {
        this.cache.clear();
    }
    getStats() {
        return {
            enabled: this.enabled,
            entryCount: this.cache.size,
            maxAge: this.maxAge,
            keys: Array.from(this.cache.keys())
        };
    }
}
export const projectCache = new ProjectCache();
//# sourceMappingURL=cache.js.map