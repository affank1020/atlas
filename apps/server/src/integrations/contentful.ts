import { loadPortfolioConfig } from "../server/config.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { escape as queryEscape } from "node:querystring";
import type { IncomingMessage } from "node:http";
import type { FabricSearchRepository, ExternalFabricDocument } from "../fabric/repository.js";
import { projectRecord } from "../fabric/projection.js";

export const PORTFOLIO_PROJECT_ID = "d99a6c45-a4ec-5ef6-8f22-c07d31f8bb38";
export const PORTFOLIO_PROJECT_NAME = "Portfolio";
const SOURCE_TYPE = "contentful-portfolio";
const INTEGRATION = "portfolio";

type ContentfulResource = {
    sys: { id: string; type?: string; createdAt?: string; updatedAt?: string; contentType?: { sys?: { id?: string } } };
    fields?: Record<string, unknown>;
};
type ContentfulCollection = { total: number; skip: number; limit: number; items: ContentfulResource[]; includes?: { Entry?: ContentfulResource[]; Asset?: ContentfulResource[] } };

export type PortfolioSyncStatus = {
    connected: boolean;
    status: "not_configured" | "idle" | "syncing" | "failed";
    spaceId?: string;
    environment: string;
    lastTrigger?: string;
    lastEvent?: string;
    lastStartedAt?: string;
    lastSuccessfulSync?: string;
    lastError?: string;
    counts: Record<string, number>;
};

type ContentfulConfig = { spaceId?: string; environment: string; accessToken?: string; webhookSecret?: string; requestTtlSeconds: number };

const uuidFor = (value: string) => {
    const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const headersOf = (request: IncomingMessage) => Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]));

export function verifyContentfulWebhook(request: IncomingMessage, rawBody: string, secret: string, ttlSeconds: number) {
    const headers=headersOf(request),signature=headers["x-contentful-signature"],timestamp=Number.parseInt(headers["x-contentful-timestamp"]??"",10),signedHeaders=(headers["x-contentful-signed-headers"]??"").split(",").filter(Boolean);
    if(secret.length!==64||signature?.length!==64||!Number.isFinite(timestamp)||timestamp<=1577836800000||signedHeaders.length<2)return false;
    if(ttlSeconds!==0&&Date.now()-timestamp>=ttlSeconds*1000)throw new Error(`Contentful webhook signature is older than ${ttlSeconds}s.`);
    const selected=Object.fromEntries(Object.entries(headers).filter(([key])=>signedHeaders.includes(key)));
    const expected=signContentfulRequest(secret,{method:"POST",path:request.url??"/integrations/contentful/webhook",headers:selected,body:rawBody},timestamp)["x-contentful-signature"];
    const actualBytes=Buffer.from(signature),expectedBytes=Buffer.from(expected);return actualBytes.length===expectedBytes.length&&timingSafeEqual(actualBytes,expectedBytes);
}

export function signContentfulRequest(secret:string,request:{method:string;path:string;headers?:Record<string,string>;body?:string},timestamp=Date.now()){
    if(secret.length!==64)throw new Error("Contentful signing secrets must contain 64 characters.");
    const headers=Object.fromEntries(Object.entries(request.headers??{}).map(([key,value])=>[key.toLowerCase().trim(),value.trim()]));
    const signed=[...new Set([...Object.keys(headers),"x-contentful-signed-headers","x-contentful-timestamp"])].sort();
    headers["x-contentful-timestamp"]=String(timestamp);headers["x-contentful-signed-headers"]=signed.join(",");
    const sorted=Object.entries(headers).sort(([a],[b])=>a>b?1:-1);const [pathname,search]=request.path.split("?");const normalizedPath=encodeURI(search?`${pathname}?${queryEscape(search)}`:pathname!);
    const canonical=[request.method,normalizedPath,sorted.map(([key,value])=>`${key}:${value}`).join(";"),request.body??""].join("\n");
    return {"x-contentful-signature":createHmac("sha256",secret).update(canonical).digest("hex"),"x-contentful-signed-headers":headers["x-contentful-signed-headers"]!,"x-contentful-timestamp":String(timestamp)};
}

const plainName = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
const storeName = (contentType: string) => plainName(contentType || "content");

