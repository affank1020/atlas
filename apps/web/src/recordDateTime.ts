/** Browser datetime-local inputs represent wall-clock time, not an instant.
 * Convert persisted offset-bearing timestamps for display in the user's timezone.
 */
export function storedDateTimeToLocalInput(value: unknown): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (number: number, width = 2) => String(number).padStart(width, '0');
    const milliseconds = date.getMilliseconds();
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${date.getSeconds() || milliseconds ? ':' + pad(date.getSeconds()) : ''}${milliseconds ? '.' + pad(milliseconds, 3) : ''}`;
}

/** Interpret an edited wall-clock value in the browser's local timezone,
 * then send an unambiguous timestamp to Atlas Server.
 */
export function localInputToStoredDateTime(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
    if (!match) throw new Error('Enter a valid local date and time.');
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) ||
        date.getFullYear() !== Number(match[1]) ||
        date.getMonth() + 1 !== Number(match[2]) ||
        date.getDate() !== Number(match[3]) ||
        date.getHours() !== Number(match[4]) ||
        date.getMinutes() !== Number(match[5]) ||
        date.getSeconds() !== Number(match[6] ?? '0')) {
        throw new Error('That date and time does not exist in your local timezone.');
    }
    return date.toISOString();
}
