const mode = process.argv[2];
const emit = x => process.stdout.write(JSON.stringify(x)+'\n');
process.stdin.once('data', () => {
 if(mode==='crash') process.exit(2);
 if(mode==='eof') {process.stdout.write('{"type":'); process.exit(0);}
 if(mode==='malformed') {console.log('private raw diagnostic'); return;}
 if(mode==='flood') {process.stderr.write('x'.repeat(2*1024*1024)); return;}
 emit({type:'ready',version:'1.5.0'});
 if(mode==='hang') {process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return;}
 if(mode==='early') process.exit(0);
 emit({type:'agent_start'});
 emit({type:'tool_execution_start',tool:'read'});
 emit({type:'tool_execution_end',tool:'read',isError:false});
 if(mode==='events') for(let i=0;i<400;i++) emit({type:'agent_end'});
 emit({type:'agent_end'});emit({type:'agent_settled'});emit({type:'result',ok:mode!=='model-error'});
 process.stdin.destroy();
});
