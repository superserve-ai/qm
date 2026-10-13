import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as reporting from "../plugins/chassis/src/error-reporting.ts";

let flush: () => Promise<void> = async () => {};
mock.module("../plugins/chassis/src/error-reporting.ts", {
  namedExports: { ...reporting, flushErrorReporting: () => flush() },
});
const { stopWithBackstop } = await import("../src/wiring.ts");
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

for (const mode of ["stalled", "rejected", "release-rejected", "release-stalled"] as const) {
  test(`runtime ${mode} cleanup overlaps reporting and lease release`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const exits: Array<number | undefined> = [];
    t.mock.method(process, "exit", (code?: number) => exits.push(code));
    t.mock.method(console, "error", () => {});
    let released = false;
    let flushed = false;
    let releaseStarted = false;
    let flushStarted = false;
    flush = () => {
      flushStarted = true;
      return new Promise((resolve) =>
        setTimeout(() => {
          flushed = true;
          resolve();
        }, 2_000),
      );
    };
    stopWithBackstop(
      {
        stop: () => (mode === "stalled" ? new Promise(() => {}) : Promise.reject(new Error("stop failed"))),
        releaseInFlightRuns: () => {
          releaseStarted = true;
          if (mode === "release-stalled") return new Promise(() => {});
          if (mode === "release-rejected") return Promise.reject(new Error("release failed"));
          return new Promise((resolve) =>
            setTimeout(() => {
              released = true;
              resolve();
            }, 3_000),
          );
        },
      },
      1_000,
      "test",
    );
    await settle();
    if (mode === "stalled") t.mock.timers.tick(6_000);
    await settle();
    assert.equal(releaseStarted, true);
    assert.equal(flushStarted, true);
    t.mock.timers.tick(2_000);
    await settle();
    assert.equal(flushed, true);
    if (mode === "release-rejected") {
      assert.deepEqual(exits, [1]);
    } else {
      assert.deepEqual(exits, []);
      t.mock.timers.tick(1_000);
      await settle();
      assert.equal(released, mode !== "release-stalled");
      assert.deepEqual(exits, [mode === "stalled" ? undefined : 1]);
    }
  });
}
