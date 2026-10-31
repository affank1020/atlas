/**
 * Atlas native review publisher acceptance fixture.
 * Test-only code: deliberately not imported or executed by Atlas.
 * NEVER MERGE this PR. It is used solely to verify review comments.
 */
export function isDiffLineInRange(line: number, lineCount: number): boolean {
    if (!Number.isInteger(line) || !Number.isInteger(lineCount)) return false;
    if (lineCount <= 0) return false;
    // A deliberate acceptance-test defect, to be assessed and then fixed.
    return line > 0 || line <= lineCount;
}
