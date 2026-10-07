import { loadPortfolioConfig } from "../server/config.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import sharp from "sharp";
import type { CoreService } from "../core/service.js";
import { AtlasError } from "../shared/errors.js";
import type { RetrievalIndex, RetrievalDocument } from "../retrieval/indexing.js";
import type { AtlasRecord, FieldDefinition, RecordData } from "../types.js";

export const PORTFOLIO_PROJECT_ID = "d99a6c45-a4ec-5ef6-8f22-c07d31f8bb38";
export const PORTFOLIO_SOURCE_TYPE = "portfolio-published";

export const PORTFOLIO_CONTENT_TYPES = {
    profile: { storeId: "5ad2c831-f7ea-55c9-8b30-86a75f880101", name: "Profile", singleton: true },
    contact: { storeId: "5ad2c831-f7ea-55c9-8b30-86a75f880102", name: "Contact", singleton: true },
    projects: { storeId: "5ad2c831-f7ea-55c9-8b30-86a75f880103", name: "Projects", singleton: false },
    experience: { storeId: "5ad2c831-f7ea-55c9-8b30-86a75f880104", name: "Experience", singleton: false },
    posts: { storeId: "5ad2c831-f7ea-55c9-8b30-86a75f880105", name: "Posts", singleton: false },
    collections: { storeId: "5ad2c831-f7ea-55c9-8b30-86a75f880106", name: "Collections", singleton: false },
} as const;
export type PortfolioContentType = keyof typeof PORTFOLIO_CONTENT_TYPES;

const PORTFOLIO_MODELS: Record<PortfolioContentType, { description:string; fields:FieldDefinition[] }> = {
    profile:{description:"Portfolio identity, hero copy, CV and portrait.",fields:[{name:"firstName",type:"string"},{name:"lastName",type:"string"},{name:"tagline",type:"string"},{name:"description",type:"string"},{name:"cvAssetId",type:"string"},{name:"portraitAssetId",type:"string"}]},
    contact:{description:"Public contact and social links.",fields:[{name:"email",type:"string"},{name:"responseTime",type:"string"},{name:"githubUrl",type:"string"},{name:"linkedinUrl",type:"string"}]},
    projects:{description:"Portfolio case studies and work.",fields:[{name:"title",type:"string"},{name:"slug",type:"string"},{name:"year",type:"string"},{name:"summary",type:"string"},{name:"body",type:"string"},{name:"role",type:"string"},{name:"outcomes",type:"array",default:[]},{name:"tags",type:"array",default:[]},{name:"note",type:"string"},{name:"href",type:"string"},{name:"repositoryUrl",type:"string"},{name:"liveUrl",type:"string"},{name:"links",type:"array",default:[]},{name:"imageAssetId",type:"string"},{name:"galleryAssetIds",type:"array",default:[]},{name:"collectionId",type:"string"},{name:"order",type:"number"}]},
    experience:{description:"Roles and professional experience.",fields:[{name:"company",type:"string"},{name:"role",type:"string"},{name:"period",type:"string"},{name:"description",type:"string"},{name:"highlights",type:"array",default:[]},{name:"tags",type:"array",default:[]},{name:"accent",type:"string"},{name:"imageAssetId",type:"string"},{name:"order",type:"number"}]},
    posts:{description:"Published writing and drafts.",fields:[{name:"title",type:"string"},{name:"slug",type:"string"},{name:"excerpt",type:"string"},{name:"body",type:"string"},{name:"publishedAt",type:"datetime"},{name:"tags",type:"array",default:[]},{name:"heroAssetId",type:"string"},{name:"placeholder",type:"boolean",default:false},{name:"collectionId",type:"string"}]},
    collections:{description:"Ordered project and post collections.",fields:[{name:"key",type:"string"},{name:"title",type:"string"},{name:"slug",type:"string"},{name:"section",type:"enum",enumValues:["projects","blog"]},{name:"description",type:"string"},{name:"order",type:"number"},{name:"imageAssetId",type:"string"}]},
};

const TYPE_BY_STORE = new Map<string, PortfolioContentType>(Object.entries(PORTFOLIO_CONTENT_TYPES).map(([key, value]) => [value.storeId, key as PortfolioContentType]));
const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : undefined;
const cleanObject = (value: RecordData) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
const stableUuid = (value: string) => { const h = createHash("sha256").update(value).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };

