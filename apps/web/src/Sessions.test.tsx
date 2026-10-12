import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Sessions } from './Sessions';
import { callTool } from './api';

vi.mock('./api',()=>({callTool:vi.fn()}));
beforeEach(()=>vi.resetAllMocks());
test('Sessions shows coordinator, work queue, context and no fabricated online state', async()=>{
  vi.mocked(callTool).mockImplementation(async (name)=>{
    if(name==='sessions_list')return [{id:'one',title:'SWE Team',objective:'Review an API',status:'active',revision:2,updatedAt:'2026-10-12T10:00:00Z'}] as never;
    if(name==='sessions_get')return {id:'one',title:'SWE Team',objective:'Review an API',summary:'Use schema v2',status:'active',revision:2,updatedAt:'2026-10-12T10:00:00Z',
      participants:[{id:'c1',role:'coordinator',label:'Coordinator',joinedAt:'2026-10-12T09:00:00Z',lastSeenAt:'2026-10-12T10:00:00Z'}],
      assignments:[{id:'a1',title:'API design',brief:'Define endpoint contract',status:'queued',priority:10,assigneeId:null,result:null,updatedAt:'2026-10-12T10:00:00Z'}],
      events:[{id:'1',kind:'created',participantId:'c1',body:'Coordinator started session.',createdAt:'2026-10-12T10:00:00Z'}]} as never;
    return [] as never;
  });
  render(<Sessions/>);
  expect((await screen.findAllByText('SWE Team')).length).toBeGreaterThan(0);
  expect(await screen.findByText('Use schema v2')).toBeInTheDocument();
  expect(screen.getByText('API design')).toBeInTheDocument();
  expect(screen.getByText('Last check-in, not online status')).toBeInTheDocument();
  expect(screen.queryByText('Online')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  expect(vi.mocked(callTool)).toHaveBeenCalledWith('sessions_list',{includeClosed:false});
});
test('Sessions starts with honest conversational onboarding',async()=>{
  vi.mocked(callTool).mockResolvedValue([] as never);
  render(<Sessions/>);
  expect(await screen.findByText('Start from ChatGPT')).toBeInTheDocument();
  expect(screen.getByText(/No chat URLs or additional AI API billing/)).toBeInTheDocument();
});
