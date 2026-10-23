/** Raised when every slot is busy and the wait queue is full. */
export class QueueFull extends Error {}

/**
 * Counting semaphore: at most `n` tasks run at once and up to `maxQueue` more wait in arrival order.
 * A finishing task hands its slot straight to the next waiter, so a newcomer can never jump the queue.
 * A waiter whose `signal` aborts leaves the queue and rejects with the signal's reason.
 */
export function limiter(n: number, maxQueue = Number.POSITIVE_INFINITY) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (active < n) active++;
    else {
      if (waiting.length >= maxQueue) throw new QueueFull(`${waiting.length} calls are already waiting`);
      await new Promise<void>((resolve, reject) => {
        waiting.push(resolve);
        signal?.addEventListener(
          "abort",
          () => {
            const i = waiting.indexOf(resolve);
            if (i < 0) return; // already started
            waiting.splice(i, 1);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