function resolveValue(value: unknown, resources: Map<string, ContentfulResource>, seen = new Set<string>()): unknown {
    if (Array.isArray(value)) return value.map(item => resolveValue(item, resources, seen));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const sys = object.sys as { id?: string; type?: string; linkType?: string } | undefined;
    if (sys?.type === "Link" && sys.id) {
        if (seen.has(sys.id)) return { linkedContentfulId: sys.id };
        const linked = resources.get(sys.id);
        if (!linked) return { linkedContentfulId: sys.id, linkType: sys.linkType };
        const nextSeen = new Set(seen).add(sys.id);
        return { contentfulId: linked.sys.id, ...Object.fromEntries(Object.entries(linked.fields ?? {}).map(([key, child]) => [key, resolveValue(child, resources, nextSeen)])) };
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolveValue(child, resources, seen)]));
}

function toDocument(resource: ContentfulResource, resources: Map<string, ContentfulResource>): ExternalFabricDocument {
    const kind = resource.sys.type === "Asset" ? "documents" : resource.sys.contentType?.sys?.id ?? "content";
    const name = storeName(kind);
    const data = {
        contentType: kind,
        contentfulId: resource.sys.id,
        ...Object.fromEntries(Object.entries(resource.fields ?? {}).map(([key, value]) => [key, resolveValue(value, resources)])),
    };
    const projection = projectRecord(data);
    const createdAt = resource.sys.createdAt ?? resource.sys.updatedAt ?? new Date(0).toISOString();
    const updatedAt = resource.sys.updatedAt ?? createdAt;
    return {
        recordId: uuidFor(`${SOURCE_TYPE}:${resource.sys.type ?? "Resource"}:${resource.sys.id}`), sourceId: `${resource.sys.type ?? "Resource"}:${resource.sys.id}`,
        projectId: PORTFOLIO_PROJECT_ID, projectName: PORTFOLIO_PROJECT_NAME,
        storeId: uuidFor(`${SOURCE_TYPE}:store:${kind}`), storeName: name,
        data, createdAt, updatedAt, fieldText: projection.searchableText,
        searchableText: `${PORTFOLIO_PROJECT_NAME} ${name} ${projection.searchableText}`,
        displayText: projection.displayText,
    };
}

const assetIsDocument = (asset: ContentfulResource) => {
    const values: unknown[] = [asset.fields?.file];
    while (values.length) {
        const value = values.pop();
        if (!value || typeof value !== "object") continue;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === "contentType" && typeof child === "string") return /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument)|text\/)/i.test(child);
            values.push(child);
        }
    }
    return false;
};

