import type { TransportServices } from '../../server/dispatch.js';
import { AtlasError } from '../../shared/errors.js';

/** A separate coding service credential does not imply unrestricted Atlas MCP writes. */
export const RELAY_CODING_MUTATIONS: ReadonlySet<string> = new Set([
  'workspace_git_create_worktree',
  'workspace_create_file','workspace_patch_file','workspace_delete_file',
  'workspace_git_stage','workspace_git_commit','workspace_git_push_branch',
  'workspace_git_open_pull_request','workspace_run_dev_task',
]);
const FEATURE=/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type WorkspaceFact={id:string;nodeId:string;logicalWorkspaceId:string;status:string};
type GitFact={available?:boolean;branch?:string;originRepository?:string|null};
const deny=()=>{throw new AtlasError('Relay coding checkout is not authorised.','WORKSPACE_DENIED');};
const fact=(raw:unknown):WorkspaceFact=>{
  const w=raw as Partial<WorkspaceFact>|null;
  if(!w||!UUID.test(w.id??'')||!UUID.test(w.nodeId??'')||
    !UUID.test(w.logicalWorkspaceId??'')||w.status!=='active')return deny();
  return w as WorkspaceFact;
};
const gitFact=(raw:unknown):GitFact=>{
  const git=raw as GitFact|null;
  if(!git||git.available!==true||typeof git.originRepository!=='string'||
     !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(git.originRepository))return deny();
  return git;
};

/** Called independently for every mutation (not just tool discovery).
 * A base checkout may only create a new isolated worktree; other mutations
 * must target an atlas/* checkout in the same logical repository and Node. */
export async function admitRelayCodingMutation(
  services:Pick<TransportServices,'dispatch'>,
  tool:string,input:Record<string,unknown>,baseIds:ReadonlySet<string>,
):Promise<void>{
  if(!RELAY_CODING_MUTATIONS.has(tool))return;
  const id=input.checkoutId??input.workspaceId;
  if(typeof id!=='string'||!UUID.test(id))return deny();
  const target=fact(await services.dispatch('get_workspace',{checkoutId:id},'atlas-mcp'));
  if(target.id.toLowerCase()!==id.toLowerCase())return deny();
  if(tool==='workspace_git_create_worktree'){
    if(!baseIds.has(id.toLowerCase())||typeof input.branch!=='string'||!FEATURE.test(input.branch))return deny();
    gitFact(await services.dispatch('workspace_git_status',{checkoutId:id},'atlas-mcp'));
    return;
  }
  const targetGit=gitFact(await services.dispatch('workspace_git_status',{checkoutId:id},'atlas-mcp'));
  if(!targetGit.branch||!FEATURE.test(targetGit.branch))return deny();
  // Scope to a configured base's logical repo and Node. Do not trust a
  // client-supplied repo name, checkout path or stale Node status.
  let authorised=false;
  for(const baseId of baseIds){
    const base=fact(await services.dispatch('get_workspace',{checkoutId:baseId},'atlas-mcp'));
    if(base.nodeId!==target.nodeId||base.logicalWorkspaceId!==target.logicalWorkspaceId)continue;
    const sourceGit=gitFact(await services.dispatch('workspace_git_status',{checkoutId:baseId},'atlas-mcp'));
    if(sourceGit.originRepository!.toLowerCase()===targetGit.originRepository!.toLowerCase()){
      authorised=true;break;
    }
  }
  if(!authorised)return deny();
  if((tool==='workspace_git_push_branch'||tool==='workspace_git_open_pull_request')&&
    (input.repository!==targetGit.originRepository||input.branch!==targetGit.branch))
    return deny();
  if(tool==='workspace_git_commit'&&input.branch!==targetGit.branch)return deny();
}
