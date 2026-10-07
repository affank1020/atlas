import {afterEach,it,expect,vi} from 'vitest';
import {installViewHost} from '@atlas/view-runtime/view-host';
const disposers:(()=>void)[]=[];
afterEach(()=>{disposers.splice(0).forEach(f=>f());document.body.textContent=''});
function fixture(enabled=true){const frame=document.createElement('iframe');document.body.append(frame);const action=vi.fn().mockResolvedValue({ok:true});const refresh=vi.fn().mockResolvedValue({});const onParam=vi.fn();const onError=vi.fn();disposers.push(installViewHost({frame,runtimeId:'current',params:{module:''},parameterCapability:true,actionNames:['completeTask'],actionsEnabled:enabled,action,refresh,onParam,onError}));const send=(message:object,overrides:object={})=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{type:'atlas-view-request',runtimeId:'current',requestId:crypto.randomUUID(),...message},...overrides}));return {frame,action,refresh,onParam,onError,send}}
it('only forwards declared calls from the current sandbox instance and never arbitrary methods',async()=>{
 const f=fixture();f.send({method:'action',name:'completeTask',input:{recordId:'record'}});await vi.waitFor(()=>expect(f.action).toHaveBeenCalledWith('completeTask',{recordId:'record'}));
 f.action.mockClear();f.send({method:'action',name:'completeTask'},{source:window});f.send({method:'action',name:'completeTask'},{origin:'http://localhost'});f.send({runtimeId:'stale',method:'action',name:'completeTask'});expect(f.action).not.toHaveBeenCalled();
 f.send({method:'action',name:'create_project'});await vi.waitFor(()=>expect(f.onError).toHaveBeenCalledWith('Undeclared View action.'));expect(f.action).not.toHaveBeenCalled();
 f.send({method:'fetch',url:'/api/tools/update_record'});await vi.waitFor(()=>expect(f.onError).toHaveBeenCalledWith('Unsupported View runtime method.'));
});
it('preview actions are opt-in and invalid params cannot change host navigation',async()=>{
 const f=fixture(false);f.send({method:'action',name:'completeTask'});await vi.waitFor(()=>expect(f.onError).toHaveBeenCalled());expect(f.action).not.toHaveBeenCalled();
 f.send({type:'atlas-view-param',key:'module',value:'MATH37011'});expect(f.onParam).toHaveBeenCalledWith('module','MATH37011');f.onParam.mockClear();f.send({type:'atlas-view-param',key:'url',value:'https://example.com'});expect(f.onParam).not.toHaveBeenCalled();
 f.send({method:'refresh',params:{url:'bad'}});await vi.waitFor(()=>expect(f.onError).toHaveBeenCalledWith('Invalid View refresh parameters.'));expect(f.refresh).not.toHaveBeenCalled();
 f.send({method:'refresh',params:{module:'MATH37011'}});await vi.waitFor(()=>expect(f.refresh).toHaveBeenCalledWith({module:'MATH37011'}));
});
it('serializes requests and refuses duplicate request IDs',async()=>{
 const f=fixture();let finish:(value:unknown)=>void=()=>{};f.action.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
 f.send({requestId:'one',method:'action',name:'completeTask'});f.send({requestId:'two',method:'action',name:'completeTask'});expect(f.action).toHaveBeenCalledTimes(1);finish({});await new Promise(resolve=>setTimeout(resolve,0));f.send({requestId:'one',method:'action',name:'completeTask'});expect(f.action).toHaveBeenCalledTimes(1);
});
