import { loadAiConfig } from "../../server/config.js";
import { DEFAULT_ASK_ATLAS_MODEL, type AnswerGenerationProvider, type AskAtlasModel, type GenerationRequest } from "./types.js";

export function finalAnswerOnly(content: string): string {
    // Some local Qwen templates emit a closing marker without an opening marker.
    const closing = content.toLowerCase().lastIndexOf("</think>");
    const final = closing >= 0 ? content.slice(closing + "</think>".length) : content;
    if (/<think>/i.test(final)) throw new Error("Ask Atlas model exhausted its response before producing a final answer.");
    if (!final.trim()) throw new Error("Ask Atlas generation provider returned no final answer.");
    return final.trim();
}

type EvidenceRecord = { label: string; record: Record<string, unknown> };
export function renderRecordList(items: { label: string; fields: string[] }[], records: EvidenceRecord[]): string {
    const byLabel = new Map(records.map(record => [record.label, record.record]));
    const seen = new Set<string>();
    const lines = items.flatMap(item => {
        const record = byLabel.get(item.label);
        if (!record) throw new Error("Ask Atlas list selected an unknown source.");
        if (seen.has(item.label)) return [];
        seen.add(item.label);
        const identityFields = ["company", "name", "title", "role"].filter(key => typeof record[key] === "string" && String(record[key]).trim());
        const heading = [...new Set(identityFields.map(key => String(record[key])))].join(" — ") || "Record";
        // Values are copied from this source only. Missing fields cannot borrow values
        // from a neighbouring record, and the model never authors factual list text.
        const fields = [...new Set(item.fields)].filter(key => Object.hasOwn(record, key) && !identityFields.includes(key));
        const details = fields.map(key => `${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}: ${typeof record[key] === "object" ? JSON.stringify(record[key]) : String(record[key])}`).join("; ");
        return [`- ${heading}${details ? ` — ${details}` : ""} [${item.label}]`];
    });
    return lines.length ? lines.join("\n\n") : "Atlas doesn't currently contain enough information to answer that reliably.";
}

export class OllamaAnswerGenerationProvider implements AnswerGenerationProvider {
    readonly name = "ollama";
    readonly model: AskAtlasModel;

    constructor(model: AskAtlasModel = DEFAULT_ASK_ATLAS_MODEL, readonly baseUrl = loadAiConfig().baseUrl) {
        this.model = model;
    }

