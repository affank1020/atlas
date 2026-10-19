import { useEffect } from 'react';
import App from './App';

/** Routes own their data; startup never waits for catalogue or application I/O. */
export function Bootstrap() {
    useEffect(() => { if (!performance.getEntriesByName('atlas:shell').length) performance.measure('atlas:shell', { start: 0, end: performance.now() }); }, []);
    return <App />;
}
