import { PROJECT_KEY_COPY_CONFIRMATION } from "./project-key-migration.js";
import { CAPTURE_PROJECT_KEY_MANIFEST } from "./project-key-ledger.js";

export type LedgerCommand = {
    mode: "capture" | "status" | "dry-run" | "apply" | "audit";
    projectId?: string; runId?: string; maxFiles: number; fromOrdinal?: number;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseProjectKeyLedgerArgs(args: string[]): LedgerCommand {
    const flags = new Map<string,string>();
    const modes=["--capture","--status","--dry-run","--apply","--audit"];
    for (const arg of args) {
        const parts=arg.split("=");
        const name=parts[0]!;
        if (![...modes,"--project","--run","--max-files","--from","--confirm"].includes(name) ||
            flags.has(name) || (modes.includes(name) ? parts.length !== 1 : parts.length !== 2))
            throw new Error("Invalid Project key checkpoint arguments.");
        flags.set(name,parts[1] ?? "");
    }
    const enabled=modes.filter(mode=>flags.has(mode));
    if (enabled.length !== 1) throw new Error("Exactly one Project key checkpoint mode is required.");
    const mode=enabled[0]!.slice(2) as LedgerCommand["mode"];
    const projectId=flags.get("--project"),runId=flags.get("--run");
    if (projectId !== undefined && !UUID.test(projectId)) throw new Error("Invalid Project key scope.");
    if (runId !== undefined && !UUID.test(runId)) throw new Error("Invalid Project key run.");
    if (mode === "capture") {
        if (!projectId || runId || flags.has("--max-files") || flags.has("--from") ||
            flags.get("--confirm") !== CAPTURE_PROJECT_KEY_MANIFEST)
            throw new Error("Capture requires Project ID and exact manifest confirmation.");
    } else if (mode === "status") {
        if (!runId || projectId || flags.has("--max-files") || flags.has("--from") ||
            flags.has("--confirm")) throw new Error("Status requires only a run ID.");
    } else {
        if (!runId || !projectId) throw new Error("Copy and audit require a run and Project ID.");
        if (mode === "apply" ? flags.get("--confirm") !== PROJECT_KEY_COPY_CONFIRMATION
            : flags.has("--confirm")) throw new Error("Apply requires exact copy confirmation.");
        if (mode !== "audit" && flags.has("--from"))
            throw new Error("An ordinal is only accepted in read-only audit mode.");
    }
    const maxFiles=flags.has("--max-files") ? Number(flags.get("--max-files")) : 3;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 5)
        throw new Error("Project key checkpoint page must be between 1 and 5.");
    const fromOrdinal=flags.has("--from") ? Number(flags.get("--from")) : undefined;
    if (fromOrdinal !== undefined && (!Number.isSafeInteger(fromOrdinal) || fromOrdinal < 0))
        throw new Error("Invalid key re-audit ordinal.");
    return {mode,maxFiles,...(projectId?{projectId}:{}),...(runId?{runId}:{}),
        ...(fromOrdinal!==undefined?{fromOrdinal}:{})};
}

