import { Provider } from 'react-redux';
import { beforeAll, afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Records } from './App';
import { createAtlasStore } from './store';
import { storedDateTimeToLocalInput } from './recordDateTime';
import type { Store, AtlasRecord } from './types';

const timestamp = '2026-10-22T13:00:00.123456+01:00';
const reviewStore: Store = {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    name: 'Review runs', description: '',
    schema: { version: 1, fields: [
        { name: 'reviewedAt', type: 'datetime', required: true },
        { name: 'title', type: 'string' },
    ] },
    createdAt: timestamp, updatedAt: timestamp,
};
const sample: AtlasRecord = {
    id: '00000000-0000-4000-8000-000000000003',
    projectId: reviewStore.projectId, storeId: reviewStore.id,
    data: { reviewedAt: timestamp, title: 'Original' }, createdAt: timestamp, updatedAt: timestamp,
};

// jsdom does not implement the native dialog API.
beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        configurable: true, value: function(this: HTMLDialogElement) { this.open = true; },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
        configurable: true, value: function(this: HTMLDialogElement) { this.open = false; },
    });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(initial: AtlasRecord[] = []) {
    const requests: { tool: string; input: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
        const tool = url.split('/').pop()!;
        const input = JSON.parse(String(options.body)) as Record<string, unknown>;
        requests.push({ tool, input });
        const body = tool === 'list_records' ? {
            items: initial, total: initial.length, offset: 0, limit: 25,
        } : { id: sample.id };
        return { ok: true, status: 200, json: async () => body };
    }));
    const { store, unsubscribeMutations } = createAtlasStore();
    const result = render(<Provider store={store}><Records store={reviewStore} /></Provider>);
    return { ...result, requests, unsubscribeMutations };
}

test('creating a Record converts datetime-local to timezone-aware server input', async () => {
    const view = setup();
    try {
        expect(await screen.findByText('No records found.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'New record' }));
        const input = screen.getByLabelText(/reviewedAt/) as HTMLInputElement;
        expect(input.type).toBe('datetime-local');
        fireEvent.change(input, { target: { value: '2026-10-22T12:00' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
        await waitFor(() => {
            const save = view.requests.find(request => request.tool === 'create_record');
            expect(save?.input.data).toMatchObject({
                reviewedAt: new Date('2026-10-22T12:00').toISOString(),
            });
        });
    } finally {
        view.unmount(); view.unsubscribeMutations();
    }
});

test('editing a Record preserves unchanged datetime precision and converts changed local time', async () => {
    const view = setup([sample]);
    try {
        expect(await screen.findByText('Original')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const input = screen.getByLabelText(/reviewedAt/) as HTMLInputElement;
        expect(input.value).toBe(storedDateTimeToLocalInput(timestamp));
        fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Revised' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
        await waitFor(() => {
            const save = view.requests.find(request => request.tool === 'update_record');
            expect(save?.input.data).toMatchObject({ reviewedAt: timestamp, title: 'Revised' });
        });
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        fireEvent.change(screen.getByLabelText(/reviewedAt/), { target: { value: '2026-10-23T09:15' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
        await waitFor(() => {
            const saves = view.requests.filter(request => request.tool === 'update_record');
            expect(saves).toHaveLength(2);
            expect(saves[1].input.data).toMatchObject({
                reviewedAt: new Date('2026-10-23T09:15').toISOString(),
            });
        });
    } finally {
        view.unmount(); view.unsubscribeMutations();
    }
});

test('editing another field on a persisted timezone-less datetime preserves its raw legacy value', async () => {
    const legacy = '2026-10-22T12:00';
    const originalRecord: AtlasRecord = {
        ...sample, data: { reviewedAt: legacy, title: 'Legacy record' },
    };
    const view = setup([originalRecord]);
    try {
        expect(await screen.findByText('Legacy record')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const dateInput = screen.getByLabelText(/reviewedAt/) as HTMLInputElement;
        expect(dateInput.value).toBe(legacy);
        fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Updated title' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
        await waitFor(() => {
            const save = view.requests.find(request => request.tool === 'update_record');
            expect(save?.input.replace).toBe(true);
            expect(save?.input.data).toMatchObject({ reviewedAt: legacy, title: 'Updated title' });
        });
    } finally {
        view.unmount(); view.unsubscribeMutations();
    }
});