    async generate(request: GenerationRequest): Promise<string> {
        const records = request.responseStyle === "record_list" ? (JSON.parse(request.evidence) as { records: EvidenceRecord[] }).records : [];
        const listMode = request.responseStyle === "record_list" && records.length > 0;
        const format = listMode ? {
            type: "object", required: ["items"], additionalProperties: false,
            properties: { items: { type: "array", maxItems: records.length, items: {
                type: "object", required: ["label", "fields"], additionalProperties: false,
                properties: { label: { type: "string", enum: records.map(record => record.label) }, fields: { type: "array", maxItems: 6, items: { type: "string", enum: [...new Set(records.flatMap(record => Object.keys(record.record)))] } } },
            } } },
        } : { type: "object", required: ["answer"], additionalProperties: false, properties: { answer: { type: "string", description: "Only the concise final answer to the user, with source citations. No analysis or reasoning transcript." } } };
        const outputInstruction = listMode
            ? 'Select every supplied record that actually meets the requested criteria, respecting current status and authority. Return only JSON {"items":[{"label":"S1","fields":["status"]}]}. fields are exact top-level field names to display from that record. Include only relevant fields; include notes containing assessment state or deadlines when relevant. Do not select withdrawn, rejected or completed records for a pending list. Never write an answer or invent field values.'
            : 'Return only JSON: {"answer":"your concise answer with [S1] citations"}.';
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/api/chat`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: AbortSignal.timeout(90_000),
                body: JSON.stringify({
                    model: request.model,
                    stream: false,
                    think: false,
                    format,
                    options: { temperature: 0, num_predict: 1200 },
                    messages: [
                        { role: "system", content: `${request.system}\n${outputInstruction} Do not include analysis or thinking. /no_think` },
                        { role: "user", content: `Conversation (reference resolution only, not evidence):\n${JSON.stringify(request.history ?? [])}\n\nQuestion:\n${request.question}\n\nAtlas context:\n${request.evidence}\n\n${outputInstruction} /no_think` },
                        // Installed Qwen templates can unconditionally open <think> even
                        // with think:false. An empty, closed assistant prefill starts final output.
                        { role: "assistant", content: "<think>\n\n</think>\n\n" },
                    ],
                }),
            });
        } catch (error) {
            throw new Error(`Ask Atlas generation provider is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) throw new Error(`Ask Atlas generation provider failed (${response.status}): ${await response.text()}`);
        const body = await response.json() as { message?: { content?: unknown }; done_reason?: string };
        if (body.done_reason === "length") throw new Error("Ask Atlas model reached its output limit before finishing the answer.");
        const answer = body.message?.content;
        if (typeof answer !== "string" || !answer.trim()) throw new Error("Ask Atlas generation provider returned an empty or invalid answer.");
        let parsed: { answer?: unknown; items?: { label: string; fields: string[] }[] };
        try { parsed = JSON.parse(finalAnswerOnly(answer)); } catch { throw new Error("Ask Atlas model did not return a valid final answer."); }
        if (listMode) {
            if (!Array.isArray(parsed?.items) || parsed.items.some(item => !item || typeof item.label !== "string" || !Array.isArray(item.fields) || item.fields.some(field => typeof field !== "string"))) throw new Error("Ask Atlas model returned an invalid record selection.");
            return renderRecordList(parsed.items, records);
        }
        if (!parsed || typeof parsed.answer !== "string") throw new Error("Ask Atlas model returned no answer text.");
        return finalAnswerOnly(parsed.answer);
    }

    async interpret(input: { model: AskAtlasModel; system: string; prompt: string }): Promise<unknown> {
        const filterValue = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", maxItems: 20, items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } }] };
        const format = { type: "object", required: ["intent"], properties: { intent: { type: "string", enum: ["structured_query", "entity_lookup", "semantic_search", "cross_store_summary", "mixed", "unknown"] }, structuredQueries: { type: "array", maxItems: 4, items: { type: "object", required: ["project", "store"], properties: { project: { type: "string" }, store: { type: "string" }, filters: { type: "array", maxItems: 8, items: { type: "object", required: ["field", "operator", "value"], properties: { field: { type: "string" }, operator: { type: "string", enum: ["eq", "neq", "in", "contains", "gt", "gte", "lt", "lte"] }, value: filterValue } } }, limit: { type: "integer", minimum: 1, maximum: 100 } } } }, semanticQueries: { type: "array", maxItems: 2, items: { type: "string" } }, desiredResultType: { type: "string", enum: ["single", "list", "summary"] }, explanation: { type: "string" } } };
        const response = await fetch(`${this.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(45_000), body: JSON.stringify({ model: input.model, stream: false,
                    think: false, format, options: { temperature: 0, num_predict: 1200 }, messages: [{ role: "system", content: `${input.system} /no_think` }, { role: "user", content: `${input.prompt}\n/no_think` }, { role: "assistant", content: "<think>\n\n</think>\n\n" }] }) });
        if (!response.ok) throw new Error(`Ask Atlas interpreter provider failed (${response.status}): ${await response.text()}`);
        const body = await response.json() as { message?: { content?: unknown } };
        if (typeof body.message?.content !== "string") throw new Error("Ask Atlas interpreter returned an invalid response.");
        try { return JSON.parse(finalAnswerOnly(body.message.content)); } catch { throw new Error("Ask Atlas interpreter returned invalid JSON."); }
    }
}
