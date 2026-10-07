/** Shared trusted host bridge. Used by Observatory and serialized into the standalone shell.
 * Keep this function self-contained: it must not close over server variables or imports. */
export function installViewHost(options:{
    frame:HTMLIFrameElement;runtimeId:string;params:Record<string,string>;parameterCapability:boolean;
    actionNames:string[];actionsEnabled:boolean;
    onParam:(key:string,value:string|null)=>void;
    action:(name:string,input:unknown)=>Promise<unknown>;
    refresh:(params:Record<string,string>,scroll?:{x:number;y:number})=>Promise<unknown>;
    onError?:(message:string)=>void;
}){
    let live=true;let busy=false;const seen=new Set<string>();
    const validParams=(value:unknown):value is Record<string,string>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([key,v])=>Object.hasOwn(options.params,key)&&typeof v==='string'&&v.length<=500);
    const receive=async(event:MessageEvent)=>{
        if(!live||event.source!==options.frame.contentWindow||event.origin!=='null')return;
        const message=event.data;if(!message||message.runtimeId!==options.runtimeId)return;
        if(message.type==='atlas-view-param'){
            if(options.parameterCapability&&Object.hasOwn(options.params,message.key)&&(message.value===null||(typeof message.value==='string'&&message.value.length<=500)))options.onParam(message.key,message.value);
            return;
        }
        if(message.type!=='atlas-view-request'||typeof message.requestId!=='string'||message.requestId.length>100)return;
        const reply=(ok:boolean,value:unknown)=>{if(live)options.frame.contentWindow?.postMessage({type:'atlas-view-response',runtimeId:options.runtimeId,requestId:message.requestId,ok,...(ok?{result:value}:{error:String(value)})},'*')};
        if(seen.has(message.requestId)){reply(false,'Duplicate runtime request.');return}seen.add(message.requestId);
        if(seen.size>2000){reply(false,'Refresh this View before continuing.');return}
        if(busy){reply(false,'Another View operation is still running.');return}
        busy=true;
        try{
            if(message.method==='action'){
                if(!options.actionsEnabled)throw new Error('Actions are disabled in this preview. Enable saved actions to write to Core.');
                if(typeof message.name!=='string'||!options.actionNames.includes(message.name))throw new Error('Undeclared View action.');
                if(JSON.stringify(message.input??{}).length>65536)throw new Error('Action input is too large.');
                reply(true,await options.action(message.name,message.input??{}));
            }else if(message.method==='refresh'){
                if(!validParams(message.params))throw new Error('Invalid View refresh parameters.');
                const scroll=message.scroll;
                if(scroll!==undefined&&(!scroll||typeof scroll!=='object'||!Number.isFinite(scroll.x)||!Number.isFinite(scroll.y)||scroll.x<0||scroll.y<0||scroll.x>10000000||scroll.y>10000000))throw new Error('Invalid View refresh scroll position.');
                if(scroll===undefined)await options.refresh(message.params);else await options.refresh(message.params,scroll);reply(true,{refreshed:true});
            }else throw new Error('Unsupported View runtime method.');
        }catch(error){const text=error instanceof Error?error.message:'View operation failed.';reply(false,text);options.onError?.(text)}finally{busy=false}
    };
    window.addEventListener('message',receive);
    return ()=>{live=false;window.removeEventListener('message',receive)};
}
