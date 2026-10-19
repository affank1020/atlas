import { diagnostics } from './performance';
import { configureStore, createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { atlasApi, mutationTags } from './atlasApi';
import { onToolMutation } from './api';

const preferences = createSlice({
    name: 'preferences',
    initialState: { includeArchivedProjects: false },
    reducers: { setIncludeArchivedProjects: (state, action: PayloadAction<boolean>) => { state.includeArchivedProjects = action.payload; } },
});
export const { setIncludeArchivedProjects } = preferences.actions;

const performanceMiddleware: Middleware = () => next => action => {
            if (typeof action === 'object' && action && 'type' in action) {
                const entry = action as { type: string; meta?: { condition?: boolean } };
                if (entry.type === 'atlasApi/executeQuery/pending') diagnostics.queryStarts++;
                // RTK condition rejections include cache reuse and in-flight deduplication.
                if (entry.type === 'atlasApi/executeQuery/rejected' && entry.meta?.condition) diagnostics.cacheReuses++;
            }
            return next(action);
        };

export function createAtlasStore() {
    const store = configureStore({
        reducer: { [atlasApi.reducerPath]: atlasApi.reducer, preferences: preferences.reducer },
        middleware: getDefaultMiddleware => getDefaultMiddleware().concat(performanceMiddleware, atlasApi.middleware),
    });
    // Direct callTool writes in operational and not-yet-migrated screens still
    // invalidate only the RTK data affected by that mutation.
    const unsubscribeMutations = onToolMutation(mutation => {
        const tags = mutationTags(mutation);
        if (tags.length) store.dispatch(atlasApi.util.invalidateTags(tags));
    });
    return { store, unsubscribeMutations };
}

const appStore = createAtlasStore();
export const store = appStore.store;
setupListeners(store.dispatch);
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
