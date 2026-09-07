// TODO: Rewrite the entire message handling system as a stream transformer?

import { DeviceCommunicationError, WebDeviceMuxError } from "./Error.js";

export type DataProvider<TInput> = () => Promise<TInput[] | DeviceCommunicationError>;
export type InputHandler<TInput> = (input: TInput[]) => Promise<IHandlerResponse<TInput>>;
export type InputErrorHandler = (error: DeviceCommunicationError) => Promise<void>;
export interface IHandlerResponse<TInput> {
  remainderData?: TInput[];
}

async function promiseWithTimeoutDefault<T>(
  promise: Promise<T>,
  ms: number,
  resolveDefault: T
): Promise<T> {
  // The timer must be cleared in a finally. This runs on every pass of the read
  // loop, so leaving each one armed for its full duration piles up timers as
  // fast as the loop turns over - enough to exhaust memory on a device that
  // answers quickly.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => { resolve(resolveDefault); }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
  }
}

const listenSentinel = new DeviceCommunicationError('ListenSentinel');

/** How many times a transient read fault is retried before giving up. */
const maxTransientRetries = 3;
const transientRetryDelayMS = 100;

/**
 * Whether a read fault is worth retrying rather than tearing the listener down.
 *
 * A device that is merely not ready right now (a bus reset, a hub
 * renegotiation, a host waking from sleep) will answer the next read. Treating
 * that as fatal is what turns one blip into a printer that never receives
 * again.
 */
function isTransient(error: DeviceCommunicationError): boolean {
  const inner = error.innerException;
  if (inner instanceof DOMException) {
    // NetworkError covers "a transfer error has occurred", which is what a
    // disconnected or renegotiating device produces.
    return inner.name === 'NetworkError';
  }
  return false;
}

export class InputMessageListener<TInput> {
  private _started = false;

  public start() {
    // Two concurrent read loops would race on the same endpoint and interleave
    // their reads, tearing every message frame in half.
    if (this._started || this._disposed) { return; }
    this._started = true;

    // We intentionally want to kick off an async promise here without needing
    // the calling function to be async. The promise we're starting is meant to
    // run forever and never resolve until it's being shut down.
    this.listen()
      .catch((e: unknown) => {
        // listen() is written to never reject, so this is a library bug.
        console.error('Input listener rejected unexpectedly, this is a bug in the WebDeviceMux library.\n', e);
      });
  }

  private async listen(): Promise<void> {
    let aggregate: TInput[] = [];
    let inputPromise: undefined | Promise<TInput[] | DeviceCommunicationError> = undefined;

    while (!this._disposed) {
      let data: TInput[] | DeviceCommunicationError;
      try {
        // Allow resuming awaiting an already-in-progress promise.
        inputPromise ??= this._dataProvider();
        data = await promiseWithTimeoutDefault(inputPromise, 500, listenSentinel);
      } catch (e: unknown) {
        inputPromise = undefined;
        if (await this.handleFault(e)) { continue; }
        return;
      }

      // Printers can idle or otherwise not response for long periods of time.
      // We have a little event loop here, where every 500 milliseconds we
      // can do some housekeeping to see if we should continue waiting or give
      // up entirely.
      if (data === listenSentinel) {
        continue;
      }
      // This indicates we've left our event loop and got a real result.
      inputPromise = undefined;

      if (data instanceof DeviceCommunicationError) {
        if (await this.handleFault(data)) { continue; }
        return;
      }

      if (data.length === 0) {
        // Yield before going round again. A device that resolves transferIn
        // immediately with no bytes would otherwise spin this loop as fast as
        // the microtask queue allows and starve everything else.
        await new Promise(r => setTimeout(r, 0));
        continue;
      }

      // A good read means the device recovered, so the retry budget counts
      // consecutive faults. Without this it is spent over the listener's whole
      // lifetime and a device with one blip an hour eventually stops for good.
      this._retries = 0;

      aggregate.push(...data);
      this.logIfDebug(`Got data from provider, now has ${String(aggregate.length)} items in receive buffer. Data: `, data);

      try {
        // The handler determines if what we got was sufficient, or if we need more.
        const handleResult = await this._inputHandler(aggregate);
        if (handleResult.remainderData !== undefined && handleResult.remainderData.length !== 0) {
          this.logIfDebug(`Input handler provided a ${String(handleResult.remainderData.length)} length incomplete buffer.`);
        }

        // The handler is not required to be stateful, this is instead.
        // The handler may indicate more data is expected by returning incomplete
        // data back. We prefix our buffer with that incomplete data to add more
        // to it and wait again for more.
        aggregate = handleResult.remainderData ?? [];
      } catch (e: unknown) {
        // A handler that throws must not take the read loop down with it.
        // Drop the buffer it choked on and keep listening.
        aggregate = [];
        if (await this.handleFault(e)) { continue; }
        return;
      }
    }
  }

  /**
   * Report a fault and say whether the loop should keep going.
   *
   * Previously any single failure stopped the loop for good while the channel
   * stayed open and reported itself connected. The device then looked healthy
   * but could never receive another byte, so every later operation waited out
   * its full timeout - forever. One transient NetworkError from a bus reset or
   * a sleep/wake cycle was enough to trigger it.
   */
  private async handleFault(e: unknown): Promise<boolean> {
    // Teardown is not a fault. Disposing closes the device, which rejects the
    // in-flight transfer; reporting that would make every clean disconnect
    // look like a failure to the consumer.
    if (this._disposed) { return false; }

    const error = e instanceof DeviceCommunicationError
      ? e
      : (e instanceof WebDeviceMuxError || e instanceof Error)
        ? new DeviceCommunicationError(`Exception thrown listening to input.`, e)
        : new DeviceCommunicationError(`Unknown exception thrown listening to input: ${String(e)}`);

    if (isTransient(error) && this._retries < maxTransientRetries) {
      this._retries++;
      this.logIfDebug(`Transient error from device stream, retrying (${String(this._retries)}/${String(maxTransientRetries)}).`, error);
      await new Promise(r => setTimeout(r, transientRetryDelayMS));
      return true;
    }

    this._disposed = true;
    this.logIfDebug(`Device stream listener stopped listening unexpectedly.`, error);
    await this._errorHandler(error);
    return false;
  }

  private _retries = 0;
  private _disposed = false;
  public dispose() {
    if (this._disposed) { return; }
    this._disposed = true;
  }

  constructor(
    private readonly _dataProvider: DataProvider<TInput>,
    private readonly _inputHandler: InputHandler<TInput>,
    private readonly _errorHandler: InputErrorHandler,
    private readonly _debugLogging = true, // TODO: false
  ) {}

  private logIfDebug(...obj: unknown[]) {
    if (this._debugLogging) {
      console.debug(...obj);
    }
  }
}
