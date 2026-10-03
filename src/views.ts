import Handlebars from "handlebars";
import { AtlasError } from "./catalog.js";
import type { FieldDefinition, Store, ViewQuery } from "./types.js";

const bindingPattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const forbiddenHtml = /<(?:script|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b|\son[a-z]+\s*=|(?:href|src|action|formaction)\s*=/i;
const forbiddenCss = /@import\b|expression\s*\(|url\s*\(|<\/?style\b|<\/?script\b/i;

export function validatePresentation(html: string, css: string) {
    if (forbiddenHtml.test(html)) throw new AtlasError("View HTML contains an executable or unsafe mechanism.");
    if (forbiddenCss.test(css)) throw new AtlasError("View CSS cannot import or load external resources.");
    try { Handlebars.precompile(html, { strict: true }); } catch (error) { throw new AtlasError(`Invalid Handlebars template: ${error instanceof Error ? error.message : String(error)}`); }
}
export function sanitizeRenderedHtml(html: string) { if (forbiddenHtml.test(html)) throw new AtlasError("Rendered View HTML contains an executable or unsafe mechanism."); return html; }
export function renderTemplate(html: string, data: Record<string, unknown>) { try { return sanitizeRenderedHtml(Handlebars.compile(html, { strict: true, noEscape: false })(data)); } catch (error) { if (error instanceof AtlasError) throw error; throw new AtlasError(`View template rendering failed: ${error instanceof Error ? error.message : String(error)}`); } }
export function validateSlug(slug: string) { if (!slugPattern.test(slug)) throw new AtlasError("View slug must contain lowercase letters, numbers, and single hyphens only."); }
export function validateViewQueries(queries: ViewQuery[], stores: Store[]) {
    if (!Array.isArray(queries)) throw new AtlasError("View queries must be an array.");
    const names = new Set<string>();
    for (const query of queries) {
        if (!bindingPattern.test(query.name)) throw new AtlasError(`Invalid query binding name '${query.name}'.`);
        if (names.has(query.name)) throw new AtlasError(`Duplicate query binding name '${query.name}'.`);
        names.add(query.name);
        const store = stores.find(item => item.id === query.storeId && !item.archivedAt);
        if (!store) throw new AtlasError(`Store '${query.storeId}' was not found in the View's project or is archived.`, "NOT_FOUND");
        if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw new AtlasError("View query limits must be between 1 and 100.");
        const fields = new Map(store.schema.fields.map(field => [field.name, field]));
        for (const filter of query.filters ?? []) { const field = fields.get(filter.field); if (!field) throw new AtlasError(`Unknown filter field '${filter.field}' for store '${store.name}'.`); validateOperator(field, filter.operator, filter.value); }
        for (const sort of query.sort ?? []) if (!fields.has(sort.field) && !["createdAt", "updatedAt"].includes(sort.field)) throw new AtlasError(`Unknown sort field '${sort.field}' for store '${store.name}'.`);
    }
    return structuredClone(queries);
}
function validateOperator(field: FieldDefinition, operator: string, value: unknown) {
    if (["gt", "gte", "lt", "lte"].includes(operator) && !["number", "date", "datetime", "string"].includes(field.type)) throw new AtlasError(`Operator '${operator}' is not compatible with ${field.type} field '${field.name}'.`);
    if (operator === "contains" && !["string", "array"].includes(field.type)) throw new AtlasError(`Operator 'contains' is not compatible with ${field.type} field '${field.name}'.`);
    if (operator === "in" && !Array.isArray(value)) throw new AtlasError(`Filter 'in' for '${field.name}' requires an array value.`);
}
