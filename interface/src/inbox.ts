/**
 * The MCP server's in-memory inbox.
 *
 * A persistent `niq-interface mcp` session keeps one SSE connection open, so
 * events routed to its identity arrive continuously. This is the buffer between
 * that pump and the tool calls that read it: bounded (old events are dropped),
 * cursor-based (a reader resumes where it left off, never re-reading), and
 * waitable (a poll can block briefly instead of spinning).
 *
 * Rows are numbered with a monotonically increasing `seq`, independent of the
 * event ids: the client sends back the last `seq` it saw as `cursor`.
 */
import { matchesType, type Event } from "@niq.run/worker-sdk";

/** What a reader asks for. */
export interface InboxQuery {
  /** Return events with `seq > cursor`. Default 0 (everything still buffered). */
  cursor?: number;
  /** Maximum events to return. Default 50, capped at 500. */
  limit?: number;
  /** Event-type patterns to include (exact, `*`, `prefix.*`). Omitted = all. */
  types?: string[];
  /** Only events sent by these worker ids. Omitted = any sender. */
  from?: string[];
}

/** What a reader gets back. */
export interface InboxSlice {
  events: Event[];
  /** Pass back as `cursor` next time. The last returned seq, else the input cursor. */
  next_cursor: number;
  /** Seq of the oldest event still buffered (0 when empty). */
  oldest_cursor: number;
  /** Seq of the newest event ever buffered (0 when none). */
  latest_cursor: number;
  /** Events dropped by the bound so far (cumulative). */
  dropped: number;
  /** True when events after `cursor` were dropped before the reader got here. */
  gap: boolean;
}

export const DEFAULT_INBOX_LIMIT = 50;
export const MAX_INBOX_LIMIT = 500;
export const DEFAULT_INBOX_SIZE = 500;

export class EventInbox {
  private readonly capacity: number;
  /** Oldest first. */
  private rows: { seq: number; event: Event }[] = [];
  private seq = 0;
  private dropped = 0;
  private readonly waiters = new Set<() => void>();

  constructor(capacity: number = DEFAULT_INBOX_SIZE) {
    this.capacity = Math.max(1, Math.trunc(capacity));
  }

  /** Append an event and wake any waiting reader. Returns its seq. */
  push(event: Event): number {
    this.seq += 1;
    this.rows.push({ seq: this.seq, event });
    while (this.rows.length > this.capacity) {
      this.rows.shift();
      this.dropped += 1;
    }
    for (const wake of [...this.waiters]) wake();
    return this.seq;
  }

  /** Seq of the newest event, or 0 when nothing has been pushed. */
  get latestCursor(): number {
    return this.seq;
  }

  /** Events dropped by the bound so far. */
  get droppedTotal(): number {
    return this.dropped;
  }

  /** Number of events currently held. */
  get size(): number {
    return this.rows.length;
  }

  /** Take a slice without waiting. */
  read(query: InboxQuery = {}): InboxSlice {
    const cursor = Math.max(0, Math.trunc(query.cursor ?? 0));
    const limit = clamp(Math.trunc(query.limit ?? DEFAULT_INBOX_LIMIT), 1, MAX_INBOX_LIMIT);
    const types = query.types?.filter(Boolean) ?? [];
    const from = query.from?.filter(Boolean) ?? [];

    const events: Event[] = [];
    let lastSeq = 0;
    for (const row of this.rows) {
      if (row.seq <= cursor) continue;
      if (types.length > 0 && !types.some((p) => matchesType(p, row.event.type))) continue;
      if (from.length > 0 && !from.includes(row.event.worker_id)) continue;
      events.push(row.event);
      lastSeq = row.seq;
      if (events.length >= limit) break;
    }

    const oldest = this.rows.length > 0 ? this.rows[0].seq : 0;
    return {
      events,
      next_cursor: lastSeq || cursor,
      oldest_cursor: oldest,
      latest_cursor: this.seq,
      dropped: this.dropped,
      gap: oldest > 0 && oldest > cursor + 1,
    };
  }

  /**
   * Read, and if nothing matches yet, wait up to `waitMs` for new events.
   *
   * `isClosed` is checked between waits so a caller whose session died does not
   * sit in a long poll that can never be satisfied.
   */
  async readWithWait(
    query: InboxQuery = {},
    waitMs = 0,
    isClosed: () => boolean = () => false,
  ): Promise<InboxSlice> {
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const slice = this.read(query);
      if (slice.events.length > 0) return slice;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || isClosed()) return slice;
      // The cap also re-checks isClosed periodically when nothing arrives.
      await this.waitForPush(Math.min(remaining, 250));
    }
  }

  /** Resolve on the next push, or after `timeoutMs`. */
  private waitForPush(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      this.waiters.add(done);
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
