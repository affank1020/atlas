export type FieldRepresentation={path:string;text:string;searchText:string;searchable:boolean;excludedReason?:"null"|"empty-collection"|"uuid"|"url"|"opaque-identifier"};
export type RecordProjection={displayText:string;searchableText:string;fields:FieldRepresentation[];searchableFields:string[];displayOnlyFields:{path:string;reason:string}[]};
const label=(value:string)=>value.replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/[_-]+/g," ").trim().toLocaleLowerCase();
const scalar=(value:unknown)=>value===null?"null":typeof value==="string"?value:String(value);
export function projectRecord(data:Record<string,unknown>):RecordProjection{
    const fields:FieldRepresentation[]=[];
    const excludedReason=(value:unknown):FieldRepresentation["excludedReason"]=>{if(value===null)return "null";if(typeof value!=="string")return undefined;if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))return "uuid";if(/^https?:\/\//i.test(value))return "url";if(value.length>=24&&!/\s/u.test(value)&&/[\p{L}]/u.test(value)&&/\d/u.test(value)&&/^[\p{L}\p{N}.:_-]+$/u.test(value))return "opaque-identifier";return undefined;};
    const visit=(value:unknown,path:string[])=>{
        if(Array.isArray(value)){ if(!value.length) fields.push({path:path.join("."),text:`${path.map(label).join(" ")}: []`,searchText:"",searchable:false,excludedReason:"empty-collection"}); else value.forEach((item)=>visit(item,path)); return; }
        if(value!==null&&typeof value==="object"){ for(const [key,child] of Object.entries(value as Record<string,unknown>)) visit(child,[...path,key]); return; }
        const name=path.map(label).join(" ");const reason=excludedReason(value);fields.push({path:path.join("."),text:`${name}: ${scalar(value)}`,searchText:reason?(reason==="null"?"":name):`${name}: ${scalar(value)}`,searchable:!reason,...(reason&&{excludedReason:reason})});
    };
    for(const [key,value] of Object.entries(data)) visit(value,[key]);
    return {fields,displayText:fields.map((field)=>field.text).join(" | "),searchableText:fields.map((field)=>field.searchText).filter(Boolean).join(" | "),searchableFields:[...new Set(fields.filter((field)=>field.searchable).map((field)=>field.path))],displayOnlyFields:fields.filter((field)=>!field.searchable).map((field)=>({path:field.path,reason:field.excludedReason!}))};
}
export function queryTerms(query:string){return [...new Set(query.toLocaleLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu)??[])];}
