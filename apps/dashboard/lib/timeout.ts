/**
 * Settle with `promise`, or reject with `onTimeout()` once `ms` have passed.
 * The losing promise is not cancelled (an RPC call keeps running), but its
 * outcome is ignored and its rejection stays handled.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * An AbortSignal that fires after `ms` (fetch then rejects with a
 * "TimeoutError"), or undefined where the browser lacks AbortSignal.timeout.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** True for the error fetch rejects with when a `timeoutSignal` fires. */
export function isTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError";
}