const countKinds = (documents: ExternalFabricDocument[]) => {
    const counts: Record<string, number> = { total: documents.length, projects: 0, blogs: 0, experience: 0, documents: 0 };
    for (const document of documents) {
        const kind = String(document.data.contentType ?? "content").toLowerCase();
        if (/project|work|case.?study/.test(kind)) counts.projects++;
        else if (/blog|post|article/.test(kind)) counts.blogs++;
        else if (/experience|employment|role|job/.test(kind)) counts.experience++;
        else if (/document|cv|resume|asset/.test(kind)) counts.documents++;
        else counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
};

export class ContentfulPortfolioIntegration {
    readonly config: ContentfulConfig;
    private inFlight?: Promise<PortfolioSyncStatus>;
    private pending?: { trigger: "startup" | "manual" | "webhook"; event?: string };

    constructor(readonly repository: FabricSearchRepository, env: NodeJS.ProcessEnv = loadPortfolioConfig().integrationEnvironment, readonly fetcher: typeof fetch = fetch) {
        this.config = {
            spaceId: env.CONTENTFUL_SPACE_ID,
            environment: env.CONTENTFUL_ENVIRONMENT ?? "master",
            accessToken: env.CONTENTFUL_DELIVERY_ACCESS_TOKEN,
            webhookSecret: env.CONTENTFUL_WEBHOOK_SIGNING_SECRET,
            requestTtlSeconds: Number(env.CONTENTFUL_WEBHOOK_TTL_SECONDS ?? 60),
        };
    }

    get configured() { return Boolean(this.config.spaceId && this.config.accessToken); }
    get webhookConfigured() { return Boolean(this.config.webhookSecret); }

    async status(): Promise<PortfolioSyncStatus> {
        const result = await this.repository.pool.query(`SELECT status,last_trigger AS "lastTrigger",last_event AS "lastEvent",last_started_at AS "lastStartedAt",last_success_at AS "lastSuccessfulSync",last_error AS "lastError",counts FROM contentful_sync_state WHERE integration=$1`, [INTEGRATION]);
        const row = result.rows[0] as Omit<PortfolioSyncStatus, "connected" | "spaceId" | "environment"> | undefined;
        return { connected: this.configured, ...(this.config.spaceId && { spaceId: this.config.spaceId }), environment: this.config.environment, status: row?.status ?? (this.configured ? "idle" : "not_configured"), counts: row?.counts ?? {}, ...(row ?? {}) };
    }

    async syncPortfolio(trigger: "startup" | "manual" | "webhook" = "manual", event?: string): Promise<PortfolioSyncStatus> {
        if (this.inFlight) { this.pending = { trigger, ...(event && { event }) }; return this.inFlight; }
        this.inFlight = this.runQueued(trigger, event).finally(() => { this.inFlight = undefined; });
        return this.inFlight;
    }

    private async runQueued(trigger: "startup" | "manual" | "webhook", event?: string) {
        let next: { trigger: "startup" | "manual" | "webhook"; event?: string } = { trigger, ...(event && { event }) };
        let result: PortfolioSyncStatus | undefined;
        while (true) {
            try { result = await this.runSync(next.trigger, next.event); }
            catch (error) { if (!this.pending) throw error; }
            if (!this.pending) return result!;
            next = this.pending; this.pending = undefined;
        }
    }

    private async runSync(trigger: string, event?: string): Promise<PortfolioSyncStatus> {
        if (!this.configured) {
            await this.repository.pool.query(`INSERT INTO contentful_sync_state(integration,status,last_trigger,last_event,updated_at) VALUES($1,'not_configured',$2,$3,now()) ON CONFLICT(integration) DO UPDATE SET status='not_configured',last_trigger=excluded.last_trigger,last_event=excluded.last_event,updated_at=now()`, [INTEGRATION, trigger, event ?? null]);
            return this.status();
        }
        await this.repository.pool.query(`INSERT INTO contentful_sync_state(integration,status,last_trigger,last_event,last_started_at,last_error,updated_at) VALUES($1,'syncing',$2,$3,now(),null,now()) ON CONFLICT(integration) DO UPDATE SET status='syncing',last_trigger=excluded.last_trigger,last_event=excluded.last_event,last_started_at=now(),last_error=null,updated_at=now()`, [INTEGRATION, trigger, event ?? null]);
        try {
            const entries = await this.fetchCollection("entries", true);
            const assets = await this.fetchCollection("assets", false);
            const resources = new Map([...entries, ...assets].map(item => [item.sys.id, item]));
            const documents = [...entries, ...assets.filter(assetIsDocument)].map(item => toDocument(item, resources));
            await this.repository.replaceExternalDocuments(SOURCE_TYPE, documents);
            const counts = countKinds(documents);
            await this.repository.pool.query(`UPDATE contentful_sync_state SET status='idle',last_success_at=now(),last_error=null,counts=$2,updated_at=now() WHERE integration=$1`, [INTEGRATION, counts]);
            return this.status();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.repository.pool.query(`UPDATE contentful_sync_state SET status='failed',last_error=$2,updated_at=now() WHERE integration=$1`, [INTEGRATION, message]);
            throw error;
        }
    }

    private async fetchCollection(kind: "entries" | "assets", include: boolean) {
        const items: ContentfulResource[] = [];
        let skip = 0, total = 1;
        while (skip < total) {
            const url = new URL(`https://cdn.contentful.com/spaces/${encodeURIComponent(this.config.spaceId!)}/environments/${encodeURIComponent(this.config.environment)}/${kind}`);
            url.searchParams.set("limit", "1000"); url.searchParams.set("skip", String(skip));
            if (include) url.searchParams.set("include", "10");
            const response = await this.fetcher(url, { headers: { authorization: `Bearer ${this.config.accessToken}` } });
            if (!response.ok) throw new Error(`Contentful ${kind} request failed with HTTP ${response.status}.`);
            const page = await response.json() as ContentfulCollection;
            items.push(...page.items, ...(page.includes?.Entry ?? []), ...(page.includes?.Asset ?? []));
            total = page.total; skip += page.items.length;
            if (!page.items.length) break;
        }
        return [...new Map(items.map(item => [item.sys.id, item])).values()];
    }

    async acceptWebhook(idempotencyKey: string, topic: string) {
        const result = await this.repository.pool.query(`INSERT INTO contentful_webhook_deliveries(idempotency_key,topic) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING idempotency_key`, [idempotencyKey, topic]);
        return result.rowCount === 1;
    }
}
