export interface EmbeddingProvider{readonly model:string;embed(texts:string[]):Promise<number[][]>;}
export class OllamaEmbeddingProvider implements EmbeddingProvider{
 readonly model:string;constructor(model=process.env.FABRIC_EMBEDDING_MODEL??"nomic-embed-text",readonly baseUrl=process.env.OLLAMA_URL??"http://127.0.0.1:11434"){this.model=model;}
 async embed(texts:string[]){if(!texts.length)return[];const response=await fetch(`${this.baseUrl}/api/embed`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:this.model,input:texts})});if(!response.ok)throw new Error(`Ollama embedding request failed (${response.status}): ${await response.text()}`);const body=await response.json() as {embeddings?:number[][]};if(!Array.isArray(body.embeddings)||body.embeddings.length!==texts.length)throw new Error("Ollama returned an invalid embeddings response.");return body.embeddings;}
}
