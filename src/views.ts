import Handlebars from "handlebars";
import { parseFragment } from "parse5";
import { parse } from "acorn";
import { z } from "zod";
import { AtlasError } from "./shared/errors.js";
import type { FieldDefinition, Store, ViewQuery, ViewManifest } from "./types.js";

const bindingPattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const paramKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).refine(x=>!["constructor","prototype","__proto__"].includes(x));
export const viewManifestSchema = z.object({
    viewKitVersion: z.literal(1).optional(),
    layout: z.enum(["dashboard", "document", "wide"]).optional(),
    capabilities: z.array(z.enum(["client-script", "url-params", "record-actions"])).max(3).refine(x=>new Set(x).size===x.length,"Duplicate capability").optional(),
    params: z.record(paramKey,z.string().max(500)).refine(x=>Object.keys(x).length<=16,"At most 16 parameters").optional(),
}).strict();
export function validateManifest(value: unknown): ViewManifest | undefined {
    if(value===undefined||value===null)return undefined;
    const result=viewManifestSchema.safeParse(value);
    if(!result.success)throw new AtlasError(`Invalid View manifest: ${result.error.message}`);
    if(Object.keys(result.data.params??{}).length&&!result.data.capabilities?.includes("url-params"))throw new AtlasError("Manifest params require the url-params capability.");
    return result.data;
}
export function validateParams(manifest: ViewManifest | undefined, value: unknown = {}): Record<string,string> {
    const result=z.record(paramKey,z.string().max(500)).safeParse(value);
    if(!result.success)throw new AtlasError("View parameters must be short string values with valid names.");
    const allowed=manifest?.params??{};
    for(const key of Object.keys(result.data))if(!manifest?.capabilities?.includes("url-params")||!Object.hasOwn(allowed,key))throw new AtlasError(`Undeclared View parameter '${key}'.`);
    return {...allowed,...result.data};
}
const tags=new Set('a img abbr address mark s del ins sup sub u samp kbd var wbr main header footer section article aside nav div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong em b i small br hr pre code blockquote table caption thead tbody tfoot tr th td colgroup col details summary time figure figcaption label input button select option optgroup textarea dialog canvas progress meter fieldset legend output datalist'.split(' '));
const components=new Set('atlas-page atlas-header atlas-section atlas-card atlas-stat atlas-stat-grid atlas-badge atlas-table atlas-tabs atlas-progress atlas-empty-state atlas-loading atlas-error atlas-button atlas-toast'.split(' '));
const unsafeAttributes=new Set('href src srcset action formaction srcdoc ping target rel download data poster background codebase xlink:href xmlns is nonce http-equiv'.split(' '));
const forbiddenCss = /@import\b|expression\s*\(|url\s*\(|<\/?style\b|<\/?script\b/i;
function safeExternalUrl(value:string){
    if(!/^https?:\/\/[^/?#]+/i.test(value)||/[\u0000-\u0020\u007f\\]/.test(value))return false;
    try{const url=new URL(value);return (url.protocol==='http:'||url.protocol==='https:')&&!!url.hostname&&!url.username&&!url.password}
    catch{return false}
}
function validateMarkup(html:string,manifest?:ViewManifest,rendered=false){
    const links:number[]=[];
    const walk=(node:any)=>{
        if(node.tagName){
            if(!tags.has(node.tagName)&&!components.has(node.tagName))throw new AtlasError(`View HTML contains an executable or unsafe mechanism: <${node.tagName}>.`);
            if(components.has(node.tagName)&&manifest?.viewKitVersion!==1)throw new AtlasError("Atlas components require viewKitVersion: 1.");
            if(!manifest&&['input','button','select','textarea'].includes(node.tagName))throw new AtlasError("Interactive controls require a Stage 2 manifest.");
            for(const attr of node.attrs??[]){
                if(attr.name==='href'&&node.tagName!=='a')throw new AtlasError("View links are only supported on <a> elements.");
                if(attr.name==='href'&&node.tagName==='a'){
                    if(attr.namespace)throw new AtlasError(`Unsupported View attribute '${attr.name}'.`);
                    if(rendered||!attr.value.includes('{{')){
                        if(!safeExternalUrl(attr.value))throw new AtlasError('View links require a valid http:// or https:// URL.');
                    }
                    continue;
                }
                if(attr.name.startsWith('on')||unsafeAttributes.has(attr.name)||attr.namespace)throw new AtlasError(`Unsupported View attribute '${attr.name}'.`);
                if(attr.name==='style'&&forbiddenCss.test(attr.value))throw new AtlasError("View CSS cannot import or load external resources.");
                if(attr.name==='param'&&(!manifest?.capabilities?.includes('url-params')||!Object.hasOwn(manifest.params??{},attr.value)))throw new AtlasError(`Undeclared View parameter '${attr.value}'.`);
            }
            if(rendered&&node.tagName==='a'&&(node.attrs??[]).some((attr:any)=>attr.name==='href'))links.push(node.sourceCodeLocation.startTag.endOffset-1);
        }
        for(const child of node.childNodes??[])walk(child);
    };walk(parseFragment(html,{sourceCodeLocationInfo:rendered}));
    if(!rendered)return html;
    for(const offset of links.sort((a,b)=>b-a))html=html.slice(0,offset)+' target="_blank" rel="noopener noreferrer"'+html.slice(offset);
    return html;
}
const prohibited=new Set('window self globalThis parent top frames opener location origin documentURI URL referrer cookie domain defaultView ownerDocument contentWindow contentDocument fetch XMLHttpRequest WebSocket EventSource Worker SharedWorker ServiceWorker navigator localStorage sessionStorage indexedDB caches sendBeacon open postMessage eval Function constructor prototype __proto__ Reflect Proxy getPrototypeOf setPrototypeOf getOwnPropertyDescriptor getOwnPropertyDescriptors importScripts DOMParser innerHTML outerHTML insertAdjacentHTML write writeln createContextualFragment attachShadow href src srcset action formaction srcdoc ping target rel relList download createAttribute createAttributeNS createElementNS createDocument createHTMLDocument importNode adoptNode implementation attributes setAttributeNode setAttributeNodeNS getAttributeNode getAttributeNodeNS defineProperty defineProperties __lookupGetter__ __lookupSetter__ __defineGetter__ __defineSetter__'.split(' '));
export function validateScript(script:string,manifest?:ViewManifest){
    if(!script.trim())return;
    if(!manifest?.capabilities?.includes('client-script'))throw new AtlasError("View script requires the client-script capability.");
    if(/<\/script/i.test(script))throw new AtlasError("Script closing tags are unsupported in View scripts.");
    if(script.length>100000)throw new AtlasError("View script is limited to 100,000 characters.");
    let ast:any;try{ast=parse(script,{ecmaVersion:2022,sourceType:'script'});}catch(e){throw new AtlasError(`Invalid View script: ${(e as Error).message}`)}
    const walk=(node:any,parent?:any)=>{
        if(!node||typeof node!=='object')return;
        const method=node.property?.name??node.property?.value;
        if(node.type==='MemberExpression'&&['createElement','setAttribute','setAttributeNS','removeAttribute','toggleAttribute'].includes(method)){
            if(parent?.type!=='CallExpression'||parent.callee!==node)throw new AtlasError('DOM construction methods must be called directly.');
            if(method==='createElement'){const tag=parent.arguments[0];if(tag?.type!=='Literal'||typeof tag.value!=='string'||(!tags.has(tag.value)&&!components.has(tag.value)))throw new AtlasError('createElement requires a literal supported HTML or Atlas component tag.');}
        }
        if(node.type==='Identifier'&&['createElement','setAttribute','setAttributeNS','removeAttribute','toggleAttribute'].includes(node.name)&&parent?.type!=='MemberExpression')throw new AtlasError('DOM construction methods cannot be aliased.');
        if(node.type==='MemberExpression'&&node.object?.name==='atlas'&&['params','setParam'].includes(node.property.name??node.property.value)&&!manifest?.capabilities?.includes('url-params'))throw new AtlasError('Script parameters require the url-params capability.');
        if(node.type==='MemberExpression'&&node.object?.name==='atlas'&&(node.property.name??node.property.value)==='action'&&!manifest?.capabilities?.includes('record-actions'))throw new AtlasError('atlas.action requires the record-actions capability.');
        if(node.type==='ImportExpression'||node.type==='WithStatement'||(node.type==='Identifier'&&prohibited.has(node.name)&&!(node.name==='action'&&parent?.type==='MemberExpression'&&parent.object?.name==='atlas'&&parent.property===node)))throw new AtlasError(`Unsupported View script API: ${node.name??node.type}.`);
        if(node.type==='MemberExpression'&&node.computed){if(node.property.type!=='Literal'||!['string','number'].includes(typeof node.property.value))throw new AtlasError("Dynamic property access is unsupported; use named properties or Array.at(index).");if(prohibited.has(String(node.property.value))&&!(node.object?.name==='atlas'&&node.property.value==='action'))throw new AtlasError(`Unsupported View script property: ${node.property.value}.`)}
        if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&['setAttribute','setAttributeNS','removeAttribute','toggleAttribute'].includes(node.callee.property.name??node.callee.property.value)){
            const attr=node.arguments[0];if(node.callee.property.name==='setAttributeNS'||attr?.type!=='Literal'||typeof attr.value!=='string'||unsafeAttributes.has(attr.value.toLowerCase())||attr.value.toLowerCase().startsWith('on'))throw new AtlasError("Attribute mutation requires a literal supported attribute name.");
        }
        for(const [key,value] of Object.entries(node)){if(key==='start'||key==='end')continue;if(Array.isArray(value))value.forEach(child=>walk(child,node));else if(value&&typeof value==='object')walk(value,node)}
    };walk(ast);
}
const templates=Handlebars.create();
templates.registerHelper('value',(v:unknown)=>v===undefined||v===null||v===''?'—':String(v));
templates.registerHelper('eq',(a:unknown,b:unknown)=>a===b);
templates.registerHelper('number',(v:unknown)=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?'—':new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(Number(v)));
templates.registerHelper('percent',(v:unknown)=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?'—':new Intl.NumberFormat('en-GB',{style:'percent',maximumFractionDigits:1}).format(Number(v)));
templates.registerHelper('date',(v:unknown)=>{const d=new Date(String(v));return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',dateStyle:'medium'}).format(d)});
export function validatePresentation(html:string,css:string,manifest?:ViewManifest,script='') {
    if(typeof html!=='string'||typeof css!=='string'||typeof script!=='string')throw new AtlasError("View template, CSS and script must be strings.");
    if(html.length>200000||css.length>100000)throw new AtlasError("View template or CSS exceeds the size limit.");
    validateManifest(manifest);validateMarkup(html,manifest);
    if(forbiddenCss.test(css))throw new AtlasError("View CSS cannot import or load external resources.");
    try{
        const tree=templates.parse(html);
        const check=(node:any)=>{if(!node||typeof node!=='object')return;if(node.type==='PathExpression'&&node.parts?.includes('params')){
            if(!manifest?.capabilities?.includes('url-params'))throw new AtlasError("Template params require the url-params capability.");
            const key=node.parts[node.parts.indexOf('params')+1];if(key&&!Object.hasOwn(manifest.params??{},key))throw new AtlasError(`Undeclared View parameter '${key}'.`);
        }for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(check);else if(value&&typeof value==='object')check(value)}};check(tree);templates.precompile(html);
    }catch(error){if(error instanceof AtlasError)throw error;throw new AtlasError(`Invalid Handlebars template: ${(error as Error).message}`)}
    validateScript(script,manifest);
}
export function sanitizeRenderedHtml(html:string,manifest?:ViewManifest){return validateMarkup(html,manifest,true)}
export function renderTemplate(html:string,data:Record<string,unknown>,manifest?:ViewManifest){try{return sanitizeRenderedHtml(templates.compile(html,{noEscape:false})(data),manifest)}catch(error){if(error instanceof AtlasError)throw error;throw new AtlasError(`View template rendering failed: ${(error as Error).message}`)}}
export function validateSlug(slug: string) { if (!slugPattern.test(slug)) throw new AtlasError("View slug must contain lowercase letters, numbers, and single hyphens only."); }
export function validateViewQueries(queries: ViewQuery[], stores: Store[]) {
    if (!Array.isArray(queries) || queries.length>16) throw new AtlasError("View queries must be an array of at most 16 queries.");
    const names = new Set<string>();
    for (const query of queries) {
        const shape=z.object({name:z.string(),storeId:z.string().uuid(),limit:z.number().int().min(1).max(100).optional(),filters:z.array(z.object({field:z.string(),operator:z.enum(["eq","neq","gt","gte","lt","lte","in","contains"]),value:z.unknown()})).max(32).optional(),sort:z.array(z.object({field:z.string(),direction:z.enum(["asc","desc"]).optional()})).max(16).optional()}).strict().safeParse(query);
        if(!shape.success)throw new AtlasError(`Invalid View query: ${shape.error.message}`);
        if (["params", "constructor", "prototype", "__proto__"].includes(query.name) || !bindingPattern.test(query.name)) throw new AtlasError(`Invalid query binding name '${query.name}'.`);
        if (names.has(query.name)) throw new AtlasError(`Duplicate query binding name '${query.name}'.`);
        names.add(query.name);
        const store = stores.find(item => item.id === query.storeId && !item.archivedAt);
        if (!store) throw new AtlasError(`Store '${query.storeId}' was not found in the View's project or is archived.`, "NOT_FOUND");
        if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw new AtlasError("View query limits must be between 1 and 100.");
        const fields = new Map(store.schema.fields.map(field => [field.name, field]));
        for (const filter of query.filters ?? []) { if (!["eq","neq","gt","gte","lt","lte","in","contains"].includes(filter.operator)) throw new AtlasError("Unsupported query filter operator."); const field = fields.get(filter.field); if (!field) throw new AtlasError(`Unknown filter field '${filter.field}' for store '${store.name}'.`); validateOperator(field, filter.operator, filter.value); }
        for (const sort of query.sort ?? []) { if(sort.direction !== undefined && !["asc","desc"].includes(sort.direction)) throw new AtlasError("Unsupported query sort direction."); if (!fields.has(sort.field) && !["createdAt", "updatedAt"].includes(sort.field)) throw new AtlasError(`Unknown sort field '${sort.field}' for store '${store.name}'.`); }
    }
    return structuredClone(queries);
}
function validateOperator(field: FieldDefinition, operator: string, value: unknown) {
    if (["gt", "gte", "lt", "lte"].includes(operator) && !["number", "date", "datetime", "string"].includes(field.type)) throw new AtlasError(`Operator '${operator}' is not compatible with ${field.type} field '${field.name}'.`);
    if (operator === "contains" && !["string", "array"].includes(field.type)) throw new AtlasError(`Operator 'contains' is not compatible with ${field.type} field '${field.name}'.`);
    if (operator === "in" && !Array.isArray(value)) throw new AtlasError(`Filter 'in' for '${field.name}' requires an array value.`);
}
