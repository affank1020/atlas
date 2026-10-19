import type { AtlasData, AtlasRecord, AuditEvent, Page, RecordFilter, SortSpec, Store } from "../types.js";
export type CatalogueRead = { projectId?: string; includeArchived?: boolean; stores?: true | string; views?: true | string; viewSlug?: string };
export type AuditRead = { workspaceId?: string; projectId?: string; storeId?: string; recordId?: string; viewId?: string; operation?: string; viewOperations?: boolean; limit?: number };
export type EntityCounts = { active: number; archived: number; total: number };
export type CatalogueCounts = Record<'projects' | 'stores' | 'records' | 'views', EntityCounts>;
export interface AtlasRepository {
    /** Sparse, read-only state for service validation; records/auditEvents are intentionally empty. */
    readCatalogue?(input: CatalogueRead): Promise<AtlasData>;
    readAudit?(input: AuditRead): Promise<AuditEvent[]>;
    countCatalogue?(): Promise<CatalogueCounts>;
 snapshot(): Promise<AtlasData>; transaction<T>(operation: (draft: AtlasData) => T | Promise<T>): Promise<T>; queryRecords(store: Store, input: { filters?: RecordFilter[]; sort?: SortSpec[]; limit?: number; offset?: number; searchText?: string; includeArchived?: boolean }): Promise<Page<AtlasRecord>>; close(): Promise<void>; }