type EntryRow = { id: string; store_id: string; data: RecordData; created_at: Date; updated_at: Date; revision_id: string | null; revision: number | null; published_at: Date | null };
export type PortfolioEntry = { id: string; contentType: PortfolioContentType; storeId: string; data: RecordData; status: "draft" | "published" | "changed"; createdAt: string; updatedAt: string; publishedAt?: string; publishedRevision?: number };

const entryFromRow = (row: EntryRow): PortfolioEntry => ({
    id: row.id, contentType: TYPE_BY_STORE.get(row.store_id)!, storeId: row.store_id, data: row.data,
    status: !row.revision_id ? "draft" : row.updated_at > (row.published_at ?? row.updated_at) ? "changed" : "published",
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...(row.published_at && { publishedAt: row.published_at.toISOString() }), ...(row.revision && { publishedRevision: row.revision }),
});

const requiredByType: Record<PortfolioContentType, string[]> = {
    profile: ["firstName", "lastName", "tagline"], contact: ["email"], projects: ["title", "slug", "summary"],
    experience: ["company", "role", "period"], posts: ["title", "slug", "body"], collections: ["key", "title", "slug", "section"],
};

export class PortfolioService {
    readonly pool: Pool;
    readonly ready: Promise<void>;
    constructor(readonly catalog: CoreService, readonly fabric: RetrievalIndex, databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl }); this.ready=this.initialize(); }
    async close() { await this.pool.end(); }

    private async initialize() {
        const connection=await this.pool.connect();
        try { await connection.query("BEGIN"); await connection.query("SELECT pg_advisory_xact_lock($1)",[0x504f5254]); await connection.query(`INSERT INTO projects(id,name,description,created_at,updated_at) VALUES($1,'Portfolio','Canonical portfolio content managed in Observatory.',now(),now()) ON CONFLICT(id) DO NOTHING`,[PORTFOLIO_PROJECT_ID]);
            for(const [contentType,definition] of Object.entries(PORTFOLIO_CONTENT_TYPES) as [PortfolioContentType,(typeof PORTFOLIO_CONTENT_TYPES)[PortfolioContentType]][]){const model=PORTFOLIO_MODELS[contentType];await connection.query(`INSERT INTO stores(id,project_id,name,description,current_schema_version,created_at,updated_at) VALUES($1,$2,$3,$4,1,now(),now()) ON CONFLICT(id) DO NOTHING`,[definition.storeId,PORTFOLIO_PROJECT_ID,definition.name,model.description]);await connection.query(`INSERT INTO store_schemas(store_id,version,definition,created_at) VALUES($1,1,$2,now()) ON CONFLICT(store_id,version) DO NOTHING`,[definition.storeId,{fields:model.fields}]);}
            await connection.query("COMMIT");
        } catch(error){await connection.query("ROLLBACK");throw error;} finally{connection.release();}
    }

    async dashboard() {
        await this.ready;
        const [entries, media] = await Promise.all([
            this.pool.query(`SELECT s.id,s.name,count(r.id)::int AS total,count(pp.record_id)::int AS published,count(r.id) FILTER (WHERE pp.record_id IS NULL)::int AS drafts FROM stores s LEFT JOIN records r ON r.store_id=s.id AND r.archived_at IS NULL LEFT JOIN portfolio_publications pp ON pp.record_id=r.id WHERE s.project_id=$1 GROUP BY s.id,s.name ORDER BY s.name`, [PORTFOLIO_PROJECT_ID]),
            this.pool.query(`SELECT count(*) FILTER (WHERE status='active')::int AS active,coalesce(sum(byte_size) FILTER (WHERE status='active'),0)::bigint AS bytes FROM media_assets`),
        ]);
        return { projectId: PORTFOLIO_PROJECT_ID, contentTypes: entries.rows.map(row => ({ contentType: TYPE_BY_STORE.get(row.id), storeId: row.id, name: row.name, total: row.total, published: row.published, drafts: row.drafts })), media: { active: media.rows[0].active, bytes: Number(media.rows[0].bytes) } };
    }

    async schemas() {
        await this.ready;
        const stores = await this.catalog.listStores(PORTFOLIO_PROJECT_ID);
        return stores.map(store => ({ contentType: TYPE_BY_STORE.get(store.id), storeId: store.id, name: store.name, description: store.description, fields: store.schema.fields }));
    }

    async listEntries(contentType?: PortfolioContentType) {
        await this.ready;
        const values: unknown[] = [PORTFOLIO_PROJECT_ID];
        const type = contentType ? PORTFOLIO_CONTENT_TYPES[contentType] : undefined;
        if (type) values.push(type.storeId);
        const result = await this.pool.query(`SELECT r.id,r.store_id,r.data,r.created_at,r.updated_at,pr.id AS revision_id,pr.revision,pp.published_at FROM records r JOIN stores s ON s.id=r.store_id LEFT JOIN portfolio_publications pp ON pp.record_id=r.id LEFT JOIN portfolio_revisions pr ON pr.id=pp.revision_id WHERE s.project_id=$1 AND r.archived_at IS NULL ${type ? "AND r.store_id=$2" : ""} ORDER BY coalesce((r.data->>'order')::numeric,999999),r.updated_at DESC`, values);
        return result.rows.map(entryFromRow);
    }

    async getEntry(recordId: string) {
        await this.ready;
        const result = await this.pool.query(`SELECT r.id,r.store_id,r.data,r.created_at,r.updated_at,pr.id AS revision_id,pr.revision,pp.published_at FROM records r JOIN stores s ON s.id=r.store_id LEFT JOIN portfolio_publications pp ON pp.record_id=r.id LEFT JOIN portfolio_revisions pr ON pr.id=pp.revision_id WHERE s.project_id=$1 AND r.id=$2 AND r.archived_at IS NULL`, [PORTFOLIO_PROJECT_ID, recordId]);
        if (!result.rows[0]) throw new AtlasError(`Portfolio entry '${recordId}' was not found.`, "NOT_FOUND");
        return entryFromRow(result.rows[0]);
    }

    async saveDraft(input: { contentType: PortfolioContentType; recordId?: string; data: RecordData; client?: string }) {
        await this.ready;
        const definition = PORTFOLIO_CONTENT_TYPES[input.contentType];
        if (!definition) throw new AtlasError(`Unknown Portfolio content type '${input.contentType}'.`);
        if (!input.recordId && definition.singleton) {
            const existing = await this.listEntries(input.contentType);
            if (existing[0]) input.recordId = existing[0].id;
        }
        const data = cleanObject(input.data);
        const record = input.recordId
            ? await this.catalog.updateRecord({ projectId: PORTFOLIO_PROJECT_ID, storeId: definition.storeId, recordId: input.recordId, data, replace: true, client: input.client ?? "portfolio-observatory" })
            : await this.catalog.createRecord({ projectId: PORTFOLIO_PROJECT_ID, storeId: definition.storeId, data, client: input.client ?? "portfolio-observatory" });
        await this.fabric.synchronize();
        return this.getEntry(record.id);
    }

    private async validatePublish(entry: PortfolioEntry) {
        const missing = requiredByType[entry.contentType].filter(field => typeof entry.data[field] !== "string" || !String(entry.data[field]).trim());
        if (missing.length) throw new AtlasError(`Cannot publish: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`);
        const slug = entry.data.slug;
        if (typeof slug === "string") {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new AtlasError("Cannot publish: slug must contain lowercase letters, numbers, and single hyphens.");
            const duplicate = await this.pool.query(`SELECT r.id FROM portfolio_publications pp JOIN portfolio_revisions pr ON pr.id=pp.revision_id JOIN records r ON r.id=pp.record_id WHERE pr.store_id=$1 AND lower(pr.data->>'slug')=lower($2) AND r.id<>$3 LIMIT 1`, [entry.storeId, slug, entry.id]);
            if (duplicate.rows[0]) throw new AtlasError(`Cannot publish: slug '${slug}' is already published in ${PORTFOLIO_CONTENT_TYPES[entry.contentType].name}.`);
        }
        const assetIds = Object.entries(entry.data).flatMap(([key, value]) => key.endsWith("AssetId") && typeof value === "string" ? [value] : key.endsWith("AssetIds") && Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
        if (assetIds.length) {
            const result = await this.pool.query(`SELECT id,mime_type,alt_text,status FROM media_assets WHERE id=ANY($1::uuid[])`, [assetIds]);
            const found = new Map(result.rows.map(row => [row.id, row]));
            for (const id of assetIds) {
                const asset = found.get(id);
                if (!asset || asset.status !== "active") throw new AtlasError(`Cannot publish: media asset '${id}' is missing or archived.`);
                if (String(asset.mime_type).startsWith("image/") && !String(asset.alt_text ?? "").trim()) throw new AtlasError(`Cannot publish: image '${id}' needs alt text.`);
            }
        }
    }

    async publish(recordId: string, client = "portfolio-observatory") {
        const entry = await this.getEntry(recordId); await this.validatePublish(entry);
        const connection = await this.pool.connect();
        try {
            await connection.query("BEGIN");
            await connection.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[recordId]);
            const next = await connection.query(`SELECT coalesce(max(revision),0)+1 AS revision FROM portfolio_revisions WHERE record_id=$1`, [recordId]);
            const revisionId = randomUUID(), revision = Number(next.rows[0].revision);
            await connection.query(`INSERT INTO portfolio_revisions(id,record_id,store_id,revision,data,created_by) VALUES($1,$2,$3,$4,$5,$6)`, [revisionId, recordId, entry.storeId, revision, entry.data, client]);
            await connection.query(`INSERT INTO portfolio_publications(record_id,revision_id,published_by,published_at) VALUES($1,$2,$3,now()) ON CONFLICT(record_id) DO UPDATE SET revision_id=excluded.revision_id,published_by=excluded.published_by,published_at=now()`, [recordId, revisionId, client]);
            await connection.query("COMMIT");
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
        await this.rebuildPublishedIndex();
        return this.getEntry(recordId);
    }

    async unpublish(recordId: string) { await this.getEntry(recordId); await this.pool.query(`DELETE FROM portfolio_publications WHERE record_id=$1`, [recordId]); await this.rebuildPublishedIndex(); return this.getEntry(recordId); }

    async archive(recordId: string, client = "portfolio-observatory") {
        const entry = await this.getEntry(recordId); await this.pool.query(`DELETE FROM portfolio_publications WHERE record_id=$1`, [recordId]);
        await this.catalog.archiveRecord(PORTFOLIO_PROJECT_ID, entry.storeId, recordId, client); await this.rebuildPublishedIndex(); return { archived: true, recordId };
    }

    async revisions(recordId: string) {
        await this.getEntry(recordId);
        const result = await this.pool.query(`SELECT pr.id,pr.revision,pr.data,pr.created_by AS "createdBy",pr.created_at AS "createdAt",pp.revision_id=pr.id AS published FROM portfolio_revisions pr LEFT JOIN portfolio_publications pp ON pp.record_id=pr.record_id WHERE pr.record_id=$1 ORDER BY pr.revision DESC`, [recordId]);
        return result.rows.map(row => ({ ...row, createdAt: iso(row.createdAt) }));
    }

    async restore(recordId: string, revisionId: string, client = "portfolio-observatory") {
        const entry = await this.getEntry(recordId);
        const result = await this.pool.query(`SELECT data FROM portfolio_revisions WHERE id=$1 AND record_id=$2`, [revisionId, recordId]);
        if (!result.rows[0]) throw new AtlasError(`Portfolio revision '${revisionId}' was not found.`, "NOT_FOUND");
        await this.catalog.updateRecord({ projectId: PORTFOLIO_PROJECT_ID, storeId: entry.storeId, recordId, data: result.rows[0].data, replace: true, client });
        return this.getEntry(recordId);
    }

    async rebuildPublishedIndex() {
        await this.ready;
        const result = await this.pool.query(`SELECT r.id AS record_id,r.created_at,pp.published_at,pr.store_id,pr.data,s.name AS store_name FROM portfolio_publications pp JOIN portfolio_revisions pr ON pr.id=pp.revision_id JOIN records r ON r.id=pp.record_id JOIN stores s ON s.id=pr.store_id WHERE r.archived_at IS NULL ORDER BY r.id`);
        const documents: RetrievalDocument[] = result.rows.map(row => { const text = JSON.stringify(row.data); return { recordId: stableUuid(`portfolio-published:${row.record_id}`), sourceId: row.record_id, projectId: PORTFOLIO_PROJECT_ID, projectName: "Portfolio", storeId: row.store_id, storeName: row.store_name, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.published_at.toISOString(), fieldText: text, searchableText: `Portfolio ${row.store_name} ${text}`, displayText: Object.values(row.data).flatMap(value => Array.isArray(value) ? value : [value]).filter(value => ["string","number","boolean"].includes(typeof value)).join(" · ") }; });
        await this.fabric.replaceExternalDocuments(PORTFOLIO_SOURCE_TYPE, documents);
        return { published: documents.length };
    }

    private async mediaUrl(assetId: unknown, variant = "preview", baseUrl = "") {
        if (typeof assetId !== "string" || !assetId) return undefined;
        const asset = await this.pool.query(`SELECT mime_type FROM media_assets WHERE id=$1 AND status='active'`, [assetId]);
        if (!asset.rows[0]) return undefined;
        return `${baseUrl}/api/media/${assetId}/${String(asset.rows[0].mime_type).startsWith("image/") ? variant : "original"}`;
    }

    async publicContent(baseUrl = "") {
        await this.ready;
        const result = await this.pool.query(`SELECT pr.store_id,pr.data FROM portfolio_publications pp JOIN portfolio_revisions pr ON pr.id=pp.revision_id JOIN records r ON r.id=pp.record_id WHERE r.archived_at IS NULL ORDER BY coalesce((pr.data->>'order')::numeric,999999),pp.published_at`);
        const groups = new Map<PortfolioContentType, RecordData[]>();
        for (const row of result.rows) { const type = TYPE_BY_STORE.get(row.store_id)!; groups.set(type, [...(groups.get(type) ?? []), row.data]); }
        const enrich = async (data: RecordData, mapping: Record<string,string>) => { const copy = { ...data }; for (const [source,target] of Object.entries(mapping)) { const url = await this.mediaUrl(data[source],"preview",baseUrl); if (url) copy[target] = url; delete copy[source]; } return copy; };
        return {
            hero: groups.get("profile")?.[0] ? await enrich(groups.get("profile")![0]!, { cvAssetId: "cvUrl", portraitAssetId: "portraitUrl" }) : null,
            contact: groups.get("contact")?.[0] ?? null,
            work: await Promise.all((groups.get("projects") ?? []).map(async item => { const value = await enrich(item, { imageAssetId: "image" }); if (Array.isArray(item.galleryAssetIds)) value.gallery = (await Promise.all(item.galleryAssetIds.map(id => this.mediaUrl(id,"preview",baseUrl)))).filter(Boolean); delete value.galleryAssetIds; return value; })),
            experience: await Promise.all((groups.get("experience") ?? []).map(item => enrich(item, { imageAssetId: "image" }))),
            posts: await Promise.all((groups.get("posts") ?? []).map(item => enrich(item, { heroAssetId: "heroImage" }))),
            collections: await Promise.all((groups.get("collections") ?? []).map(item => enrich(item, { imageAssetId: "image" }))),
        };
    }
}

