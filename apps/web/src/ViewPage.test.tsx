import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {ViewPage,ViewFrame} from './ViewPage';
import {ViewContainer} from './ProjectOverview';
import {callTool} from './api';
vi.mock('./api',()=>({callTool:vi.fn(),API_BASE:'https://atlas.example'}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
const saved={id:'v',projectId:'p',name:'Example',queries:[],html:'<p>Saved</p>',css:'',manifest:{viewKitVersion:1 as const,capabilities:[]},createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
const rendered={runtimeId:"test-runtime",view:{id:'v',projectId:'p',name:'Example'},data:{},renderedHtml:saved.html,css:'',document:'<!doctype html><p>Saved</p>',params:{},manifest:saved.manifest,diagnostics:{queries:[]}};
describe('View editor',()=>{
 it('keeps executable content in an opaque-origin iframe and preserves it when resizing',()=>{
  const page=render(<ViewFrame rendered={rendered}/>);const frame=screen.getByTitle('Example');
  expect(frame).toHaveAttribute('sandbox','allow-scripts allow-popups allow-popups-to-escape-sandbox');expect(frame).not.toHaveAttribute('allow-same-origin');expect(frame).not.toHaveAttribute('allow-top-navigation');expect(frame).toHaveAttribute('srcdoc',rendered.document);
  page.rerender(<ViewFrame rendered={rendered} mobile/>);expect(screen.getByTitle('Example')).toBe(frame);
  page.rerender(<ViewFrame rendered={{...rendered,manifest:undefined}}/>);expect(screen.getByTitle('Example')).toHaveAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');
 });
 it('uses editor-only route, previews without saving, and sends optimistic update version',async()=>{
  vi.mocked(callTool).mockImplementation(async(name)=>{if(name==='list_stores'||name==='get_view_history')return [] as never;if(name==='get_view'||name==='update_view')return saved as never;return rendered as never});
  render(<ViewPage projectId="p" viewId="v"/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save View'})).toBeEnabled());
  expect(screen.queryByTitle('Example')).not.toBeInTheDocument();
  const open=screen.getByRole('link',{name:'Open in new tab ↗'});
  expect(open).toHaveAttribute('href','https://atlas.example/projects/p/views/v');
  expect(open).toHaveAttribute('target','_blank');
  fireEvent.click(screen.getByRole('button',{name:'Update preview'}));
  await waitFor(()=>expect(callTool).toHaveBeenCalledWith('preview_view',expect.anything()));
  fireEvent.click(screen.getByRole('tab',{name:'Queries / Data'}));fireEvent.change(screen.getByLabelText('Saved Store queries (JSON)'),{target:{value:'{broken'}});fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await screen.findByRole('alert');
  expect(vi.mocked(callTool).mock.calls.some(([name])=>name==='update_view')).toBe(false);
  fireEvent.change(screen.getByLabelText('Saved Store queries (JSON)'),{target:{value:'[]'}});fireEvent.click(screen.getByRole('tab',{name:'CSS'}));fireEvent.change(screen.getByLabelText('View CSS'),{target:{value:'p{color:red}'}});fireEvent.click(screen.getByRole('button',{name:'Save View'}));
  await waitFor(()=>expect(callTool).toHaveBeenCalledWith('update_view',expect.objectContaining({viewId:'v',expectedUpdatedAt:saved.updatedAt,css:'p{color:red}'})));
 });
});
it('shows compact View snapshots with separate edit and standalone links',async()=>{
  vi.mocked(callTool).mockImplementation(async(_name,args)=>{const id=(args as {viewId:string}).viewId;return {...rendered,view:{...rendered.view,id,name:id==='v'?'FYP Control Room':'Another View'}} as never});
  render(<><ViewContainer view={{...saved,name:'FYP Control Room',description:'Football simulation'}}/><ViewContainer view={{...saved,id:'v2',name:'Another View',slug:'another-view',description:'Another description'}}/></>);
  expect(await screen.findByTitle('FYP Control Room')).toBeInTheDocument();
  expect(await screen.findByTitle('Another View')).toBeInTheDocument();
  expect(screen.getAllByText('Preview only · Open to interact')).toHaveLength(2);
  expect(screen.getByRole('heading',{name:'FYP Control Room'})).toBeInTheDocument();
  expect(screen.getByText('Football simulation')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Open FYP Control Room in new tab'})).toHaveAttribute('href','https://atlas.example/projects/p/views/v');
  expect(screen.getByRole('link',{name:'Open Another View in new tab'})).toHaveAttribute('href','https://atlas.example/projects/p/views/another-view');
  expect(screen.getAllByRole('link',{name:/^Open in new tab/}).every(link=>link.getAttribute('target')==='_blank')).toBe(true);
  expect(screen.getByRole('link',{name:'Edit FYP Control Room'})).toHaveAttribute('href','#/projects/p/views/v');
  expect(screen.getByRole('link',{name:'Edit Another View'})).toHaveAttribute('href','#/projects/p/views/v2');
  expect(callTool).toHaveBeenCalledWith('render_view',{projectId:'p',viewId:'v',params:{}});
  expect(callTool).toHaveBeenCalledWith('render_view',{projectId:'p',viewId:'v2',params:{}});
});
