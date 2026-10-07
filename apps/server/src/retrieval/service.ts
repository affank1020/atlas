import type { AuthorityDecision, ContextResponse, RetrievalMode, RetrievalResult, SearchResponse } from "./types.js";
export interface ContextProvider {
    request(input: { query: string; projectIds?: string[]; sourceTypes?: string[]; maxRecords?: number }): Promise<ContextResponse>;
}
export interface SearchProvider {
    search(input: { query: string; projectIds?: string[]; sourceTypes?: string[]; limit?: number; mode?: RetrievalMode }): Promise<SearchResponse>;
}
export interface AuthorityProvider {
    apply(results: RetrievalResult[]): Promise<{ results: RetrievalResult[]; decisions: AuthorityDecision[] }>;
}
/** Frozen Fabric supplies these ports today; consumers do not construct it. */
export class RetrievalService implements ContextProvider, SearchProvider, AuthorityProvider {
    constructor(private readonly searchProvider: SearchProvider, private readonly contextProvider: ContextProvider, private readonly authorityProvider: AuthorityProvider) {}
    search(input: Parameters<SearchProvider['search']>[0]) { return this.searchProvider.search(input); }
    request(input: Parameters<ContextProvider['request']>[0]) { return this.contextProvider.request(input); }
    context(input: Parameters<ContextProvider['request']>[0]) { return this.request(input); }
    apply(results: RetrievalResult[]) { return this.authorityProvider.apply(results); }
}
