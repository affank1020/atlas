import { useCallback } from 'react';
import { atlasApi, type ApplicationReadName } from './atlasApi';
import { useAppDispatch, useAppSelector } from './hooks';

/** Live dashboards reuse the last response for display, but refresh on every entry. */
export function useLiveApplicationResource<T>(name: ApplicationReadName) {
    const dispatch = useAppDispatch();
    const cached = useAppSelector(state => atlasApi.endpoints.applicationRead.select({ name, input: {} })(state).data) as T | undefined;
    const load = useCallback(async () => {
        const request = dispatch(atlasApi.endpoints.applicationRead.initiate({ name, input: {} }, { subscribe: false, forceRefetch: true }));
        return await request.unwrap() as T;
    }, [dispatch, name]);
    return { cached, load };
}
