import { expect, test } from 'vitest';
import { viewActionsCss, viewKitCss } from '@atlas/view-runtime/view-kit';
import { themedViewDocument } from './viewTheme';
import type { ViewRenderResult } from './types';
test('host theme preserves user styles and script bytes after immutable Kit defaults', () => {
    const custom = ':root{--atlas-bg:papayawhip}atlas-button>button{color:papayawhip}';
    const script = '<script>const untouched = "literal";</script>';
    const source = `<style>${viewKitCss}${viewActionsCss}${custom}</style>${script}`;
    const result = themedViewDocument({ document: source, manifest: { viewKitVersion: 1 } } as ViewRenderResult);
    expect(result.indexOf('color-scheme:dark')).toBeGreaterThan(result.indexOf(viewKitCss));
    expect(result).toContain('atlas-button>button{color:');
    expect(result.indexOf(custom)).toBeGreaterThan(result.indexOf('color-scheme:dark'));
    expect(result.endsWith(script)).toBe(true);
});
test('legacy documents keep their original presentation', () => {
    const source = '<style>body{color:black}</style><p>Legacy View</p>';
    expect(themedViewDocument({ document: source } as ViewRenderResult)).toBe(source);
});
