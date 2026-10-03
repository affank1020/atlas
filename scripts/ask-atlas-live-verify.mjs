// Read-only smoke checks against an existing local Atlas + Ollama installation.
// Uses the same example entities as Observatory; deterministic regressions live in test/.
import "dotenv/config";
const base = process.env.ATLAS_API_URL ?? "http://127.0.0.1:3000";
async function ask(question, history = [], extra = {}) {
    const response = await fetch(`${base}/api/tools/ask_atlas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, history, ...extra }), signal: AbortSignal.timeout(180_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    if (/<\/?think>/i.test(result.answer)) throw new Error("Thinking leaked into answer");
    console.log(JSON.stringify({ question, answer: result.answer, sources: result.sources.map(source => ({ label: source.label, store: source.storeName })), latencyMs: result.diagnostics.latencyMs, strategy: result.diagnostics.retrieval?.strategy, interpreter: result.diagnostics.interpreter, truncated: result.diagnostics.truncated, validationFailure: result.diagnostics.validationFailure }));
    return result;
}
const first = await ask("Can you tell me what happened with my LSEG application?");
await ask("When did I complete that assessment?", [{ role: "user", content: first.question }, { role: "assistant", content: first.answer.slice(0, 4000) }]);
await ask("What do you know about my Amazon internship?");
await ask("Which online assessments are still pending?");
await ask("What is the launch code for the nonexistent quasar volcano project?");
import "dotenv/config";
