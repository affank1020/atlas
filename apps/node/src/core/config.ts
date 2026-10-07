const list = (value: string) => value.split(',').map(x => x.trim()).filter(Boolean);
export function loadWorkspaceConfig(env: NodeJS.ProcessEnv = process.env) { return { roots: list(env.ATLAS_WORKSPACE_ROOTS ?? '') }; }
export function loadUnityConfig(env: NodeJS.ProcessEnv = process.env) { return { binary: env.ATLAS_UNITY_CLI || 'unity', approvedCommands: list(env.ATLAS_UNITY_ALLOWED_COMMANDS ?? '') }; }
