import { describe, expect, it } from "vitest";
import {
  forEachConcurrent,
  PELICAN_DEFAULT_CONCURRENCY,
  PELICAN_MAX_CONCURRENCY,
  pelicanConcurrency,
} from "./concurrency";

describe("pelican batch concurrency", () => {
  it("defaults to bounded concurrency and clamps configured values", () => {
    expect(pelicanConcurrency({})).toBe(PELICAN_DEFAULT_CONCURRENCY);
    expect(pelicanConcurrency({ PROMPTMASTER_PELICAN_CONCURRENCY: "" })).toBe(
      PELICAN_DEFAULT_CONCURRENCY,
    );
    expect(pelicanConcurrency({ PROMPTMASTER_PELICAN_CONCURRENCY: "1" })).toBe(1);
    expect(pelicanConcurrency({ PROMPTMASTER_PELICAN_CONCURRENCY: "4" })).toBe(4);
    expect(pelicanConcurrency({ PROMPTMASTER_PELICAN_CONCURRENCY: "99" })).toBe(
      PELICAN_MAX_CONCURRENCY,
    );
    expect(pelicanConcurrency({ PROMPTMASTER_PELICAN_CONCURRENCY: "0" })).toBe(1);
    expect(pelicanConcurrency({ PROMPTMASTER_PELICAN_CONCURRENCY: "not-a-number" })).toBe(
      PELICAN_DEFAULT_CONCURRENCY,
    );
  });

  it("keeps at most the configured number of workers in flight and visits every item", async () => {
    let active = 0;
    let peak = 0;
    const visited: number[] = [];
    await forEachConcurrent([1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      visited.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(peak).toBe(2);
    expect(visited.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("lets later items start before earlier slow items finish", async () => {
    const events: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const run = forEachConcurrent(["slow", "fast"], 2, async (item) => {
      if (item === "slow") {
        events.push("slow:start");
        await slowGate;
        events.push("slow:end");
      } else {
        events.push("fast:start");
        events.push("fast:end");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["slow:start", "fast:start", "fast:end"]);
    releaseSlow();
    await run;
    expect(events).toEqual(["slow:start", "fast:start", "fast:end", "slow:end"]);
  });
});
