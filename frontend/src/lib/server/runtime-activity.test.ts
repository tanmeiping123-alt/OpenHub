import { expect, it } from "vitest";
import { beginBackgroundWork, hasBackgroundWork } from "./runtime-activity";

it("retains activity until every background operation has finished, including repeated cleanup", () => {
  expect(hasBackgroundWork()).toBe(false);
  const first = beginBackgroundWork();
  const second = beginBackgroundWork();
  expect(hasBackgroundWork()).toBe(true);
  first();
  first();
  expect(hasBackgroundWork()).toBe(true);
  second();
  expect(hasBackgroundWork()).toBe(false);
});
