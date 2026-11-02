// This process hosts upstream Pi. No Atlas agent loop, discovery, bash, extensions or writes.
import { createAgentSession, createReadToolDefinition, createExtensionRuntime, ModelRuntime,
    SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { piReadOperations } from '../dist/capabilities/pi/permissions.js';

// Endpoint override is trusted test/host wiring, never accepted by worker protocol.
export async function createPiSession(cwd, modelId, baseUrl = 'http://127.0.0.1:11434/v1', limits = { contextWindow: 32768, maxTokens: 4096 }) {
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
        allowModelNetwork: false, refreshOnCreate: false });
    // Fixed local endpoint. No credentials or caller-selected URLs/providers.
    modelRuntime.registerProvider('atlas-ollama', {
        baseUrl, apiKey: 'local-only', api: 'openai-completions',
        models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: limits.contextWindow, maxTokens: limits.maxTokens }],
    });
    const resourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => 'Inspect the approved checkout using read. Read-only. Report evidence and limitations; never claim tests ran.',
        getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    };
    return createAgentSession({ cwd, agentDir: process.env.HOME,
        model: modelRuntime.getModel('atlas-ollama', modelId), modelRuntime, resourceLoader,
        tools: ['read'], customTools: [createReadToolDefinition(cwd, { operations: piReadOperations(cwd) })],
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
}
