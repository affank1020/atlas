import { FabricContextService } from "./context.js";
import { FabricSearchRepository } from "./repository.js";
import { FabricSearchService } from "./search.js";
import {OllamaEmbeddingProvider,type EmbeddingProvider} from "./embeddings.js";
import {FabricAuthorityService} from "./authority.js";
export function createFabric(databaseUrl:string,embeddingProvider:EmbeddingProvider|null=new OllamaEmbeddingProvider()){const repository=new FabricSearchRepository(databaseUrl);const search=new FabricSearchService(repository,embeddingProvider);const authority=new FabricAuthorityService(repository);const context=new FabricContextService(search,authority);return {repository,search,authority,context};}
export type FabricServices=ReturnType<typeof createFabric>;
