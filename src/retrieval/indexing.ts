export type RetrievalDocument={recordId:string;sourceId:string;projectId:string;projectName:string;storeId:string;storeName:string;data:Record<string,unknown>;createdAt:string;updatedAt:string;fieldText:string;searchableText:string;displayText:string};

/** Published-corpus write port; the frozen Fabric repository supplies it today. */
export interface RetrievalIndex {
    synchronize(): Promise<void>;
    replaceExternalDocuments(sourceType: string, documents: RetrievalDocument[]): Promise<void>;
}
