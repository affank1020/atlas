/**
 * Verified distribution catalogue for standalone desktop Nodes.
 *
 * GitHub Releases is the one artifact store. The trusted publication workflow
 * creates unique release tags and a Sigstore build-provenance attestation;
 * Actions' expiring temporary artifacts are never offered as downloads.
 * This service is read-only and has no GitHub credentials or update authority.
 */
export type NodeRelease = {
    component: 'desktop-node';
    version: string;
    commit: string;
    platform: 'darwin' | 'linux';
    architecture: 'any';
    channel: 'stable';
    protocol: 2;
    minimumNodeJs: 20;
    publishedAt: string;
    notes: string;
    downloadUrl: string;
    checksumUrl: string;
    sha256: string;
    releaseUrl: string;
    signature: 'github-build-provenance';
};

export type NodeReleaseCatalogue = {
    state: 'ready' | 'unavailable';
    releases: NodeRelease[];
    checkedAt: string;
    source: 'github-releases';
    error?: string;
};

const SOURCE = 'https://api.github.com/repos/affank1020/atlas/releases?per_page=30';
const REPO_RELEASE_URL = 'https://github.com/affank1020/atlas/releases/download/';
const SHA256 = /^[a-f0-9]{64}$/;
const TAG = /^node-v(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)-([a-f0-9]{12})$/;
type GithubAsset = { name?: unknown; browser_download_url?: unknown; digest?: unknown; state?: unknown };
type GithubRelease = {
    tag_name?: unknown; published_at?: unknown; html_url?: unknown;
    body?: unknown; draft?: unknown; prerelease?: unknown; immutable?: unknown; assets?: unknown;
};

function parseRelease(value: GithubRelease): NodeRelease[] {
    if (value.draft !== false || value.prerelease !== false || value.immutable !== true) return [];
    if (typeof value.tag_name !== 'string') return [];
    const match = TAG.exec(value.tag_name);
    if (!match || !Array.isArray(value.assets)) return [];
    if (typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))) return [];
    const tag = value.tag_name;
    const name = 'atlas-node-v' + match[1] + '-' + match[2] + '.tar.gz';
    const assets = value.assets as GithubAsset[];
    const archive = assets.find(asset => asset.name === name && asset.state === 'uploaded');
    const checksum = assets.find(asset => asset.name === name + '.sha256' && asset.state === 'uploaded');
    if (!archive || !checksum) return [];
    const expectedArchiveUrl = REPO_RELEASE_URL + tag + '/' + name;
    const expectedChecksumUrl = expectedArchiveUrl + '.sha256';
    if (archive.browser_download_url !== expectedArchiveUrl || checksum.browser_download_url !== expectedChecksumUrl) return [];
    const digest = typeof archive.digest === 'string' && archive.digest.startsWith('sha256:') ? archive.digest.slice(7) : '';
    if (!SHA256.test(digest)) return [];
    if (value.html_url !== 'https://github.com/affank1020/atlas/releases/tag/' + tag) return [];
    const base = {
        component: 'desktop-node' as const, version: match[1]!, commit: match[2]!,
        architecture: 'any' as const, channel: 'stable' as const,
        protocol: 2 as const, minimumNodeJs: 20 as const,
        publishedAt: value.published_at,
        notes: typeof value.body === 'string' ? value.body.slice(0, 4000) : '',
        downloadUrl: expectedArchiveUrl, checksumUrl: expectedChecksumUrl,
        sha256: digest, releaseUrl: value.html_url,
        signature: 'github-build-provenance' as const,
    };
    return [{ ...base, platform: 'linux' }, { ...base, platform: 'darwin' }];
}

export function parseNodeReleases(body: unknown): NodeRelease[] {
    if (!Array.isArray(body)) throw new Error('Invalid GitHub Releases response.');
    return body.flatMap(value => value && typeof value === 'object' ? parseRelease(value as GithubRelease) : [])
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

let cached: { expires: number; result: NodeReleaseCatalogue } | undefined;
let pending: Promise<NodeReleaseCatalogue> | undefined;
export function resetNodeReleaseCacheForTests() { cached = undefined; pending = undefined; }

/** Fail visibly if GitHub is unavailable; never promote a debug APK or workflow artifact. */
export async function listNodeReleases(refresh = false, fetcher: typeof fetch = fetch): Promise<NodeReleaseCatalogue> {
    const now = Date.now();
    if (!refresh && cached && cached.expires > now) return cached.result;
    if (pending) return pending;
    pending = (async () => {
        const checkedAt = new Date().toISOString();
        let result: NodeReleaseCatalogue;
        try {
            const response = await fetcher(SOURCE, {
                headers: { accept: 'application/vnd.github+json', 'user-agent': 'atlas-node-release-catalogue', 'x-github-api-version': '2022-11-28' },
                signal: AbortSignal.timeout(7000),
            });
            if (!response.ok) throw new Error('GitHub Releases returned HTTP ' + response.status);
            const releases = parseNodeReleases(await response.json());
            result = { state: 'ready', releases, checkedAt, source: 'github-releases' };
        } catch {
            result = { state: 'unavailable', releases: [], checkedAt, source: 'github-releases',
                error: 'Release catalogue could not be verified. Retry later; no download was offered.' };
        }
        cached = { expires: Date.now() + (result.state === 'ready' ? 120000 : 15000), result };
        return result;
    })();
    try { return await pending; }
    finally { pending = undefined; }
}
