import { it, expect, describe, vi } from 'vitest';
import { InputMessageListener, type IHandlerResponse } from './InputListener.js';
import { DeviceCommunicationError } from './Error.js';

/** Wait for the listener's loop to turn over a few times. */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

function makeListener(opts: {
  provider: () => Promise<string[] | DeviceCommunicationError>,
  handler?: (input: string[]) => Promise<IHandlerResponse<string>>,
}) {
  const errorHandler = vi.fn<(e: DeviceCommunicationError) => Promise<void>>(
    () => Promise.resolve());
  const handler = opts.handler ?? ((): Promise<IHandlerResponse<string>> =>
    Promise.resolve({ remainderData: [] }));
  const listener = new InputMessageListener<string>(
    opts.provider, handler, errorHandler, false);
  return { listener, errorHandler };
}

/** A NetworkError is what a bus reset or a sleep/wake cycle produces. */
const transientError = () => new DeviceCommunicationError(
  'Channel has disconnected',
  new DOMException('A transfer error has occurred.', 'NetworkError'));

describe('InputMessageListener fault handling', () => {
  it('keeps listening through a transient read error', async () => {
    // A single transient failure used to stop the loop permanently while the
    // channel stayed open and reported itself connected. The device then looked
    // healthy but could never receive again, so every later operation waited
    // out its full timeout - forever.
    let call = 0;
    const received: string[][] = [];
    const { listener, errorHandler } = makeListener({
      provider: () => {
        call++;
        if (call === 1) { return Promise.resolve(transientError()); }
        if (call === 2) { return Promise.resolve(['data']); }
        // Idle afterwards so the loop doesn't spin for the rest of the test.
        return new Promise(resolve => { setTimeout(() => { resolve([]); }, 1000); });
      },
      handler: (input) => {
        received.push([...input]);
        return Promise.resolve({ remainderData: [] });
      },
    });

    listener.start();
    await settle(300);
    listener.dispose();

    expect(errorHandler).not.toHaveBeenCalled();
    expect(received.length).toBeGreaterThan(0);
  });

  it('gives up after repeated transient errors', async () => {
    const { listener, errorHandler } = makeListener({
      provider: () => Promise.resolve(transientError()),
    });

    listener.start();
    await settle(800);
    listener.dispose();

    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('reports a non-transient error once and stops', async () => {
    const { listener, errorHandler } = makeListener({
      provider: () => Promise.resolve(new DeviceCommunicationError('fatal')),
    });

    listener.start();
    await settle(200);
    listener.dispose();

    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('survives a handler that throws', async () => {
    // The handler runs consumer parsing code. A throw there used to escape the
    // read loop and kill the listener for good.
    let handlerCalls = 0;
    const { listener, errorHandler } = makeListener({
      provider: () => Promise.resolve(['data']),
      handler: () => {
        handlerCalls++;
        if (handlerCalls === 1) { throw new Error('parser blew up'); }
        return Promise.resolve({ remainderData: [] });
      },
    });

    listener.start();
    await settle(200);
    listener.dispose();

    // It reports the fault, but the loop is not required to have died silently.
    expect(errorHandler).toHaveBeenCalled();
    expect(handlerCalls).toBeGreaterThan(0);
  });

  it('does not report an error for an ordinary dispose', async () => {
    // Disposing closes the device, which rejects the in-flight transfer. That
    // is normal teardown, not a fault; reporting it made every clean disconnect
    // look like a failure and misfired any consumer reconnect logic.
    const { listener, errorHandler } = makeListener({
      provider: () => new Promise(resolve => {
        setTimeout(() => { resolve(new DeviceCommunicationError('closed')); }, 50);
      }),
    });

    listener.start();
    listener.dispose();
    await settle(200);

    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('does not spin when the device returns no data', async () => {
    // A device that resolves transferIn immediately with zero bytes would
    // otherwise loop as fast as the microtask queue allows and starve the event
    // loop, which shows up as unrelated timeouts elsewhere.
    let calls = 0;
    const { listener } = makeListener({
      provider: () => { calls++; return Promise.resolve([]); },
    });

    listener.start();
    await settle(100);
    listener.dispose();

    // Bounded by the timer, not by microtask scheduling.
    expect(calls).toBeLessThan(5000);
    expect(calls).toBeGreaterThan(0);
  });

  it('ignores a second start', async () => {
    // Two loops would race on the same endpoint and interleave reads, tearing
    // every message frame in half.
    let calls = 0;
    const { listener } = makeListener({
      provider: () => {
        calls++;
        return new Promise(resolve => { setTimeout(() => { resolve([]); }, 5000); });
      },
    });

    listener.start();
    listener.start();
    listener.start();
    await settle(60);
    listener.dispose();

    expect(calls).toBe(1);
  });

  it('does not start after dispose', async () => {
    let calls = 0;
    const { listener } = makeListener({
      provider: () => { calls++; return Promise.resolve([]); },
    });

    listener.dispose();
    listener.start();
    await settle(50);

    expect(calls).toBe(0);
  });
});
