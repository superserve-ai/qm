import { test } from "node:test";
import assert from "node:assert/strict";
import { clampUtf8, createOutputLimiter } from "../src/sandbox/superserve-client.ts";

test("clampUtf8 bounds output by bytes, not UTF-16 code units", () => {
  assert.equal(clampUtf8("a".repeat(100), 10), "a".repeat(10));
  assert.equal(Buffer.byteLength(clampUtf8("漢".repeat(10), 10), "utf8"), 9, "never exceeds the byte budget");
  assert.equal(clampUtf8("漢".repeat(10), 10), "漢漢漢");
  assert.equal(clampUtf8("", 10), "");
  assert.equal(clampUtf8("abc", 0), "");
  assert.equal(clampUtf8("abc", 10), "abc", "short input is returned untouched");
});

test("clampUtf8 cuts on a codepoint boundary and keeps a replacement character the input really had", () => {
  const withReplacement = `${"a".repeat(7)}�b`;
  assert.equal(Buffer.byteLength(withReplacement, "utf8"), 11);
  assert.equal(clampUtf8(withReplacement, 10), `${"a".repeat(7)}�`, "a real U+FFFD survives truncation");
  assert.ok(!clampUtf8("漢".repeat(10), 10).includes("�"), "truncation never invents one");
  assert.ok(!clampUtf8("😀".repeat(4), 6).includes("�"), "surrogate pairs are cut whole");
  assert.equal(clampUtf8("😀😀", 4), "😀");
});

test("the output limiter keeps a prefix of each stream and stops once it is full", () => {
  const limiter = createOutputLimiter(2);
  limiter.stdout("€");
  limiter.stdout("A");
  assert.equal(limiter.text("stdout"), "", "a character that cannot fit does not let later output jump the queue");
  assert.equal(limiter.truncated(), true);

  const ascii = createOutputLimiter(3);
  ascii.stdout("ab");
  ascii.stdout("cd");
  assert.equal(ascii.text("stdout"), "abc", "what is kept is always a prefix of the real output");
  ascii.stdout("ef");
  assert.equal(ascii.text("stdout"), "abc");
  assert.equal(ascii.truncated(), true);
});

test("the output limiter budgets each stream on its own and reports clean output as untruncated", () => {
  const limiter = createOutputLimiter(4);
  limiter.stdout("out");
  limiter.stderr("err");
  assert.equal(limiter.text("stdout"), "out");
  assert.equal(limiter.text("stderr"), "err");
  assert.equal(limiter.truncated(), false);
});
