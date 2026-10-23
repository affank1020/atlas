import { isAbsolute, relative, resolve } from "node:path";

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

export function scopeLcov(raw, checkoutRoot) {
  // Coverage source paths may be absolute or relative to the checkout. Never
  // search for a nested "apps/" or "packages/" segment in an arbitrary path:
  // dependencies and test fixtures can have those same directory names.
  if (typeof checkoutRoot !== "string" || !isAbsolute(checkoutRoot)) {
    throw new Error("Atlas checkout root must be an absolute path");
  }
  const root = resolve(checkoutRoot);
  const selected = [];
  // Include only exercised Atlas app/package modules under the top-level
  // checkout directories, not test fixtures, node_modules or external files.
  // Unloaded files and Vitest/browser code are not represented.
  for (const chunk of raw.split("end_of_record")) {
    const lines = chunk.trim();
    if (!lines) continue;
    const source = /^SF:(.+)$/m.exec(lines)?.[1]?.replaceAll("\\", "/");
    if (!source) throw new Error("LCOV record missing source filename");
    const localPath = relative(root, resolve(root, source)).replaceAll("\\", "/");
    if (!/^(?:apps|packages)\/[^/]+\/(?:src|dist)\/[^/]+/.test(localPath)) continue;
    if (localPath.split("/").includes("node_modules")) continue;
    selected.push(lines + "\nend_of_record\n");
  }
  if (!selected.length) {
    throw new Error("Node coverage included no Atlas application or package files");
  }
  return selected.join("");
}
