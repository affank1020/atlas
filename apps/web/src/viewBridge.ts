import type { ViewManifest } from './types';
export function viewParams(hash=location.hash):Record<string,string>{return Object.fromEntries(new URLSearchParams(hash.split('?').slice(1).join('?')))}
export function parameterMessage(event:Pick<MessageEvent,'source'|'origin'|'data'>,source:Window|null,manifest?:ViewManifest):{key:string;value:string|null}|undefined {
    if(!source||event.source!==source||event.origin!=='null'||!manifest?.capabilities?.includes('url-params'))return;
    const message=event.data;
    if(!message||message.type!=='atlas-view-param'||typeof message.key!=='string'||!Object.hasOwn(manifest.params??{},message.key))return;
    if(message.value!==null&&(typeof message.value!=='string'||message.value.length>500))return;
    return {key:message.key,value:message.value};
}
export function parameterHash(hash:string,key:string,value:string|null){const [route]=hash.split('?');const params=new URLSearchParams(hash.split('?').slice(1).join('?'));if(value===null)params.delete(key);else params.set(key,value);return route+(params.size?'?'+params.toString():'')}
