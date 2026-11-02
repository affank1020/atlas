import {cleanup,fireEvent,render,screen,waitFor,within,act} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Agents,AgentTree} from './Agents';
import {AgentPreview} from './AgentPreview';
import {agentRequest,duration,type AgentRunView} from './agentsApi';
vi.mock('./agentsApi',async original=>({...await original<typeof import('./agentsApi')>(),agentRequest:vi.fn()}));
const run:AgentRunView={runId:'run-one',checkoutId:'checkout-one',nodeId:'node-one',projectId:'project-one',logicalWorkspaceId:null,
    state:'running',permission:'read-only',requestedProfileId:'local',requestedProfile:{id:'local',provider:'ollama',model:'coder',contextWindow:32768,maxTokens:4096},actualProfile:null,
    head:'abc123',branch:'atlas/read',createdAt:'2026-11-02T12:00:00Z',startedAt:'2026-11-02T12:00:01Z',observedAt:'2026-11-02T12:00:02Z',finishedAt:null,cancelRequestedAt:null,
    lastCursor:2,eventGap:false,result:null,reason:null,nodeName:'Worker Mac',nodeOnline:true,checkoutName:'Atlas inspection',approvedRoot:'/approved/checkout',source:'owner-oauth',canCancel:true,
    hierarchy:{agentId:'run-one',parentAgentId:null,role:'root',state:'running',actualProfile:null,children:[]},evidence:{source:'authenticated_node_process_receipts',verifiedTests:[],verifiedCommits:[],taskSuccessVerified:false}};
