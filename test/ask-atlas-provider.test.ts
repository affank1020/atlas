import assert from "node:assert/strict";
import test from "node:test";
import { finalAnswerOnly } from "../src/apps/ask-atlas/provider.js";

test("local model thinking never reaches answers or citation validation", () => {
    assert.equal(finalAnswerOnly("<think>Draft referring to [S99]</think>Final answer [S1]."), "Final answer [S1].");
    assert.equal(finalAnswerOnly("Unwrapped model scratchpad</think>Final answer [S1]."), "Final answer [S1].");
    assert.equal(finalAnswerOnly("Final answer [S1]."), "Final answer [S1].");
    assert.throws(() => finalAnswerOnly("<think>unfinished"), /final answer/);
    assert.throws(() => finalAnswerOnly("scratchpad</think>"), /final answer/);
});

test("provider requests final structured output and rejects output-limit truncation", async () => {
    const { OllamaAnswerGenerationProvider } = await import("../src/apps/ask-atlas/provider.js");
    const original = globalThis.fetch;
    let body: any;
    try {
        globalThis.fetch = async (_url, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ message: { content: JSON.stringify({ answer: "Completed [S1]." }) }, done_reason: "stop" }));
        };
        const provider = new OllamaAnswerGenerationProvider();
        const request = { model: "qwen3:4b" as const, system: "Use evidence", question: "Status?", evidence: "S1", history: [{ role: "user" as const, content: "LSEG" }] };
        assert.equal(await provider.generate(request), "Completed [S1].");
        assert.equal(body.think, false); assert.deepEqual(body.format.required, ["answer"]);
        assert.match(body.messages.at(-1).content, /<think>\s*<\/think>/);
        assert.match(body.messages[1].content, /LSEG/);
        globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: '{"answer":"unfinished' }, done_reason: "length" }));
        await assert.rejects(provider.generate(request), /output limit/);
    } finally { globalThis.fetch = original; }
});

test("record lists cannot transfer a deadline from one company to another", async () => {
    const { renderRecordList } = await import("../src/apps/ask-atlas/provider.js");
    const records = [
        { label: "S1", record: { company: "Softwire", status: "OA Received", yourTake: "No fixed deadline. Complete as soon as possible." } },
        { label: "S2", record: { company: "Macquarie", status: "OA Received", deadline: "2026-10-04", yourTake: "Psychometric assessment within 5 days." } },
    ];
    const answer = renderRecordList([{ label: "S1", fields: ["status", "deadline", "yourTake"] }, { label: "S2", fields: ["deadline", "yourTake"] }], records);
    const softwire = answer.split("\n\n")[0]!;
    assert.match(softwire, /No fixed deadline/); assert.doesNotMatch(softwire, /2026-10-04|5 days|Psychometric/);
    assert.match(answer, /Macquarie.*2026-10-04.*Psychometric assessment within 5 days/);
    assert.throws(() => renderRecordList([{ label: "S99", fields: [] }], records), /unknown source/);
});

test("list generation selects records and copies their fields instead of generating factual prose", async () => {
    const { OllamaAnswerGenerationProvider } = await import("../src/apps/ask-atlas/provider.js");
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            assert.deepEqual(body.format.required, ["items"]);
            return new Response(JSON.stringify({ message: { content: JSON.stringify({ items: [{ label: "S1", fields: ["status"] }] }) }, done_reason: "stop" }));
        };
        const result = await new OllamaAnswerGenerationProvider().generate({ model: "qwen3:4b", question: "Which assessments are pending?", system: "Use evidence", responseStyle: "record_list", evidence: JSON.stringify({ records: [{ label: "S1", record: { company: "Softwire", status: "OA Received" } }] }) });
        assert.equal(result, "- Softwire — status: OA Received [S1]");
    } finally { globalThis.fetch = original; }
});
