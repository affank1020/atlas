import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { CatalogueHeading, CatalogueToolbar, filterCatalogue } from './CatalogueBrowse';

afterEach(cleanup);

function CatalogueTestPage() {
    const [query, setQuery] = useState('');
    return <section className="catalogue-page">
        <CatalogueHeading title="Projects" actions={<button>New project</button>} />
        <CatalogueToolbar label="Search projects" placeholder="Find a project…" query={query}
            onQueryChange={setQuery} count={query ? 1 : 2} itemName="project" />
    </section>;
}

test('shared catalogue heading and toolbar expose an accessible, controlled searchbox', () => {
    render(<CatalogueTestPage />);
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    const input = screen.getByRole('searchbox', { name: 'Search projects' });
    expect(input.closest('.browse-toolbar')).toBeInTheDocument();
    expect(screen.getByText('2 projects')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'uni' } });
    expect(input).toHaveValue('uni');
    expect(screen.getByText('1 project')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');
    expect(screen.getByText('2 projects')).toBeInTheDocument();
});

test('shared search matches multiple words in any order, ignores case and whitespace', () => {
    const items = [{ title: 'Football Training', project: 'Research' }, { title: 'Portfolio', project: 'Portfolio' }];
    const find = (query: string) => filterCatalogue(items, query, item => `${item.title} ${item.project}`);
    expect(find('  research   FOOTBALL  ')).toEqual([items[0]]);
    expect(find('  ')).toEqual(items);
    expect(find('unknown')).toEqual([]);
});
