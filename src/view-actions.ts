import {z} from 'zod';
import {AtlasError} from './shared/errors.js';
import type {Store,ViewAction,ViewManifest} from './types.js';
const actionName=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(x=>!['constructor','prototype','__proto__'].includes(x));
export const viewActionSchema=z.object({name:actionName,type:z.enum(['record.update','record.create']),storeId:z.string().uuid(),allowedFields:z.array(z.string()).min(1).max(64),fixedData:z.record(z.string(),z.unknown()).optional()}).strict();
export const actionInputSchema=z.object({recordId:z.string().uuid().optional(),data:z.record(z.string(),z.unknown()).optional()}).strict();
export const executeActionSchema=z.object({projectId:z.string().uuid(),viewId:z.string().uuid(),action:actionName,input:actionInputSchema.default({})}).strict();
export function validateViewActions(value:unknown,manifest:ViewManifest|undefined,stores:Store[]):ViewAction[]{
 const parsed=z.array(viewActionSchema).max(32).safeParse(value??[]);if(!parsed.success)throw new AtlasError(`Invalid View actions: ${parsed.error.message}`);
 const actions=parsed.data;
 if(actions.length&&!manifest?.capabilities?.includes('record-actions'))throw new AtlasError('Declared actions require the record-actions capability.');
 const names=new Set<string>();
 for(const action of actions){
  if(names.has(action.name))throw new AtlasError(`Duplicate View action '${action.name}'.`);names.add(action.name);
  const store=stores.find(s=>s.id===action.storeId&&!s.archivedAt);if(!store)throw new AtlasError(`Action Store '${action.storeId}' is not active in the View's project.`);
  if(new Set(action.allowedFields).size!==action.allowedFields.length)throw new AtlasError('Action allowedFields must be unique.');
  for(const field of action.allowedFields)if(!store.schema.fields.some(f=>f.name===field))throw new AtlasError(`Unknown action field '${field}'.`);
  for(const field of Object.keys(action.fixedData??{}))if(!action.allowedFields.includes(field))throw new AtlasError(`Fixed field '${field}' must be in allowedFields.`);
 }
 return structuredClone(actions);
}
export function actionData(action:ViewAction,input:unknown){
 const parsed=actionInputSchema.safeParse(input);if(!parsed.success)throw new AtlasError(`Invalid action input: ${parsed.error.message}`);
 if(action.type==='record.update'&&!parsed.data.recordId)throw new AtlasError('Update actions require recordId.');
 if(action.type==='record.create'&&parsed.data.recordId)throw new AtlasError('Create actions do not accept recordId.');
 for(const field of Object.keys(parsed.data.data??{})){
  if(!action.allowedFields.includes(field))throw new AtlasError(`Action '${action.name}' cannot write field '${field}'.`);
  if(Object.hasOwn(action.fixedData??{},field))throw new AtlasError(`Action field '${field}' is fixed and cannot be supplied dynamically.`);
 }
 return {...parsed.data,data:{...parsed.data.data,...action.fixedData}};
}
