import type { AskAtlasService } from "../ask-atlas/index.js";
import type { AskAtlasInput, AskAtlasResponse } from "../ask-atlas/types.js";
import { PORTFOLIO_PROJECT_ID } from "../../integrations/contentful.js";

/** Public-safe facade over the shared Ask Atlas conversation and grounding engine. */
export class AskPortfolioService {
    constructor(readonly askAtlas: Pick<AskAtlasService, "ask">) {}

    async ask(input: AskAtlasInput): Promise<AskAtlasResponse> {
        const response = await this.askAtlas.ask({
            ...input,
            // Callers cannot widen this boundary. Planned retrieval is Core-aware,
            // so the derived Contentful corpus deliberately uses Fabric directly.
            projectIds: [PORTFOLIO_PROJECT_ID],
            retrievalMode: "direct",
        });
        const answer = response.answer
            .replace("Atlas doesn't currently contain enough information to answer that reliably.", "The published portfolio doesn't currently contain enough information to answer that reliably.")
            .replace("Ask me about your Atlas records.", "Ask me about the published portfolio.");
        return { ...response, answer };
    }
}
