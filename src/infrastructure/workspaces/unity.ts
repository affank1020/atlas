import { loadUnityConfig } from "../../server/config.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AtlasError } from '../../shared/errors.js';
import type { WorkspaceFiles } from './files.js';

import type { Workspace, WorkspaceAdapter } from "../../workspaces/model.js";
export type { Workspace, WorkspaceAdapter } from "../../workspaces/model.js";
export type EditorCommand = { name: string; description?: string; inputSchema: unknown };
export interface UnityConnection {
    version(): Promise<string>;
    probe(root: string): Promise<unknown>;
    tools(root: string): Promise<EditorCommand[]>;
    call(root: string, command: string, parameters: Record<string, unknown>): Promise<unknown>;
}
const exec = promisify(execFile);
export class UnityCliConnection implements UnityConnection {
    constructor(readonly binary = loadUnityConfig().binary) {}
    async version() { return (await exec(this.binary, ['--version'], { timeout: 5000, maxBuffer: 4096 })).stdout.trim(); }
    async probe(root: string) {
        try {
            const { stdout } = await exec(this.binary, ['list', '--project-path', root, '--json', '--no-banner', '--no-pager', '--non-interactive'], { cwd: root, timeout: 15000, maxBuffer: 1024 * 1024 });
            const result = JSON.parse(stdout);
            if (!result.success) throw new AtlasError('Unity Pipeline is not reachable.', 'ADAPTER_UNAVAILABLE');
            return { connected: true };
        } catch { throw new AtlasError('Unity Editor/Pipeline is not reachable for this workspace. Open this project with Pipeline installed and enabled.', 'ADAPTER_UNAVAILABLE'); }
    }
    private async session<T>(root: string, action: (client: Client) => Promise<T>) {
        const transport = new StdioClientTransport({ command: this.binary, args: ['mcp', '--project-path', root, '--no-banner', '--no-pager', '--non-interactive'], cwd: root, stderr: 'ignore' });
        const client = new Client({ name: 'atlas-workspaces', version: '1.0.0' });
        const timer = setTimeout(() => { void transport.close(); }, 25000);
        try { await client.connect(transport, { timeout: 10000 }); return await action(client); }
        finally { clearTimeout(timer); await client.close().catch(() => undefined); }
    }
    tools(root: string) {
        return this.session(root, async client => {
            const tools: EditorCommand[] = []; let cursor: string | undefined;
            do {
                const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 }); tools.push(...page.tools); cursor = page.nextCursor;
                if (tools.length > 1000) throw new AtlasError('Unity catalog exceeds 1000 commands.');
            } while (cursor);
            return tools;
        });
    }
    call(root: string, name: string, parameters: Record<string, unknown>) {
        return this.session(root, client => client.callTool({ name, arguments: parameters }, undefined, { timeout: 20000 }));
    }
}
// Local operator approval is mandatory. Even an approved general evaluator is never exposed.
const dangerous = /(?:eval|shell|python|script|terminal|execute|process|run.*code|install.*package|package.*install)/i;
export class UnityAdapter implements WorkspaceAdapter {
    constructor(readonly files: WorkspaceFiles, readonly connection: UnityConnection = new UnityCliConnection(), readonly approved = loadUnityConfig().approvedCommands) {}
    private async packageVersion(workspace: Workspace) {
        try { return JSON.parse((await this.files.read(workspace.rootPath, 'Packages/manifest.json')).text).dependencies?.['com.unity.pipeline'] as string | undefined; }
        catch { return undefined; }
    }
    async status(workspace: Workspace) {
        let cliVersion: string;
        try { cliVersion = await this.connection.version(); } catch { return { available: false, state: 'cli_unavailable', message: 'Install Unity CLI or set ATLAS_UNITY_CLI to its absolute executable path.' }; }
        const pipeline = await this.packageVersion(workspace);
        if (!pipeline) return { available: false, cliVersion, state: 'pipeline_not_configured', message: 'com.unity.pipeline is not declared in Packages/manifest.json. Atlas never installs it automatically.' };
        try { await this.connection.probe(workspace.rootPath); return { available: true, cliVersion, pipeline, state: 'connected' }; }
        catch { return { available: false, cliVersion, pipeline, state: 'editor_unreachable', message: 'Open this project in Unity with Pipeline enabled. The Editor may be closed, importing, in Safe Mode, or inaccessible.' }; }
    }
    async capabilities(workspace: Workspace) {
        const status = await this.status(workspace);
        if (!status.available) return { ...status, commands: [] };
        try {
            const commands = await this.connection.tools(workspace.rootPath);
            return { ...status, commands: commands.map(command => ({ ...command, approved: this.approved.includes(command.name) && !dangerous.test(command.name) })) };
        } catch { return { ...status, available: false, state: 'discovery_failed', commands: [] }; }
    }
    async invoke(workspace: Workspace, command: string, parameters: Record<string, unknown>) {
        if (!this.approved.includes(command) || dangerous.test(command)) throw new AtlasError('Unity command is not approved by the local operator.', 'WORKSPACE_DENIED');
        const capabilities = await this.capabilities(workspace);
        if (!capabilities.available) throw new AtlasError('Unity Editor/Pipeline is unavailable.', 'ADAPTER_UNAVAILABLE');
        if (!capabilities.commands.some(x => x.name === command && x.approved)) throw new AtlasError('Command is not exposed by this Editor.', 'INVALID_COMMAND');
        // MCP passes structured arguments; the Editor validates its own discovered inputSchema.
        const result = await this.connection.call(workspace.rootPath, command, parameters);
        if (JSON.stringify(result).length > 1024 * 1024) throw new AtlasError('Unity response exceeds 1 MiB. Command may have completed.', 'OUTPUT_LIMIT');
        return result;
    }
}
