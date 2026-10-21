import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeSoftware, releaseUpdateState, type NodeRelease } from './NodeSoftware';
import { callTool } from './api';
vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const release: NodeRelease = {
    component: 'desktop-node', version: '2.0.0', commit: 'abc123abc123', platform: 'linux',
    architecture: 'any', channel: 'stable', protocol: 2, minimumNodeJs: 20,
    publishedAt: '2026-10-21T12:00:00Z', notes: 'Changes',
    downloadUrl: 'https://github.com/affank1020/atlas/releases/download/node-v2.0.0-abc123abc123/atlas-node-v2.0.0-abc123abc123.tar.gz',
    checksumUrl: 'https://github.com/affank1020/atlas/releases/download/node-v2.0.0-abc123abc123/atlas-node-v2.0.0-abc123abc123.tar.gz.sha256',
    releaseUrl: 'https://github.com/affank1020/atlas/releases/tag/node-v2.0.0-abc123abc123',
    sha256: 'a'.repeat(64), provenance: 'unverified',
};
it('keeps downloads absent until verified catalogue entries exist', async () => {
    vi.mocked(callTool).mockResolvedValue({ state: 'unavailable', releases: [], error: 'offline', checkedAt: '' });
    render(<NodeSoftware />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByRole('link', { name: /Download release archive/ })).not.toBeInTheDocument();
    expect(screen.getByText(/not production-signed/i)).toBeInTheDocument();
});
it('offers only real published assets and retains platform separation', async () => {
    vi.mocked(callTool).mockResolvedValue({ state: 'ready', releases: [release], checkedAt: '' });
    render(<NodeSoftware />);
    const link = await screen.findByRole('link', { name: /Download release archive/ });
    expect(link).toHaveAttribute('href', release.downloadUrl);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Build provenance is unverified by Atlas/)).toBeInTheDocument();
    expect(screen.queryByText(/attestation available for independent/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/no published immutable archive/i)).toHaveLength(1);
});
it('never guesses a newer build based only on a different commit', () => {
    expect(releaseUpdateState('2.0.0+abc123abc123', [release], 'linux')).toBe('current');
    expect(releaseUpdateState('2.0.0+ffffffffffff', [release], 'linux')).toBe('unknown');
    expect(releaseUpdateState('1.9.9', [release], 'linux')).toBe('available');
    expect(releaseUpdateState('2.1.0', [release], 'linux')).toBe('newer');
});
