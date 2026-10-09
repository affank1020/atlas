import { randomUUID } from "node:crypto";
import { CoreService } from "../core/service.js";
import { AtlasError } from "../shared/errors.js";
import type { AtlasData, RecordData, View, ViewAction, ViewManifest, ViewQuery, ViewRenderResult } from "../types.js";
import { actionData, executeActionSchema, validateViewActions } from "../view-actions.js";
import { viewDocument } from "../view-runtime.js";
import { renderTemplate, validatePresentation, validateManifest, validateParams, validateSlug, validateViewQueries } from "../views.js";
type Client = { client?: string };
const now = () => new Date().toISOString();
const active = <T extends { archivedAt?: string }>(items: T[], includeArchived = false) => items.filter(item => includeArchived || !item.archivedAt);
const cleanText = (value: string, label: string) => { const result = value.trim(); if (!result) throw new AtlasError(`${label} cannot be empty.`); return result; };
export class ViewService {
    constructor(readonly core: CoreService) {}
    get store() { return this.core.store; }
    async listViews(projectId: string, includeArchived = false) { const data = await this.store.snapshot(); this.core.requireProject(data, projectId, includeArchived); return active(data.views.filter(view => view.projectId === projectId), includeArchived); }
    async getView(projectId: string, viewId: string, includeArchived = false) { const data = await this.store.snapshot(); this.core.requireProject(data, projectId, includeArchived); return this.requireView(data, projectId, viewId, includeArchived); }
    async createView(input: { projectId:string; name:string; slug?:string; description?:string; queries:ViewQuery[]; html?:string; template?:string; css:string; manifest?:ViewManifest; script?:string; actions?:ViewAction[] } & Client) {
        return this.store.transaction(data=>{
            this.core.requireProject(data,input.projectId);const name=cleanText(input.name,"View name");this.core.unique(data.views.filter(x=>x.projectId===input.projectId),name,"view");
            const slug=input.slug?.trim();if(slug){validateSlug(slug);this.uniqueSlug(data.views,input.projectId,slug)}
            const html=this.viewTemplate(input);const manifest=validateManifest(input.manifest);const script=input.script??'';
            const queries=validateViewQueries(input.queries,data.stores.filter(x=>x.projectId===input.projectId));validatePresentation(html,input.css,manifest,script);
            const actions=this.checkedViewActions(input.actions,manifest,data,input.projectId);
            const stamp=now();const view:View={id:randomUUID(),projectId:input.projectId,name,...(slug&&{slug}),...(input.description!==undefined&&{description:input.description}),queries,html,css:input.css,...(actions.length&&{actions}),...(manifest&&{manifest}),...(script&&{script}),createdAt:stamp,updatedAt:stamp};
            data.views.push(view);this.core.audit(data,"view.created",input.client,input.projectId,undefined,undefined,undefined,view,view.id);return view;
        });
    }
    async updateView(input: { projectId:string;viewId:string;name?:string;slug?:string|null;description?:string|null;queries?:ViewQuery[];html?:string;template?:string;css?:string;manifest?:ViewManifest|null;script?:string;actions?:ViewAction[];expectedUpdatedAt?:string } & Client) {
        return this.store.transaction(data=>{
            this.core.requireProject(data,input.projectId);const view=this.requireView(data,input.projectId,input.viewId);const before=structuredClone(view);
            if(input.expectedUpdatedAt&&view.updatedAt!==input.expectedUpdatedAt)throw new AtlasError("This View changed since you opened it. Reload the saved version before saving.");
            if(input.name!==undefined){const name=cleanText(input.name,"View name");this.core.unique(data.views.filter(x=>x.projectId===input.projectId),name,"view",view.id);view.name=name}
            if(input.slug!==undefined){if(!input.slug?.trim())delete view.slug;else{const slug=input.slug.trim();validateSlug(slug);this.uniqueSlug(data.views,input.projectId,slug,view.id);view.slug=slug}}
            if(input.description!==undefined)input.description===null?delete view.description:view.description=input.description;
            if(input.queries!==undefined)view.queries=validateViewQueries(input.queries,data.stores.filter(x=>x.projectId===input.projectId));
            if(input.manifest!==undefined){const manifest=validateManifest(input.manifest);if(manifest)view.manifest=manifest;else delete view.manifest}
            if(input.script!==undefined)view.script=input.script;
            if(input.actions!==undefined)view.actions=input.actions;
            this.checkedViewActions(view.actions,view.manifest,data,input.projectId);
            view.html=this.viewTemplate(input,view.html);view.css=input.css??view.css;validatePresentation(view.html,view.css,view.manifest,view.script);
            view.updatedAt=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString();this.core.audit(data,"view.updated",input.client,input.projectId,undefined,undefined,before,view,view.id);return view;
        });
    }
    private viewTemplate(input:{html?:string;template?:string},fallback?:string){
        if(input.html!==undefined&&input.template!==undefined&&input.html!==input.template)throw new AtlasError("Provide template or html, or identical values for both.");
        const value=input.template??input.html??fallback;if(typeof value!=='string')throw new AtlasError("A View template (or legacy html) is required.");return value;
    }
    async archiveView(projectId:string,viewId:string,client?:string){return this.store.transaction(data=>{this.core.requireProject(data,projectId);const view=this.requireView(data,projectId,viewId);const before=structuredClone(view);view.archivedAt=now();view.updatedAt=view.archivedAt;this.core.audit(data,"view.archived",client,projectId,undefined,undefined,before,view,view.id);return view;});}
    async viewHistory(projectId:string,viewId:string){const data=await this.store.snapshot();this.core.requireProject(data,projectId,true);this.requireView(data,projectId,viewId,true);return data.auditEvents.filter(e=>e.viewId===viewId&&e.operation.startsWith("view.")).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));}
    async renderView(projectId:string,viewId:string,params:Record<string,string>={}):Promise<ViewRenderResult>{
        const data=await this.store.snapshot();this.core.requireProject(data,projectId);const view=this.requireView(data,projectId,viewId);return this.renderDefinition(view,data,params);
    }
    async previewView(input:{projectId:string;queries:ViewQuery[];html?:string;template?:string;css:string;manifest?:ViewManifest;script?:string;actions?:ViewAction[];params?:Record<string,string>}):Promise<ViewRenderResult>{
        const data=await this.store.snapshot();this.core.requireProject(data,input.projectId);
        return this.renderDefinition({id:'preview',projectId:input.projectId,name:'Unsaved preview',queries:input.queries,html:this.viewTemplate(input),css:input.css,manifest:validateManifest(input.manifest),script:input.script,actions:input.actions,createdAt:now(),updatedAt:now()},data,input.params??{});
    }
    private async renderDefinition(view:View,data:AtlasData,params:Record<string,string>):Promise<ViewRenderResult>{
        const manifest=validateManifest(view.manifest);const actions=this.checkedViewActions(view.actions,manifest,data,view.projectId);const runtimeId=randomUUID();const resolvedParams=validateParams(manifest,params);validatePresentation(view.html,view.css,manifest,view.script);
        validateViewQueries(view.queries,data.stores.filter(x=>x.projectId===view.projectId));const bindings:Record<string,RecordData[]>={};const diagnostics=[];
        for(const query of view.queries){const store=this.core.requireStore(data,view.projectId,query.storeId);const page=await this.store.queryRecords(store,{filters:query.filters,sort:query.sort,limit:query.limit??100});bindings[query.name]=page.items.map(record=>({...structuredClone(record.data),_atlas:{id:record.id,storeId:record.storeId}}));diagnostics.push({name:query.name,storeId:query.storeId,returned:page.items.length})}
        const renderedHtml=renderTemplate(view.html,{...bindings,params:resolvedParams},manifest);
        return {runtimeId,actions,...(view.slug&&{standalonePath:`/projects/${view.projectId}/views/${view.slug}`}),view:{id:view.id,projectId:view.projectId,name:view.name,...(view.slug&&{slug:view.slug})},data:bindings,renderedHtml,css:view.css,manifest,script:view.script,params:resolvedParams,document:viewDocument({runtimeId,actions,html:renderedHtml,css:view.css,script:view.script,manifest,data:bindings,params:resolvedParams}),diagnostics:{queries:diagnostics}};
    }

    private checkedViewActions(value:unknown,manifest:ViewManifest|undefined,data:AtlasData,projectId:string){
        const actions=validateViewActions(value,manifest,data.stores.filter(s=>s.projectId===projectId));
        for(const action of actions){const store=this.core.requireStore(data,projectId,action.storeId);for(const [field,value] of Object.entries(action.fixedData??{}))this.core.assertType(store.schema.fields.find(f=>f.name===field)!,value)}
        return actions;
    }
    async executeViewAction(raw:unknown){
        const parsed=executeActionSchema.safeParse(raw);if(!parsed.success)throw new AtlasError(`Invalid View action request: ${parsed.error.message}`);
        const input=parsed.data;
        return this.store.transaction(state=>{
            this.core.requireProject(state,input.projectId);const view=this.requireView(state,input.projectId,input.viewId);
            const actions=this.checkedViewActions(view.actions,view.manifest,state,input.projectId);
            const action=actions.find(a=>a.name===input.action);if(!action)throw new AtlasError(`Undeclared View action '${input.action}'.`);
            const payload=actionData(action,input.input);const client=`view:${view.id}:action:${action.name}`;
            const common={projectId:view.projectId,storeId:action.storeId,data:payload.data,client};
            const record=action.type==='record.create'?this.core.createRecordInState(state,common,view.id):this.core.updateRecordInState(state,{...common,recordId:payload.recordId!},view.id);
            return {viewId:view.id,action:action.name,record};
        });
    }
    async getViewBySlug(projectId:string,slug:string){
        const data=await this.store.snapshot();this.core.requireProject(data,projectId);
        const view=data.views.find(v=>v.projectId===projectId&&!v.archivedAt&&(v.slug===slug||v.id===slug));
        if(!view)throw new AtlasError('View not found or archived.','NOT_FOUND');return view;
    }

    private requireView(data:AtlasData,projectId:string,id:string,archived=false){const item=data.views.find(x=>x.id===id&&x.projectId===projectId&&(archived||!x.archivedAt));if(!item)throw new AtlasError(`View '${id}' was not found in project '${projectId}'${archived?"":" or is archived"}.`,"NOT_FOUND");return item;}
    private uniqueSlug(items:View[],projectId:string,slug:string,except?:string){if(items.some(x=>x.projectId===projectId&&!x.archivedAt&&x.id!==except&&x.slug?.toLowerCase()===slug.toLowerCase()))throw new AtlasError(`An active view with slug '${slug}' already exists.`);}
}
