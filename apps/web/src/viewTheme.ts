import { viewActionsCss, viewKitCss } from '@atlas/view-runtime/view-kit';
import type { ViewRenderResult } from './types';

/** Host presentation only. Keep immutable Kit v1 and saved View CSS unchanged.
 * Theme before the user's CSS, so authored overrides retain their precedence.
 * Do not parse/reserialize the document: CSP and script hashes must stay intact.
 */
export function themedViewDocument(rendered: ViewRenderResult): string {
    const kit = viewKitCss + viewActionsCss;
    if (rendered.manifest?.viewKitVersion !== 1 || !rendered.document.includes(kit)) return rendered.document;
    const style = getComputedStyle(document.documentElement);
    const roles: Record<string, string> = {
        bg: 'bg', surface: 'surface', border: 'border', text: 'text-primary', muted: 'text-secondary',
        accent: 'accent', success: 'success', warning: 'warning', error: 'danger', info: 'information',
        'table-stripe': 'bg-secondary', radius: 'radius-md', font: 'font-sans',
    };
    const variables = Object.entries(roles).map(([kit, web]) => `--atlas-${kit}:${style.getPropertyValue(`--${web}`)};`).join('');
    const soft = (tone: string, role: string) => `atlas-badge[tone=${tone}]{background:${style.getPropertyValue(`--${role}-soft`)}}`;
    const theme = `\n:root{color-scheme:dark;${variables}--atlas-shadow:none}atlas-button>button{color:${style.getPropertyValue('--bg')}}[role=tab][aria-selected=true]{background:${style.getPropertyValue('--accent-solid')}}${soft('success', 'success')}${soft('warning', 'warning')}${soft('error', 'danger')}${soft('info', 'accent')}\n`;
    return rendered.document.replace(kit, () => kit + theme);
}
