
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,afterEach,expect,test,vi } from 'vitest';
import { KnowledgeStudy } from './KnowledgeStudy';
import { callTool } from './api';
vi.mock('./api',()=>({callTool:vi.fn()}));
const c={id:'one',cardKey:'comp33511-core-notes:ch01:card:self-caution',question:'Why should you be cautious?',
  expectedAnswer:'Check evidence, assumptions and methods.',cardType:'assessment',origin:'lecturer',sourceKey:'comp33511-core-notes',
  sourceLink:'https://leanpub.com/read/UX/wrong',sectionKey:'comp33511-core-notes:ch01:1.3'};
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(callTool).mockImplementation(async (name,input)=>{
    if(name==='knowledge_bank_overview')return {groups:[{id:'ux',key:'ux',name:'UX'}]} as never;
    if(name==='knowledge_bank_browse')return {items:[{id:'source',sourceKey:'comp33511-core-notes',title:'UX from 30,000ft'}],total:1} as never;
    if(name==='knowledge_bank_study_deck')return {
      items:((input as {cardType:string}).cardType==='assessment'?[c]:[{...c,cardType:'recall',origin:'generated'}]),
      total:1,mode:'due'
    } as never;
    if(name==='knowledge_bank_rate_card')return {reviews:1,nextDueAt:'2026-10-20T00:00:00Z'} as never;
    throw new Error('Unexpected tool '+name);
  });
});
afterEach(cleanup);
test('flashcard workflow reveals a source-backed answer, rates it and records progress',async()=>{
  render(<KnowledgeStudy/>);
  expect(await screen.findByText('Why should you be cautious?')).toBeInTheDocument();
  expect(screen.queryByText('Check evidence, assumptions and methods.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Reveal answer guidance'}));
  expect(screen.getByText('Check evidence, assumptions and methods.')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:/Read original chapter/})).toHaveAttribute('href','https://leanpub.com/read/UX/wrong');
  fireEvent.click(screen.getByRole('button',{name:/Good/}));
  await waitFor(()=>expect(vi.mocked(callTool)).toHaveBeenCalledWith('knowledge_bank_rate_card',{cardKey:c.cardKey,rating:'good'}));
  expect(await screen.findByText(/Practice round complete/)).toBeInTheDocument();
});
test('mini assessment shows original lecturer question and accepts a written practice answer',async()=>{
  render(<KnowledgeStudy/>);
  await screen.findByText('Why should you be cautious?');
  fireEvent.click(screen.getByRole('button',{name:'Mini assessment'}));
  await waitFor(()=>expect(vi.mocked(callTool)).toHaveBeenCalledWith('knowledge_bank_study_deck',
    expect.objectContaining({cardType:'assessment'}),expect.anything()));
  fireEvent.change(screen.getByRole('textbox',{name:'Your practice answer'}),{target:{value:'Check evidence and context.'}});
  expect(screen.getByRole('textbox',{name:'Your practice answer'})).toHaveValue('Check evidence and context.');
  fireEvent.click(screen.getByRole('button',{name:'Reveal answer guidance'}));
  expect(screen.getByText('Check evidence, assumptions and methods.')).toBeInTheDocument();
});
