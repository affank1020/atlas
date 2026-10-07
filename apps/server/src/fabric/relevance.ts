import { projectRecord, queryTerms } from "./projection.js";
import type { FabricResult } from "./types.js";

// Remove conversational scaffolding, never domain terms, negation, or names such as Capital One.
const filler = new Set("a an the i me my we our you your it its is are was were be been do does did have has had can could would should please tell show give know about with for of to in on at and or what which who how when where happened happening s".split(" "));
export const retrievalTerms = (query: string) => queryTerms(query).filter(term => !filler.has(term));
const normalized = (value: string) => queryTerms(value).join(" ");

export function mentionsEntity(result: FabricResult, query: string): boolean {
    const question = ` ${normalized(query)} `;
    return projectRecord(result.record.data).fields.some(field => {
        if (!field.searchable || !/(^|\.)(company|name|title|employer|organization|organisation|subject)$/i.test(field.path)) return false;
        const value = normalized(field.text.slice(field.text.indexOf(":") + 1));
        return value.length >= 3 && retrievalTerms(value).length > 0 && question.includes(` ${value} `);
    });
}

// Similar wording is not proof of equivalence. Only collapse a projection when all
// its field/value pairs are present in the other; different statuses/entities survive.
export function containsProjection(richer: FabricResult, smaller: FabricResult): boolean {
    const fields = (result: FabricResult) => projectRecord(result.record.data).fields.filter(field => field.searchable).map(field => `${field.path}:${field.text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim()}`);
    const whole = new Set(fields(richer));
    const part = fields(smaller);
    return part.length > 0 && part.every(value => whole.has(value));
}
