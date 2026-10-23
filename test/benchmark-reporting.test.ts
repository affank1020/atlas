import assert from "node:assert/strict";
import test from "node:test";
import { mergeJunit, scopeLcov } from "../scripts/benchmark-reporting.mjs";

test("Benchmark JUnit merges Node root testcases and nested Vitest suites exactly once", () => {
  const node = '<?xml version="1.0"?><testsuites>\n' +
    '<testcase name="node" classname="integration"/>\n</testsuites>';
  const web = '<?xml version="1.0"?><testsuites name="web" tests="2">\n' +
    '<testsuite name="ui" tests="2" failures="1">' +
    '<testcase name="pass"/><testcase name="fail"><failure message="x"/></testcase>' +
    '</testsuite>\n</testsuites>';
  const result = mergeJunit(node, web);
  assert.equal((result.match(/<testcase\b/g) ?? []).length, 3);
  assert.equal((result.match(/<testsuites>/g) ?? []).length, 1);
  assert.match(result, /<testsuite name="ui" tests="2" failures="1">/);
  assert.match(result, /<failure message="x"\/>/);
});

test("Benchmark JUnit permits a partially completed failed test job", () => {
  const node = '<testsuites><testcase name="failed"><failure/></testcase></testsuites>';
  assert.match(mergeJunit(node, null), /<failure\/>/);
  assert.throws(() => mergeJunit(null, null), /No JUnit/);
  assert.throws(() => mergeJunit("not xml", null), /did not emit/);
});

test("Benchmark Node coverage excludes test runners/dependencies and web-only code", () => {
  const source = [
    "TN:\nSF:/checkout/test/unit.test.ts\nLH:1\nLF:1\nend_of_record\n",
    "TN:\nSF:/checkout/node_modules/tsx/index.js\nLH:1\nLF:1\nend_of_record\n",
    "TN:\nSF:/checkout/apps/server/src/server.ts\nLH:4\nLF:8\nFNH:1\nFNF:2\nend_of_record\n",
    "TN:\nSF:apps/node/dist/node.js\nLH:3\nLF:3\nend_of_record\n",
    "TN:\nSF:packages/protocol/src/schema.ts\nLH:2\nLF:4\nend_of_record\n"
  ].join("");
  const filtered = scopeLcov(source, "/checkout");
  assert.equal((filtered.match(/end_of_record/g) ?? []).length, 3);
  assert.doesNotMatch(filtered, /test\/unit|node_modules/);
  assert.match(filtered, /SF:\/checkout\/apps\/server\/src\/server\.ts/);
  assert.match(filtered, /SF:apps\/node\/dist\/node\.js/);
  assert.match(filtered, /SF:packages\/protocol\/src\/schema\.ts/);
  assert.throws(() => scopeLcov("TN:\nSF:test/sample.test.ts\nLH:1\nLF:1\nend_of_record\n", "/checkout"),
    /no Atlas application/);
});

test("Benchmark LCOV accepts only top-level Atlas paths under the chosen checkout", () => {
  const record = (path, hit) =>
    "TN:\nSF:" + path + "\nLH:" + hit + "\nLF:5\nend_of_record\n";
  const source = [
    record("/checkout/apps/server/src/api.ts", 4),
    record("packages/protocol/dist/schema.js", 3),
    record("/checkout/node_modules/vendor/packages/engine/src/index.js", 2),
    record("/checkout/test/fixtures/apps/demo/src/index.ts", 1),
    record("/checkout-backup/apps/server/src/copy.ts", 1),
    record("../untrusted/apps/server/src/other.ts", 1),
    record("/checkout/apps/server/src/node_modules/nested/index.js", 1),
    record("/checkout/apps/server/fixtures/src/fixture.ts", 1)
  ].join("");
  const scoped = scopeLcov(source, "/checkout");
  assert.equal((scoped.match(/end_of_record/g) ?? []).length, 2);
  assert.match(scoped, /SF:\/checkout\/apps\/server\/src\/api\.ts/);
  assert.match(scoped, /SF:packages\/protocol\/dist\/schema\.js/);
  assert.doesNotMatch(scoped, /node_modules|fixtures|checkout-backup|untrusted/);
  assert.throws(() => scopeLcov(source), /checkout root must be an absolute path/);
  assert.throws(() => scopeLcov(source, "."), /checkout root must be an absolute path/);
});

test("Benchmark LCOV rejects external sources even if their path contains apps and packages", () => {
  for (const source of [
    "/checkout/node_modules/vendor/packages/engine/src/index.js",
    "/checkout/test/fixtures/apps/demo/src/index.ts",
    "/checkout-copy/apps/server/src/api.ts",
    "../another-repo/apps/server/src/api.ts"
  ]) {
    const record = "SF:" + source + "\nLH:1\nLF:1\nend_of_record\n";
    assert.throws(() => scopeLcov(record, "/checkout"),
      /no Atlas application or package files/, source);
  }
});
