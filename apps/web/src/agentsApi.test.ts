import {afterEach,expect,it,vi} from 'vitest';
import {agentRequest,agentHref} from './agentsApi';
vi.mock('./api',()=>({IS_MOCK_MODE:false}));
afterEach(()=>vi.unstubAllGlobals());
it('uses only the same-origin private endpoint and never sends a browser owner or ingress credential',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({runs:[],next:null}),{status:200}));vi.stubGlobal('fetch',fetcher);
    await agentRequest('list',{limit:5});
    expect(fetcher).toHaveBeenCalledWith('/api/agents/list',expect.objectContaining({method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{"limit":5}'}));
});
it('surfaces auth/configuration failures and propagates cancellation',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:401})));
    await expect(agentRequest('get',{runId:'one'})).rejects.toThrow('authenticated owner ingress');
    const controller=new AbortController();controller.abort();
    vi.stubGlobal('fetch',vi.fn().mockImplementation((_url,init)=>Promise.reject(init.signal.reason)));
    await expect(agentRequest('list',{},controller.signal)).rejects.toThrow();
});
it('constructs safe shareable application scope links',()=>{
    expect(agentHref('one',{nodeId:'a&b'})).toBe('#/applications/agents?nodeId=a%26b&run=one');
});
