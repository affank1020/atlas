import { FabricSearchService } from "./search.js";
import { containsProjection, mentionsEntity } from "./relevance.js";
import type { ContextResponse, FabricResult } from "./types.js";
import type { FabricAuthorityService } from "./authority.js";

export class FabricContextService {
    constructor(readonly searchService: FabricSearchService, readonly authorityService?: FabricAuthorityService) {}

    async request(input: { query: string; projectIds?: string[]; sourceTypes?: string[]; maxRecords?: number }): Promise<ContextResponse> {
        const maxRecords = Math.min(Math.max(input.maxRecords ?? 10, 1), 50);
        const search = await this.searchService.search({ query: input.query, projectIds: input.projectIds, sourceTypes: input.sourceTypes, limit: 100 });
        const termTarget = Math.min(3, Math.max(1, Math.ceil(search.diagnostics.terms.length * 0.67)));
        const eligible = search.results.filter(result => result.ranking.exactPhrase || mentionsEntity(result, input.query) ||
            result.ranking.matchedTermCount >= termTarget ||
            (result.ranking.semanticFound && (result.ranking.semanticSimilarity ?? -1) >= 0.72));
        let policyResults = eligible;
        let authorityStatus: "ready" | "unavailable" = "ready", authorityError: string | undefined;
        let authorityDecisions: ContextResponse["diagnostics"]["authorityDecisions"] = [];
        try {
            if (this.authorityService) {
                const policy = await this.authorityService.apply(eligible);
                policyResults = policy.results; authorityDecisions = policy.decisions;
            }
        } catch (error) { authorityStatus = "unavailable"; authorityError = error instanceof Error ? error.message : String(error); }
        // Exact named subjects precede broad semantic neighbours in the bounded pack.
        policyResults = [...policyResults].sort((a, b) => Number(mentionsEntity(b, input.query)) - Number(mentionsEntity(a, input.query)));
        const conflictingIds = new Set(authorityDecisions.filter(d => d.unresolvedAmbiguity).flatMap(d => d.records.map(r => r.recordId)));
        const selections: FabricResult[] = [];
        const diversification: ContextResponse["diagnostics"]["diversification"] = [];
        for (const candidate of policyResults) {
            const duplicateIndex = selections.findIndex(selected => !conflictingIds.has(candidate.record.id) && !conflictingIds.has(selected.record.id) &&
                (containsProjection(candidate, selected) || containsProjection(selected, candidate)));
            if (duplicateIndex < 0) { selections.push(candidate); continue; }
            const kept = selections[duplicateIndex]!;
            if (containsProjection(candidate, kept)) {
                selections[duplicateIndex] = candidate;
                diversification.push({ droppedRecordId: kept.record.id, keptRecordId: candidate.record.id, overlap: 1, reason: "identical field/value subset; richer record retained" });
            } else diversification.push({ droppedRecordId: candidate.record.id, keptRecordId: kept.record.id, overlap: 1, reason: "identical field/value subset; richer record retained" });
        }
        const bounded = selections.slice(0, maxRecords);
        return { query: search.query, selections: bounded, diagnostics: {
            searchedProjects: search.diagnostics.searchedProjects, searchedStores: search.diagnostics.searchedStores,
            candidateCount: search.diagnostics.candidateCount, selectedCount: bounded.length, maxRecords,
            relevanceFloorRejected: search.results.length - eligible.length, authorityStatus, ...(authorityError && { authorityError }), authorityDecisions,
            authoritySuppressed: authorityDecisions.reduce((sum, decision) => sum + decision.suppressedRecordIds.length, 0),
            unresolvedConflicts: authorityDecisions.filter(decision => decision.unresolvedAmbiguity).length,
            redundancyRejected: diversification.length, diversification,
            semanticStatus: search.diagnostics.semanticStatus, ...(search.diagnostics.semanticError && { semanticError: search.diagnostics.semanticError }),
            truncated: selections.length > maxRecords || search.diagnostics.candidateCount > search.results.length,
        } };
    }
}
