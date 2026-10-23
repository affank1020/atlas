// Reporting-only helpers: parse CI-generated JUnit and restrict V8 LCOV to
// exercised Atlas application/package code. This is NOT whole-repo coverage.
const JUNIT_LIMIT = 10 * 1024 * 1024;
const xmlContainer = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<testsuites(?:\s[^>]*?)?>([\s\S]*)<\/testsuites>\s*$/;

export function mergeJunit(nodeXml, webXml) {
  const pieces = [];
  for (const [name, source] of [["Node", nodeXml], ["Vitest", webXml]]) {
    if (!source) continue;
    const match = xmlContainer.exec(source);
    if (!match) throw new Error(name + " did not emit a JUnit <testsuites> document");
    pieces.push(match[1]);
  }
  if (!pieces.length) throw new Error("No JUnit results were produced");
  const result = '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<testsuites>\n' + pieces.join("\n") + '\n</testsuites>\n';
  if (Buffer.byteLength(result) > JUNIT_LIMIT) {
    throw new Error("Combined JUnit exceeds Benchmark's 10 MiB input limit");
  }
  return result;
}

export function scopeLcov(raw) {
  const selected = [];
  // The native Node coverage reporter includes test harness files and
  // loaded dependencies. Count only exercised application/package modules.
  // Unloaded files and Vitest browser code are not represented.
  for (const chunk of raw.split("end_of_record")) {
    const lines = chunk.trim();
    if (!lines) continue;
    const path = /^SF:(.+)$/m.exec(lines)?.[1]?.replaceAll("\\", "/");
    if (!path) throw new Error("LCOV record missing source filename");
    if (!/(?:^|\/)(?:apps|packages)\/[^/]+\/(?:src|dist)\//.test(path)) continue;
    selected.push(lines + "\nend_of_record\n");
  }
  if (!selected.length) {
    throw new Error("Node coverage included no Atlas application or package files");
  }
  return selected.join("");
}
