import { describe, expect, it } from "vitest";
import type { Event } from "@niq.run/worker-sdk";
import { EventInbox } from "./inbox.js";

function event(type: string, workerID = "peer", payload: Record<string, unknown> = {}): Event {
  return {
    id: `e-${Math.random().toString(16).slice(2)}`,
    type,
    status: "delivered",
    payload,
    worker_id: workerID,
    timestamp: Date.now(),
  };
}

describe("EventInbox", () => {
  it("numbers events monotonically and reads from a cursor", () => {
    const inbox = new EventInbox(10);
    inbox.push(event("a"));
    inbox.push(event("b"));

    const first = inbox.read();
    expect(first.events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(first.next_cursor).toBe(2);
    expect(first.oldest_cursor).toBe(1);
    expect(first.latest_cursor).toBe(2);

    const second = inbox.read({ cursor: first.next_cursor });
    expect(second.events).toEqual([]);
    // No new events: the cursor stays where the reader left it.
    expect(second.next_cursor).toBe(2);
  });

  it("honours limit and reports the cursor of the last returned event", () => {
    const inbox = new EventInbox(10);
    for (const type of ["a", "b", "c"]) inbox.push(event(type));

    const slice = inbox.read({ limit: 2 });
    expect(slice.events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(slice.next_cursor).toBe(2);
    expect(slice.latest_cursor).toBe(3);
  });

  it("filters by event type pattern and sender", () => {
    const inbox = new EventInbox(10);
    inbox.push(event("reason.delta", "reason.0"));
    inbox.push(event("reason", "reason.0"));
    inbox.push(event("worker.ready", "other"));

    const byType = inbox.read({ types: ["reason.*"] });
    expect(byType.events.map((e) => e.type)).toEqual(["reason.delta", "reason"]);

    const bySender = inbox.read({ from: ["other"] });
    expect(bySender.events.map((e) => e.type)).toEqual(["worker.ready"]);

    const both = inbox.read({ types: ["reason.*"], from: ["other"] });
    expect(both.events).toEqual([]);
  });

  it("drops the oldest events at the bound and reports the gap", () => {
    const inbox = new EventInbox(2);
    inbox.push(event("a"));
    inbox.push(event("b"));
    inbox.push(event("c"));

    expect(inbox.size).toBe(2);
    expect(inbox.droppedTotal).toBe(1);

    const slice = inbox.read();
    expect(slice.events.map((e) => e.type)).toEqual(["b", "c"]);
    expect(slice.oldest_cursor).toBe(2);
    // A reader that wanted everything missed "a".
    expect(slice.gap).toBe(true);

    // A reader already past the dropped range sees no gap.
    expect(inbox.read({ cursor: 2 }).gap).toBe(false);
  });

  it("waits for a push instead of returning empty immediately", async () => {
    const inbox = new EventInbox(10);
    const pending = inbox.readWithWait({}, 1_000);

    setTimeout(() => inbox.push(event("late")), 10);

    const slice = await pending;
    expect(slice.events.map((e) => e.type)).toEqual(["late"]);
  });

  it("returns empty after the wait when nothing arrives", async () => {
    const inbox = new EventInbox(10);
    const started = Date.now();
    const slice = await inbox.readWithWait({}, 30);
    expect(slice.events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("stops waiting when the session is already closed", async () => {
    const inbox = new EventInbox(10);
    const started = Date.now();
    const slice = await inbox.readWithWait({}, 10_000, () => true);
    expect(slice.events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
