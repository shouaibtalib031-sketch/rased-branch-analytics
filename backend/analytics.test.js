import test from "node:test";
import assert from "node:assert/strict";
import { statusOf } from "./rules.js";

test("branch classifications match the operating policy",()=>{
  assert.equal(statusOf(95),"excellent");
  assert.equal(statusOf(80),"good");
  assert.equal(statusOf(70),"medium");
  assert.equal(statusOf(60),"weak");
  assert.equal(statusOf(59.9),"danger");
});
