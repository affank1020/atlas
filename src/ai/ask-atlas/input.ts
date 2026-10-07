import { z } from "zod";
import { ASK_ATLAS_MODELS } from "./types.js";

export const askAtlasInputSchema = z.object({
    question: z.string().trim().min(1).max(4000),
    projectIds: z.array(z.string().uuid()).max(100).optional(),
    maxRecords: z.number().int().min(1).max(50).optional(),
    model: z.enum(ASK_ATLAS_MODELS).optional(),
    retrievalMode: z.enum(["auto", "direct", "planned"]).optional(),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).max(12).optional(),
});
