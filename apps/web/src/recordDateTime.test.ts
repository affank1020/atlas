import { expect, test } from 'vitest';
import { localInputToStoredDateTime, storedDateTimeToLocalInput } from './recordDateTime';

test('a browser datetime-local value becomes an explicit UTC instant', () => {
    const raw = '2026-10-22T12:00';
    expect(localInputToStoredDateTime(raw)).toBe(new Date(raw).toISOString());
    expect(localInputToStoredDateTime('2026-10-22T12:00:01.250'))
        .toBe(new Date('2026-10-22T12:00:01.250').toISOString());
});

test('persisted offset timestamps display as local wall-clock values', () => {
    const iso = '2026-10-22T13:00:00.123+01:00';
    const local = storedDateTimeToLocalInput(iso);
    expect(local).toBe(storedDateTimeToLocalInput(new Date(iso).toISOString()));
    expect(localInputToStoredDateTime(local)).toBe(new Date(iso).toISOString());
    expect(storedDateTimeToLocalInput(undefined)).toBe('');
    expect(storedDateTimeToLocalInput('not a date')).toBe('');
});

test('local editor rejects impossible calendar dates and DST gaps rather than silently normalizing', () => {
    for (const raw of ['2026-02-30T12:00', '2026-10-22T25:00', 'not a date']) {
        expect(() => localInputToStoredDateTime(raw)).toThrow();
    }
});

test('whole-minute timestamps use the browser-normalized datetime-local representation', () => {
    const local = storedDateTimeToLocalInput('2026-10-22T12:00:00Z');
    expect(local).toMatch(/T\d{2}:\d{2}$/);
    expect(localInputToStoredDateTime(local)).toBe('2026-10-22T12:00:00.000Z');
});
