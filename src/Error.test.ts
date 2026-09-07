import { expect, describe, it } from 'vitest';
import {
  WebDeviceMuxError,
  DeviceConnectionError,
  DeviceCommunicationError,
  DeviceNotReadyError,
} from './Error.js';

describe('error names', () => {
  // The base class sets a hardcoded name so a minifier cannot rewrite it.
  // Without a per-subclass override every error reports the base name, which
  // breaks the err.name matching the hardcoding exists to protect.
  it.each([
    [new WebDeviceMuxError('x'), 'WebDeviceMuxError'],
    [new DeviceConnectionError('x'), 'DeviceConnectionError'],
    [new DeviceCommunicationError('x'), 'DeviceCommunicationError'],
    [new DeviceNotReadyError('x'), 'DeviceNotReadyError'],
  ])('reports its own class name', (error, expected) => {
    expect(error.name).toBe(expected);
  });

  it('forwards the inner exception through the subclass chain', () => {
    const inner = new Error('root cause');

    expect(new DeviceNotReadyError('x', inner).innerException).toBe(inner);
    expect(new DeviceCommunicationError('x', inner).innerException).toBe(inner);
    expect(new DeviceConnectionError('x', inner).innerException).toBe(inner);
  });
});
