import type { Pool } from 'pg';

export type StorageUsage = {
  postgres: {
    state: 'ready' | 'unavailable'; measuredAt?: string; databaseBytes?: number;
    tableBytes?: number; indexBytes?: number; tableCount?: number;
    tables?: { schema: string; name: string; tableBytes: number; indexBytes: number; totalBytes: number }[];
  };
  r2: {
    state: 'ready' | 'not_configured' | 'unavailable'; bucket?: string;
    measuredAt?: string; refreshedAt?: string; storageBytes?: number; objectCount?: number;
    classA?: number; classB?: number; otherOperations?: number;
    monthStart?: string; accountWideOperations?: boolean;
    storageAllowanceBytes: number; classAAllowance: number; classBAllowance: number;
  };
};
export type StorageUsageConfig = { accountId?: string; analyticsToken?: string; bucket?: string };
const GB = 1_000_000_000;
export const R2_ALLOWANCES = { storageAllowanceBytes: 10 * GB, classAAllowance: 1_000_000, classBAllowance: 10_000_000 } as const;
const TTL_MS = 15 * 60_000;
const classA = new Set([
  'listbuckets','putbucket','listobjects','putobject','copyobject','completemultipartupload',
  'createmultipartupload','lifecyclestoragetiertransition','listmultipartuploads','uploadpart',
  'uploadpartcopy','listparts','putbucketencryption','putbucketcors','putbucketlifecycleconfiguration',
]);
const classB = new Set([
  'headbucket','headobject','getobject','usagesummary',
  'getbucketencryption','getbucketlocation','getbucketcors','getbucketlifecycleconfiguration',
]);
function numeric(value: unknown): number {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
type TableRow = { schema: string; name: string; tableBytes: string; indexBytes: string; totalBytes: string };
const TABLE_SQL = [
  'SELECT n.nspname AS schema, c.relname AS name,',
  'pg_table_size(c.oid)::text AS "tableBytes",',
  'pg_indexes_size(c.oid)::text AS "indexBytes",',
  'pg_total_relation_size(c.oid)::text AS "totalBytes"',
  'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace',
  "WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')",
  "AND n.nspname NOT LIKE 'pg_toast%'",
  'ORDER BY pg_total_relation_size(c.oid) DESC, n.nspname, c.relname',
].join(' ');

export async function readPostgresStorage(pool: Pick<Pool,'query'>): Promise<StorageUsage['postgres']> {
  try {
    const [size,tables] = await Promise.all([
      pool.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes'),
      pool.query<TableRow>(TABLE_SQL),
    ]);
    const all = tables.rows.map(row => ({
      schema: row.schema, name: row.name,
      tableBytes: numeric(row.tableBytes), indexBytes: numeric(row.indexBytes),
      totalBytes: numeric(row.totalBytes),
    }));
    return {
      state: 'ready', measuredAt: new Date().toISOString(),
      databaseBytes: numeric(size.rows[0]?.bytes),
      tableBytes: all.reduce((total, row) => total + row.tableBytes, 0),
      indexBytes: all.reduce((total, row) => total + row.indexBytes, 0),
      tableCount: all.length, tables: all.slice(0,8),
    };
  } catch {
    return { state: 'unavailable' };
  }
}

const ANALYTICS_QUERY = [
  'query AtlasR2Usage($accountTag: string!, $bucketName: string!, $monthStart: Time!, $recentStart: Time!, $now: Time!) {',
  'viewer { accounts(filter: { accountTag: $accountTag }) {',
  'storage: r2StorageAdaptiveGroups(limit: 1,',
  'filter: { bucketName: $bucketName, datetime_geq: $recentStart, datetime_leq: $now },',
  'orderBy: [datetime_DESC]) { max { objectCount payloadSize metadataSize } dimensions { datetime } }',
  'operations: r2OperationsAdaptiveGroups(limit: 1000,',
  'filter: { datetime_geq: $monthStart, datetime_leq: $now }) {',
  'sum { requests } dimensions { actionType } }',
  '} } }',
].join(' ');
type AnalyticsPayload = {
  data?: { viewer?: { accounts?: Array<{
    storage?: Array<{ max?: { objectCount?: unknown; payloadSize?: unknown }; dimensions?: { datetime?: string } }>;
    operations?: Array<{ sum?: { requests?: unknown }; dimensions?: { actionType?: string } }>;
  }> } };
  errors?: Array<{ message?: string }>;
};
export async function readR2Analytics(config: StorageUsageConfig,
  request: typeof fetch = fetch, now: Date = new Date()): Promise<StorageUsage['r2']> {
  const bucket = config.bucket?.trim();
  const base = { ...R2_ALLOWANCES, ...(bucket ? { bucket } : {}) };
  if (!bucket || !config.accountId || !config.analyticsToken) return { state: 'not_configured', ...base };
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) return { state: 'not_configured', ...base };
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const recentStart = new Date(Math.max(monthStart.getTime(), now.getTime() - 3 * 86_400_000));
  try {
    const response = await request('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: {
        authorization: 'Bearer ' + config.analyticsToken,
        'content-type': 'application/json',
      }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ query: ANALYTICS_QUERY, variables: {
        accountTag: config.accountId, bucketName: bucket, monthStart: monthStart.toISOString(),
        recentStart: recentStart.toISOString(), now: now.toISOString(),
      } }),
    });
    if (!response.ok) return { state: 'unavailable', ...base };
    const responseJson = await response.json() as AnalyticsPayload;
    if (responseJson.errors?.length) return { state: 'unavailable', ...base };
    const account = responseJson.data?.viewer?.accounts?.[0];
    if (!account || !Array.isArray(account.storage) || !Array.isArray(account.operations)) return { state: 'unavailable', ...base };
    const snapshot = account.storage[0];
    let writes = 0, reads = 0, other = 0;
    for (const entry of account.operations) {
      const action = (entry.dimensions?.actionType ?? '').toLowerCase();
      const count = numeric(entry.sum?.requests);
      if (classA.has(action)) writes += count;
      else if (classB.has(action)) reads += count;
      else other += count;
    }
    return {
      state: 'ready', ...base, refreshedAt: now.toISOString(),
      measuredAt: snapshot?.dimensions?.datetime,
      storageBytes: optionalNumber(snapshot?.max?.payloadSize),
      objectCount: optionalNumber(snapshot?.max?.objectCount),
      classA: writes, classB: reads, otherOperations: other,
      monthStart: monthStart.toISOString(), accountWideOperations: true,
    };
  } catch {
    return { state: 'unavailable', ...base };
  }
}

export class StorageUsageService {
  private cache?: { expires: number; result: StorageUsage['r2'] };
  private pending?: Promise<StorageUsage['r2']>;
  constructor(private readonly pool: Pick<Pool,'query'>, private readonly config: StorageUsageConfig,
    private readonly readR2: typeof readR2Analytics = readR2Analytics) {}

  async get(refresh = false): Promise<StorageUsage> {
    const [postgres,r2] = await Promise.all([readPostgresStorage(this.pool), this.getR2(refresh)]);
    return { postgres,r2 };
  }
  private async getR2(refresh: boolean): Promise<StorageUsage['r2']> {
    if (!refresh && this.cache && Date.now() < this.cache.expires) return this.cache.result;
    if (this.pending) return this.pending;
    this.pending = this.readR2(this.config).then(result => {
      this.cache = { result, expires: Date.now() + (result.state === 'ready' ? TTL_MS : 60_000) };
      return result;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
