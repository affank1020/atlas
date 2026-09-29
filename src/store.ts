import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AtlasData } from "./types.js";

const EMPTY_DATA: AtlasData = { schemaVersion: 1, projects: [], stores: [], records: [], auditEvents: [] };
export const defaultDataFile = path.join(process.cwd(), "data", "atlas-structured.json");

export class AtlasStore {
    private data: AtlasData | undefined;
    private mutationQueue: Promise<void> = Promise.resolve();
    constructor(readonly filePath = defaultDataFile) {}
    async snapshot(): Promise<AtlasData> { return structuredClone(await this.load()); }
    async transaction<T>(operation: (draft: AtlasData) => T | Promise<T>): Promise<T> {
        let result!: T; let failure: unknown;
        this.mutationQueue = this.mutationQueue.then(async () => {
            try { const draft = structuredClone(await this.load()); result = await operation(draft); await this.persist(draft); this.data = draft; }
            catch (error) { failure = error; }
        });
        await this.mutationQueue;
        if (failure) throw failure;
        return structuredClone(result);
    }
    private async load(): Promise<AtlasData> {
        if (this.data) return this.data;
        try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AtlasData>;
            if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.stores) || !Array.isArray(parsed.records) || !Array.isArray(parsed.auditEvents)) throw new Error(`Unsupported or invalid Atlas structured data file: ${this.filePath}`);
            this.data = parsed as AtlasData;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            this.data = structuredClone(EMPTY_DATA);
        }
        return this.data;
    }
    private async persist(data: AtlasData): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        await rename(temporary, this.filePath);
    }
}
