import path from 'node:path';
import { WorkspaceFiles } from '../workspace-files/files.js';
/** Pi's native read tool uses these operations, never its default host fs. */
export function piReadOperations(root: string, files = new WorkspaceFiles([root])) {
    const read = async (absolute: string) => {
        if (!path.isAbsolute(absolute)) throw new Error('Pi read requires an absolute path.');
        const relative = path.relative(root, absolute);
        return Buffer.from((await files.read(root, relative)).text, 'utf8');
    };
    return { readFile: read, access: async (absolute: string) => { await read(absolute); },
        detectImageMimeType: async () => null };
}