const event=(cursor:number,type='agent_start',data={})=>({cursor,type,data,at:'2026-11-02T12:00:01Z'});
function respond(current=run) {vi.mocked(agentRequest).mockImplementation(async action=>(action==='list'?{runs:[current],next:null}:action==='get'?current:action==='control'?{...current,cancelRequestedAt:'2026-11-02T12:00:04Z',state:'cancelling'}:{runId:run.runId,events:[event(1),event(2,'tool_execution_end',{tool:'read',isError:true})],oldestCursor:1,lastCursor:2,truncated:false}) as never);}
beforeEach(()=>{location.hash='#/applications/agents';vi.resetAllMocks();});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('lists truthful state and model, with Workspace, Node and run deep links',async()=>{
    respond();render(<Agents/>);
    expect(await screen.findByRole('link',{name:'run-one'})).toHaveAttribute('href','#/applications/agents?run=run-one');
    expect(screen.getByRole('link',{name:'Atlas inspection'})).toHaveAttribute('href','#/workspaces?workspace=checkout-one');
    expect(screen.getByRole('link',{name:'Worker Mac'})).toHaveAttribute('href','#/nodes?node=node-one');
    expect(screen.getByText('Not observed')).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'unknown'}});
    await waitFor(()=>expect(location.hash).toContain('state=unknown'));
});
it('handles loading, empty and retryable error states without invented records',async()=>{
    vi.mocked(agentRequest).mockReturnValue(new Promise(()=>{}));const v=render(<Agents/>);
    expect(screen.getByRole('status',{name:'Loading agent runs'})).toBeInTheDocument();v.unmount();
    vi.mocked(agentRequest).mockRejectedValue(new Error('Owner access unavailable'));render(<Agents/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Owner access unavailable');
    vi.mocked(agentRequest).mockResolvedValue({runs:[],next:null});fireEvent.click(screen.getByRole('button',{name:'Retry'}));
    expect(await screen.findByText('No agent runs match this view.')).toBeInTheDocument();
});
it('honours scoped deep links, cursor paging and resets to newest',async()=>{
    location.hash='#/applications/agents?nodeId=node-one&checkoutId=checkout-one&state=failed';
    vi.mocked(agentRequest).mockResolvedValue({runs:[run],next:{createdAt:run.createdAt,runId:run.runId}});render(<Agents/>);
    await screen.findByText('Atlas inspection',{selector:'a'});
    expect(agentRequest).toHaveBeenCalledWith('list',{limit:50,state:'failed',nodeId:'node-one',checkoutId:'checkout-one'},expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button',{name:'Older runs'}));
    await waitFor(()=>expect(agentRequest).toHaveBeenLastCalledWith('list',expect.objectContaining({before:{createdAt:run.createdAt,runId:run.runId}}),expect.any(AbortSignal)));
    fireEvent.click(await screen.findByRole('button',{name:'Newest runs'}));
    await waitFor(()=>expect(agentRequest).toHaveBeenLastCalledWith('list',expect.not.objectContaining({before:expect.anything()}),expect.any(AbortSignal)));
});
it('detail shows evidence limits, errors, scope, hierarchy and authorised cancellation',async()=>{
    location.hash='#/applications/agents?run=run-one';respond();vi.spyOn(window,'confirm').mockReturnValue(true);render(<Agents/>);
    expect(await screen.findByText('Read tool returned an error')).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();expect(screen.getByText('/approved/checkout')).toBeInTheDocument();
    expect(screen.getByText(/No child agents recorded/)).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'Open associated Project'})).toHaveAttribute('href','#/projects/project-one');
    fireEvent.click(screen.getByRole('button',{name:'Cancel run'}));
    await waitFor(()=>expect(agentRequest).toHaveBeenCalledWith('control',{runId:'run-one',action:'cancel'}));
});
it('terminal runs hide cancellation and show real process receipts without claiming task success',async()=>{
    location.hash='#/applications/agents?run=run-one';respond({...run,state:'completed',canCancel:false,finishedAt:'2026-11-02T12:00:04Z',result:{runId:run.runId,workspaceId:run.checkoutId,nodeId:run.nodeId,state:'completed',startedAt:run.startedAt!,finishedAt:'2026-11-02T12:00:04Z',pid:123,exitCode:0,signal:null,runtimeVersion:'1.5.0',permission:'read-only',head:'a'.repeat(40),branch:'atlas/read',lastCursor:2,reason:'pi_finished'}});render(<Agents/>);
    expect(await screen.findByText('0 / None')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Cancel run'})).not.toBeInTheDocument();
    expect(screen.getByText(/No tests or commits have been independently verified/)).toBeInTheDocument();
});
it('unknown status and failed refresh keep uncertainty explicit',async()=>{
    location.hash='#/applications/agents?run=run-one';respond({...run,state:'unknown',nodeOnline:false});render(<Agents/>);
    expect(await screen.findByText(/Execution is uncertain/)).toBeInTheDocument();
    vi.mocked(agentRequest).mockRejectedValue(new Error('Disconnected'));fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected');
    expect(screen.getByText(/last retrieved snapshot/)).toBeInTheDocument();
});
it('polls from committed cursor, orders/deduplicates events and exposes retention gaps',async()=>{
    vi.useFakeTimers();location.hash='#/applications/agents?run=run-one';
    let pages=0;vi.mocked(agentRequest).mockImplementation(async action=>(action==='get'?run:{runId:run.runId,events:++pages===1?[event(1)]:[event(2,'worker_error'),event(2,'worker_error')],oldestCursor:1,lastCursor:2,truncated:pages>1}) as never);
    render(<Agents/>);await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    await act(async()=>{await vi.advanceTimersByTimeAsync(2100);});
    expect(agentRequest).toHaveBeenCalledWith('events',{runId:'run-one',after:1,limit:100},expect.any(AbortSignal));
    expect(screen.getAllByText('Pi worker error (details redacted)')).toHaveLength(1);
    expect(screen.getByText(/History is bounded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(agentRequest).toHaveBeenCalledWith('events',{runId:'run-one',after:2,limit:100},expect.any(AbortSignal));
});
it('prevents a late response from showing a different run after navigation',async()=>{
    location.hash='#/applications/agents?run=run-one';let resolve!:(value:unknown)=>void;
    vi.mocked(agentRequest).mockImplementation((_action,input)=> (input as {runId:string}).runId==='run-one'?new Promise(r=>{resolve=r;}):new Promise(()=>{}));render(<Agents/>);
    await act(async()=>{location.hash='#/applications/agents?run=run-two';dispatchEvent(new HashChangeEvent('hashchange'));});
    await act(async()=>{resolve(run);});
    expect(screen.queryByText('/approved/checkout')).not.toBeInTheDocument(); // No detail before its own events request resolves.
});
it('hierarchy renders only supplied relationships and actual role/model',()=>{
    render(<AgentTree node={{...run.hierarchy,children:[{agentId:'child',parentAgentId:run.runId,role:'scout',state:'failed',actualProfile:run.requestedProfile,children:[]}]}}/>);
    expect(screen.getByText('scout Pi agent')).toBeInTheDocument();expect(screen.getByText(/ollama \/ coder/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
});
it('Workspace and Node previews query the exact scope and link to the central application',async()=>{
    respond();const v=render(<AgentPreview checkoutId="checkout-one"/>);
    expect(await screen.findByRole('link',{name:'View agents →'})).toHaveAttribute('href','#/applications/agents?checkoutId=checkout-one');
    expect(agentRequest).toHaveBeenCalledWith('list',{checkoutId:'checkout-one',nodeId:undefined,limit:5},expect.any(AbortSignal));
    v.unmount();render(<AgentPreview nodeId="node-one"/>);
    expect(await screen.findByRole('link',{name:'View agents →'})).toHaveAttribute('href','#/applications/agents?nodeId=node-one');
});
it('duration distinguishes missing starts and terminal elapsed time',()=>{
    expect(duration(null,null)).toBe('Not observed');expect(duration(run.startedAt,'2026-11-02T12:01:03Z')).toBe('1m 2s');
});
