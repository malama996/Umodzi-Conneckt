/**
 * Shared polling engine (Task 22).
 *
 * One short-interval loop per resource key, shared by every
 * subscriber of that resource (refcounted), so the same request or
 * technician is never polled by multiple independent timers.
 *
 * Guarantees:
 * - No overlapping requests: a tick is skipped while the previous
 *   fetch for that resource is still in flight.
 * - Clean teardown: the timer stops and the group is discarded when
 *   the last subscriber unsubscribes; snapshots that finish after
 *   teardown are dropped (no post-unmount emissions).
 * - Failures never masquerade as success: a failed refresh emits a
 *   non-destructive `error` connection event carrying the last known
 *   good data (or null) — `changed`/`baseline` stay false, so no UI
 *   logic can mistake a failure for a state transition.
 * - Terminal states: when the target reports a terminal snapshot the
 *   final event is emitted with connection 'stopped' and the timer is
 *   cleared — observation ends, cleanup still runs on unsubscribe.
 * - Recovery: once a later refresh succeeds, a `live` event is emitted
 *   (connection changed) so the UI can clear its warning.
 *
 * Transport here is plain GET polling of existing endpoints; swapping
 * this module for SSE/WebSockets requires no change to subscribers.
 */
import type { RealtimeUpdate } from './types';

/** A pollable resource: how to fetch, diff, and recognise its end. */
export interface PollTarget<T> {
  fetchSnapshot(): Promise<T>;
  /** True when observation should stop after this snapshot is emitted. */
  isTerminal?(snapshot: T): boolean;
  /** Semantic diff against the previous successful snapshot. */
  hasChanged(previous: T, next: T): boolean;
}

type UpdateListener<T> = (update: RealtimeUpdate<T>) => void;

interface PollGroup<T> {
  target: PollTarget<T>;
  listeners: Set<UpdateListener<T>>;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  lastData: T | null;
  connection: 'connecting' | 'live' | 'error' | 'stopped';
  stopped: boolean;
  intervalMs: number;
}

/** Resource key → active group. At most one loop per key. */
const groups = new Map<string, PollGroup<unknown>>();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Live update refresh failed.';
}

async function runTick<T>(key: string, group: PollGroup<T>): Promise<void> {
  if (group.inFlight || group.stopped) return;
  group.inFlight = true;
  try {
    const snapshot = await group.target.fetchSnapshot();
    // The group may have been torn down while the request was in
    // flight — drop the result instead of emitting after unsubscribe.
    if (groups.get(key) !== group || group.stopped) return;

    const connectionBefore = group.connection;
    const baseline = group.lastData === null;
    const changed =
      baseline || group.lastData === null
        ? false
        : group.target.hasChanged(group.lastData, snapshot);
    group.lastData = snapshot;

    const terminal = group.target.isTerminal?.(snapshot) ?? false;
    group.connection = terminal ? 'stopped' : 'live';
    if (terminal) {
      group.stopped = true;
      if (group.timer !== null) {
        clearInterval(group.timer);
        group.timer = null;
      }
    }

    const connectionChanged = connectionBefore !== group.connection;
    if (baseline || changed || connectionChanged) {
      const update: RealtimeUpdate<T> = {
        data: snapshot,
        changed,
        baseline,
        connection: group.connection,
        error: '',
      };
      for (const listener of [...group.listeners]) listener(update);
    }
  } catch (error) {
    if (groups.get(key) !== group) return;
    const connectionBefore = group.connection;
    group.connection = 'error';
    // Only signal the transition into 'error'; repeated failures keep
    // the existing warning instead of re-emitting every interval.
    if (connectionBefore !== 'error') {
      const update: RealtimeUpdate<T> = {
        data: group.lastData,
        changed: false,
        baseline: false,
        connection: 'error',
        error: describeError(error),
      };
      for (const listener of [...group.listeners]) listener(update);
    }
  } finally {
    group.inFlight = false;
  }
}

/**
 * Subscribe to a pollable resource. Starts the shared loop on the
 * first subscriber (with an immediate first tick) and stops it when
 * the last subscriber unsubscribes. Returns the unsubscribe function.
 */
export function pollResource<T>(
  key: string,
  target: PollTarget<T>,
  listener: UpdateListener<T>,
  intervalMs: number,
): () => void {
  let group = groups.get(key) as PollGroup<T> | undefined;
  const firstSubscriber = group === undefined;

  if (!group) {
    group = {
      target,
      listeners: new Set<UpdateListener<T>>(),
      timer: null,
      inFlight: false,
      lastData: null,
      connection: 'connecting',
      stopped: false,
      intervalMs,
    };
    groups.set(key, group as PollGroup<unknown>);
  }

  const active = group;
  active.listeners.add(listener);

  if (firstSubscriber) {
    active.timer = setInterval(() => {
      void runTick(key, active);
    }, active.intervalMs);
    void runTick(key, active);
  } else if (active.stopped) {
    // Observation already reached a terminal snapshot: hand the late
    // subscriber the final state instead of restarting the loop.
    if (active.lastData !== null) {
      listener({
        data: active.lastData,
        changed: false,
        baseline: true,
        connection: 'stopped',
        error: '',
      });
    }
  } else {
    // Catch the new subscriber up immediately when possible; the
    // in-flight guard inside runTick prevents request overlap.
    void runTick(key, active);
  }

  return () => {
    active.listeners.delete(listener);
    if (active.listeners.size === 0) {
      active.stopped = true;
      if (active.timer !== null) {
        clearInterval(active.timer);
        active.timer = null;
      }
      if (groups.get(key) === active) {
        groups.delete(key);
      }
    }
  };
}
