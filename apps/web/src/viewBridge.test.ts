import {describe,it,expect} from 'vitest';
import {parameterMessage,parameterHash,viewParams} from './viewBridge';
describe('View URL bridge',()=>{
 const manifest={capabilities:['url-params' as const],params:{q:''}};
 const source={} as Window;
 const event={source,origin:'null',data:{type:'atlas-view-param',key:'q',value:'LSEG & partners'}};
 it('accepts declared state only from the active opaque-origin iframe',()=>{
  expect(parameterMessage(event,source,manifest)?.key).toBe('q');
  expect(parameterMessage({...event,source:{} as Window},source,manifest)).toBeUndefined();
  expect(parameterMessage({...event,origin:'http://127.0.0.1'},source,manifest)).toBeUndefined();
  expect(parameterMessage(event,source,{})).toBeUndefined();
  expect(parameterMessage({...event,data:{...event.data,key:'location'}},source,manifest)).toBeUndefined();
  expect(parameterMessage({...event,data:{type:'update_record',key:'q',value:'x'}},source,manifest)).toBeUndefined();
  expect(parameterMessage({...event,data:{...event.data,value:{url:'x'}}},source,manifest)).toBeUndefined();
 });
 it('encodes and restores state without allowing a View to change the route',()=>{
  const hash=parameterHash('#/projects/p/views/v','q','x&other=1#evil');
  expect(hash.split('?')[0]).toBe('#/projects/p/views/v');expect(viewParams(hash)).toEqual({q:'x&other=1#evil'});
  expect(parameterHash(hash,'q',null)).toBe('#/projects/p/views/v');
 });
});
