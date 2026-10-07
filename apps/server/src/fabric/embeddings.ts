import { loadAiConfig, loadRetrievalConfig } from "../server/config.js";
export interface EmbeddingProvider{readonly model:string;embed(texts:string[]):Promise<number[][]>;}
export class OllamaEmbeddingProvider implements EmbeddingProvider{
 readonly model:string;constructor(model=loadRetrievalConfig().embeddingModel,readonly baseUrl=loadAiConfig().baseUrl){this.model=model;}
 async embed(texts:string[]){if(!texts.length)return[];const response=await fetch(`${this.baseUrl}/api/embed`,{method:"POST",signal:AbortSignal.timeout(30_000),headers:{"content-type":"application/json"},body:JSON.stringify({model:this.model,input:texts})});if(!response.ok)throw new Error(`Ollama embedding request failed (${response.status}): ${await response.text()}`);const body=await response.json() as {embeddings?:number[][]};if(!Array.isArray(body.embeddings)||body.embeddings.length!==texts.length)throw new Error("Ollama returned an invalid embeddings response.");return body.embeddings;}
}
