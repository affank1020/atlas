import type { CoreService } from "../core/service.js";
import { RetrievalService } from "../retrieval/service.js";
import { AskAtlasService } from "../ai/ask-atlas/index.js";
import { OllamaAnswerGenerationProvider } from "../ai/ask-atlas/provider.js";
import { AskAtlasInterpreter } from "../ai/ask-atlas/interpreter.js";
import { AskAtlasRetrievalExecutor } from "../ai/ask-atlas/retrieval-executor.js";
export const createAskAtlas = (catalog: CoreService, retrieval: RetrievalService, fixedScope?: ConstructorParameters<typeof AskAtlasService>[4], baseUrl?: string) => { const provider = new OllamaAnswerGenerationProvider(undefined, baseUrl); return new AskAtlasService(retrieval, provider, new AskAtlasInterpreter(provider, catalog), new AskAtlasRetrievalExecutor(retrieval, catalog, retrieval), fixedScope); };