const ALLOWED_MEDIA = new Set(["image/jpeg","image/png","image/webp","image/gif","image/avif","application/pdf"]);
const extensionFor = (mime: string) => ({ "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "image/gif":"gif", "image/avif":"avif", "application/pdf":"pdf" }[mime] ?? "bin");

export class PortfolioMediaService {
    readonly pool: Pool;
    constructor(databaseUrl: string, readonly root = loadPortfolioConfig().mediaRoot) { this.pool = new Pool({ connectionString: databaseUrl }); }
    async close() { await this.pool.end(); }
    async list() { const result = await this.pool.query(`SELECT id,original_name AS "originalName",mime_type AS "mimeType",byte_size AS "byteSize",width,height,alt_text AS "altText",caption,status,created_at AS "createdAt",updated_at AS "updatedAt" FROM media_assets ORDER BY created_at DESC`); return result.rows.map(row => ({ ...row, byteSize: Number(row.byteSize), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), url: `/api/media/${row.id}/original`, ...(String(row.mimeType).startsWith("image/") && { thumbnailUrl: `/api/media/${row.id}/thumbnail`, previewUrl: `/api/media/${row.id}/preview` }) })); }
    async upload(input: { fileName: string; mimeType: string; base64: string; altText?: string; caption?: string; client?: string }) {
        if (!ALLOWED_MEDIA.has(input.mimeType)) throw new AtlasError(`Unsupported media type '${input.mimeType}'.`);
        const bytes = Buffer.from(input.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
        if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new AtlasError("Media must be between 1 byte and 25 MB.");
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const existing = await this.pool.query(`SELECT id FROM media_assets WHERE checksum=$1 AND status='active' LIMIT 1`, [checksum]);
        if (existing.rows[0]) return (await this.list()).find(asset => asset.id === existing.rows[0].id);
        await mkdir(this.root, { recursive: true });
        const id = randomUUID(), originalKey = `${checksum}.${extensionFor(input.mimeType)}`;
        let width: number | undefined, height: number | undefined;
        const variants: { name:string; key:string; mime:string; bytes:Buffer; width?:number; height?:number }[] = [];
        if (input.mimeType.startsWith("image/")) {
            const image = sharp(bytes, { animated: false }); const metadata = await image.metadata(); width = metadata.width; height = metadata.height;
            for (const [name, size] of [["thumbnail",480],["preview",1600]] as const) { const output = await sharp(bytes).rotate().resize({ width:size, height:size, fit:"inside", withoutEnlargement:true }).webp({ quality:82 }).toBuffer({ resolveWithObject:true }); variants.push({ name, key:`${checksum}-${name}.webp`, mime:"image/webp", bytes:output.data, width:output.info.width, height:output.info.height }); }
        } else if (!bytes.subarray(0,5).equals(Buffer.from("%PDF-"))) throw new AtlasError("The uploaded file is not a valid PDF.");
        await writeFile(path.join(this.root, originalKey), bytes, { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        for (const variant of variants) await writeFile(path.join(this.root, variant.key), variant.bytes, { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        const connection = await this.pool.connect(); try { await connection.query("BEGIN"); await connection.query(`INSERT INTO media_assets(id,checksum,storage_key,original_name,mime_type,byte_size,width,height,alt_text,caption,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,checksum,originalKey,input.fileName,input.mimeType,bytes.length,width??null,height??null,input.altText?.trim()||null,input.caption?.trim()||null,input.client??"portfolio-observatory"]); for (const variant of variants) await connection.query(`INSERT INTO media_variants(asset_id,name,storage_key,mime_type,byte_size,width,height) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,variant.name,variant.key,variant.mime,variant.bytes.length,variant.width??null,variant.height??null]); await connection.query("COMMIT"); } catch(error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
        return (await this.list()).find(asset => asset.id === id)!;
    }
    async update(id: string, input: { altText?: string | null; caption?: string | null; status?: "active" | "archived" }) { const result = await this.pool.query(`UPDATE media_assets SET alt_text=CASE WHEN $2::boolean THEN $3 ELSE alt_text END,caption=CASE WHEN $4::boolean THEN $5 ELSE caption END,status=coalesce($6,status),updated_at=now() WHERE id=$1 RETURNING id`,[id,input.altText!==undefined,input.altText?.trim()||null,input.caption!==undefined,input.caption?.trim()||null,input.status??null]); if(!result.rows[0])throw new AtlasError(`Media asset '${id}' was not found.`,"NOT_FOUND"); return (await this.list()).find(asset=>asset.id===id); }
    async file(id: string, variant: string) { const result = variant === "original" ? await this.pool.query(`SELECT storage_key,mime_type FROM media_assets WHERE id=$1 AND status='active'`,[id]) : await this.pool.query(`SELECT v.storage_key,v.mime_type FROM media_variants v JOIN media_assets a ON a.id=v.asset_id WHERE v.asset_id=$1 AND v.name=$2 AND a.status='active'`,[id,variant]); if(!result.rows[0])throw new AtlasError("Media file was not found.","NOT_FOUND"); return { bytes: await readFile(path.join(this.root,result.rows[0].storage_key)), mimeType: result.rows[0].mime_type }; }
}

export type PortfolioSchemaField = FieldDefinition;
export type PortfolioDraftRecord = AtlasRecord;
