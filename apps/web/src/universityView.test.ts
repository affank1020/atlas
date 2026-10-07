import reference from '../fixtures/views/university-v3.json';
import baseline from '../fixtures/views/university-v2-reference.json';
import {it,expect,vi,afterEach} from 'vitest';
afterEach(()=>{vi.useRealTimers();document.body.textContent=''});
it('retains original queries and ranking code, and deterministically promotes the next task after completion',async()=>{
 expect(reference.queries.slice(0,baseline.queries.length)).toEqual(baseline.queries);
 expect(reference.script.split('\n\natlas.onReady')[0].replace('\n    row.dataset.recordId=entry.task._atlas.id;','')).toBe(baseline.script);
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
 let tasks=[{title:'First in course order',moduleCode:'MATH37011',week:1,weekStart:'2026-09-28',order:1,required:true,status:'not_started',_atlas:{id:'one',storeId:'tasks'}},{title:'Second in course order',moduleCode:'MATH37011',week:1,weekStart:'2026-09-28',order:2,required:true,status:'not_started',_atlas:{id:'two',storeId:'tasks'}}];
 const action=vi.fn(async(name:string,input:{recordId:string})=>{expect(name).toBe('completeTask');tasks=tasks.filter(t=>t._atlas.id!==input.recordId);return {}});
 const run=(script:string)=>{document.body.innerHTML='<div id="university-overview"><div id="focus-stat"><strong></strong></div><div id="focus-list"></div></div><div id="module-detail" hidden></div>';const atlas={data:{pendingTasks:tasks},params:{module:''},onReady:(callback:()=>void)=>callback(),action,refresh:async()=>run(reference.script),toast:vi.fn()};new Function('atlas','document','Date',script)(atlas,document,Date)};
 run(baseline.script);const expected=document.querySelector('.focus-main strong')?.textContent;
 run(reference.script);expect(document.querySelector('.focus-main strong')?.textContent).toBe(expected);expect(expected).toBe('First in course order');
 const complete=document.querySelector('atlas-button[data-task-action="completeTask"]') as HTMLElement;complete.click();await Promise.resolve();await Promise.resolve();
 expect(action).toHaveBeenCalledWith('completeTask',{recordId:'one'});expect(document.querySelector('.focus-main strong')?.textContent).toBe('Second in course order');
 run(reference.script);expect(document.querySelector('.focus-main strong')?.textContent).toBe('Second in course order');
});
