import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCuration, writeCuration, deriveAssessments } from '../apps/node/src/capabilities/generalist-policy-profiles.js';

test('curation stores friendly names and explicit featured status without touching model metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-policy-curation-'));
    try {
        await mkdir(path.join(root, 'validation/generalist'), { recursive: true });
        assert.deepEqual(readCuration(root), {});
        const saved = writeCuration(root, 'generalist-musiala-v1', { display_name: 'Musiala', featured: true });
        assert.equal(saved.display_name, 'Musiala');
        assert.equal(saved.featured, true);
        writeCuration(root, 'generalist-musiala-v1', { display_name: 'Musiala II' });
        assert.deepEqual(readCuration(root)['generalist-musiala-v1'], { display_name: 'Musiala II', featured: true });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('historical assessments deduplicate by ticket and merge aliases only when model SHA matches', () => {
    const policies = [
        { id: 'source', onnx_sha256: 'abc' }, { id: 'musiala', source_policy_id: 'source', onnx_sha256: 'abc' },
        { id: 'other', onnx_sha256: 'def' },
    ];
    const records = [
        { ticket: 'e1', policy_id: 'source', scenario: 's1-dribble-3m-v1', seed: 515,
            episodes: [{ success: true }, { success: false }] },
        { ticket: 'e1', policy_id: 'source', scenario: 's1-dribble-3m-v1', seed: 515,
            episodes: [{ success: true }, { success: false }] },
        { ticket: 'e2', policy_id: 'musiala', scenario: 's1-dribble-3m-v1', seed: 616,
            episodes: [{ success: true }] },
        { ticket: 'e3', policy_id: 'other', scenario: 's1-dribble-3m-v1', seed: 717,
            episodes: [{ success: true }] },
    ];
    const [original, named, other] = deriveAssessments(policies, records);
    for (const policy of [original, named]) {
        const score = policy.benchmarks.find(b => b.id === 'close_control')!;
        assert.equal(score.total, 3);
        assert.equal(score.successes, 2);
        assert.deepEqual(score.seeds.sort(), [515, 616]);
        assert.equal(score.ticketCount, 2);
        assert.equal(score.status, 'provisional');
    }
    assert.equal(named.canonical_policy_id, 'source');
    assert.equal(other.benchmarks[0].total, 1);
    assert.equal(named.benchmarks.find(b => b.id === 'moving_ball')?.status, 'not_assessed');
});

test('recovers historical seeds from actual episode evidence when receipt seed is absent', () => {
    const policies = [{ id: 'generalist-musiala-v1', onnx_sha256: 'model-hash' }];
    const records = [
        { ticket: 'saved-100', policy_id: 'generalist-musiala-v1',
            scenario: 's1-dribble-3m-v1', seed: null,
            episodes: [{ success: true, seed: 515 }, { success: false, seed: 515 }] },
        // In multi-arena reports the episodes can name more than one seed.
        { ticket: 'saved-multi', policy_id: 'generalist-musiala-v1',
            scenario: 's1-dribble-3m-v1', seed: null,
            episodes: [{ success: true, seed: 616 }, { success: true, seed: 717 }] },
        // Existing receipts still work when the episode format lacks a seed.
        { ticket: 'seeded-receipt', policy_id: 'generalist-musiala-v1',
            scenario: 's1-dribble-3m-v1', seed: 818, episodes: [{ success: true }] },
        { ticket: 'unknown-seed', policy_id: 'generalist-musiala-v1',
            scenario: 's1-dribble-3m-v1', seed: null, episodes: [{ success: true }] },
    ];
    const [assessment] = deriveAssessments(policies, records);
    const close = assessment.benchmarks.find(b => b.id === 'close_control')!;
    assert.equal(close.total, 6);
    assert.equal(close.successes, 5);
    assert.deepEqual(close.seeds, [515, 616, 717, 818]);
    assert.equal(close.ticketCount, 4);
});

test('does not invent seed provenance from invalid or conflicting receipt values', () => {
    const policies = [{ id: 'generalist-musiala-v1', onnx_sha256: 'model-hash' }];
    const [assessment] = deriveAssessments(policies, [
        { ticket: 'wrong-receipt', policy_id: 'generalist-musiala-v1', scenario: 's1-dribble-3m-v1',
            seed: 515, episodes: [{ success: true, seed: 616 }] },
        { ticket: 'no-provenance', policy_id: 'generalist-musiala-v1', scenario: 's1-dribble-3m-v1',
            seed: null, episodes: [{ success: true }] },
    ]);
    const close = assessment.benchmarks.find(b => b.id === 'close_control')!;
    assert.deepEqual(close.seeds, [616]);
    assert.equal(close.total, 2);
});
