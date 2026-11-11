import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workspace } from '../packages/protocol/src/workspace.js';
import { readExperimentReviews, writeExperimentReview } from '../apps/node/src/capabilities/generalist-experiment-reviews.js';

test('review decisions require linked evidence and are replaced by experiment key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-experiment-review-'));
    const workspace = { rootPath: root } as Workspace;
    try {
        await mkdir(path.join(root, 'validation/generalist'), { recursive: true });
        assert.deepEqual(readExperimentReviews(workspace), []);
        const input = { phase: 'g05', scenario: 's1-dribble-foot-touch-g05-v1', variant: 'FootV1',
            verdict: 'adopt', note: 'Observed controlled left and right cuts.', visual_evidence: 'Owner review seed 515 episode 2', run_id: 'atlas-generalist-61a91798db31' };
        assert.throws(() => writeExperimentReview(workspace, { ...input, run_id: undefined }));
        assert.throws(() => writeExperimentReview(workspace, { ...input, visual_evidence: undefined }));
        assert.throws(() => writeExperimentReview(workspace, { ...input, scenario: '../escape' }));
        writeExperimentReview(workspace, input);
        writeExperimentReview(workspace, { ...input, verdict: 'revise', note: 'Defender still traps the ball.' });
        const saved = readExperimentReviews(workspace);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].verdict, 'revise');
        assert.equal(saved[0].run_id, input.run_id);
        assert.ok(saved[0].updated_at);
        await rm(path.join(root, 'validation/generalist/atlas-experiment-reviews.json'));
        await symlink(path.join(root, 'outside.json'), path.join(root, 'validation/generalist/atlas-experiment-reviews.json'));
        assert.throws(() => readExperimentReviews(workspace));
    } finally { await rm(root, { recursive: true, force: true }); }
});
