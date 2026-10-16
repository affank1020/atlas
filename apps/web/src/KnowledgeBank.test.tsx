import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { KnowledgeBank } from './KnowledgeBank';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const overview = { groups: [
    {id:'g1',key:'ux',name:'COMP33511 · User Experience'},
    {id:'g2',key:'fyp',name:'Final Year Project'}],
    counts:{'Knowledge Sources':2,'Knowledge Entries':146,'Knowledge Sections':0,'Knowledge Relationships':0},
};
beforeEach(() => {
    vi.resetAllMocks();
    // jsdom does not implement the native modal methods in all test environments.
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
    };
    window.location.hash = '#/projects/project/applications/knowledge-bank';
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'knowledge_bank_overview') return overview as never;
        const params = input as {collection?:string;offset?:number;group?:string};
        const total = params.group === 'ux' ? 145 : 146;
        const offset = params.offset || 0;
        const items = Array.from({ length: Math.min(25, Math.max(0, total - offset)) }, (_, i) => ({
            id:'record-'+(offset+i),title:'UX concept '+(offset+i),kind:'concept',
            sourceKey:'ux-book',sourceTitle:'Lecturer notes',summary:'A source-grounded concept.', detail:'Extended contextual analysis.',
            sourceExcerpt:'Verified lecturer statement from the original passage.',
            locator:'Chapter 1 > Being Critical',
            sourceLink:'https://leanpub.com/read/UX/wrong',
            confidenceNote:'Some numerical claims remain unverified.',
        }));
        return {items,total,offset,limit:25} as never;
    });
});
afterEach(cleanup);

test('Knowledge Bank defaults to all groups and paginates using server totals', async () => {
    render(<KnowledgeBank />);
    expect(screen.getByRole('combobox', {name:'Knowledge group'})).toHaveValue('');
    expect(await screen.findByText('146 results')).toBeInTheDocument();
    expect(screen.getByText('1–25 of 146')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Next'}));
    await waitFor(() => expect(vi.mocked(callTool)).toHaveBeenCalledWith('knowledge_bank_browse',
        expect.objectContaining({collection:'entries',offset:25,group:'',limit:25}), expect.anything()));
    expect(await screen.findByText('26–50 of 146')).toBeInTheDocument();
});

test('Knowledge Bank group filtering runs on the server and preserves source provenance', async () => {
    render(<KnowledgeBank />);
    expect(await screen.findByText('146 results')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', {name:'Knowledge group'}), {target:{value:'ux'}});
    await waitFor(() => expect(vi.mocked(callTool)).toHaveBeenCalledWith('knowledge_bank_browse',
        expect.objectContaining({group:'ux',offset:0}), expect.anything()));
    expect(await screen.findByText('145 results')).toBeInTheDocument();
    fireEvent.click(screen.getByText('UX concept 0'));
    expect(within(screen.getByRole('complementary', {name:'Record details'})).getByText('Source and provenance')).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', {name:'Record details'})).getByText('Lecturer notes')).toBeInTheDocument();
});

test('clicking a knowledge entry opens a full-size, source-first reading dialog', async () => {
    render(<KnowledgeBank />);
    expect(await screen.findByText('146 results')).toBeInTheDocument();
    fireEvent.click(screen.getByText('UX concept 0'));
    const dialog = screen.getByRole('dialog', {name:'Full details: UX concept 0'});
    expect(dialog).toHaveAttribute('open');
    expect(within(dialog).getByText('Original notes · Verbatim passage')).toBeInTheDocument();
    expect(within(dialog).getByText('Verified lecturer statement from the original passage.')).toBeInTheDocument();
    expect(within(dialog).getByText('AI-organised summary')).toBeInTheDocument();
    expect(within(dialog).getByText('Extended contextual analysis.')).toBeInTheDocument();
    expect(within(dialog).getByText('Some numerical claims remain unverified.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link',{name:'Open referenced section ↗'}))
        .toHaveAttribute('href','https://leanpub.com/read/UX/wrong');
    fireEvent.click(within(dialog).getByRole('button',{name:'Close expanded entry'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
