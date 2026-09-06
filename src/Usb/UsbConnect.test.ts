import { it, expect, describe, vi } from 'vitest';
import { DriverAccessDeniedError, UsbDeviceChannel } from './UsbDeviceChannel.js';
import { DeviceCommunicationError } from '../Error.js';

interface FakeOptions {
  /** configurationValue reported by the device's single configuration. */
  configurationValue?: number;
  /** interfaceNumber of the interface that carries the bulk endpoints. */
  interfaceNumber?: number;
  /** Extra interfaces placed BEFORE the bulk one, with no endpoints. */
  decoyInterfaces?: number;
  claimInterfaceError?: DOMException;
  selectConfigurationError?: DOMException;
  closeError?: Error;
  outStatus?: USBTransferStatus;
  bytesWritten?: number;
  outPacketSize?: number;
}

/**
 * A USB device whose configurationValue and interfaceNumber are deliberately
 * NOT the array indices, which is the normal shape for composite devices.
 */
function fakeDevice(opts: FakeOptions = {}) {
  const {
    configurationValue = 3,
    interfaceNumber = 2,
    decoyInterfaces = 1,
    outPacketSize = 64,
  } = opts;

  const calls = {
    selectedConfiguration: [] as number[],
    claimedInterfaces: [] as number[],
    transfersOut: [] as { endpoint: number, length: number }[],
    clearedHalts: [] as USBDirection[],
    closed: 0,
  };

  const bulk = {
    interfaceName: 'bulk',
    alternateSetting: 0,
    interfaceClass: 7,
    interfaceProtocol: 2,
    interfaceSubclass: 1,
    endpoints: [
      { direction: 'in', endpointNumber: 5, packetSize: 64, type: 'bulk' },
      { direction: 'out', endpointNumber: 6, packetSize: outPacketSize, type: 'bulk' },
    ],
  };
  const decoy = { ...bulk, interfaceName: 'decoy', endpoints: [] };

  const interfaces = [
    ...Array.from({ length: decoyInterfaces }, (_, idx) => ({
      alternate: decoy, claimed: false, interfaceNumber: idx, alternates: [decoy],
    })),
    { alternate: bulk, claimed: false, interfaceNumber, alternates: [bulk] },
  ];

  const state = { opened: false };

  const dev = {
    manufacturerName: 'Test', productName: 'Printer', serialNumber: '1',
    configuration: null,
    usbVersionMajor: 2, usbVersionMinor: 0, usbVersionSubminor: 0,
    deviceClass: 0, deviceSubclass: 0, deviceProtocol: 0,
    vendorId: 0x04b8, productId: 0x0202,
    deviceVersionMajor: 1, deviceVersionMinor: 0, deviceVersionSubminor: 0,
    configurations: [{ configurationName: 'cfg', configurationValue, interfaces }],
    get opened() { return state.opened; },
    open: () => { state.opened = true; return Promise.resolve(); },
    close: () => {
      calls.closed++;
      if (opts.closeError) { return Promise.reject(opts.closeError); }
      state.opened = false;
      return Promise.resolve();
    },
    forget: () => Promise.resolve(),
    selectConfiguration: (value: number) => {
      if (opts.selectConfigurationError) { return Promise.reject(opts.selectConfigurationError); }
      // A real device rejects a value that isn't one of its configurations.
      if (value !== configurationValue) {
        return Promise.reject(new DOMException('The configuration value is invalid.', 'NotFoundError'));
      }
      calls.selectedConfiguration.push(value);
      return Promise.resolve();
    },
    claimInterface: (num: number) => {
      if (opts.claimInterfaceError) { return Promise.reject(opts.claimInterfaceError); }
      // A real device rejects an interfaceNumber it does not have.
      if (!interfaces.some(i => i.interfaceNumber === num)) {
        return Promise.reject(new DOMException('The interface number is invalid.', 'NotFoundError'));
      }
      calls.claimedInterfaces.push(num);
      return Promise.resolve();
    },
    releaseInterface: () => Promise.resolve(),
    selectAlternateInterface: () => Promise.resolve(),
    controlTransferIn: () => Promise.reject(new Error('not implemented')),
    controlTransferOut: () => Promise.reject(new Error('not implemented')),
    clearHalt: (direction: USBDirection) => {
      calls.clearedHalts.push(direction);
      return Promise.resolve();
    },
    transferIn: () => Promise.resolve({ status: 'ok', data: undefined }),
    transferOut: (endpoint: number, data: BufferSource) => {
      calls.transfersOut.push({ endpoint, length: data.byteLength });
      return Promise.resolve({
        status: opts.outStatus ?? 'ok',
        bytesWritten: opts.bytesWritten ?? data.byteLength,
      });
    },
    isochronousTransferIn: () => Promise.reject(new Error('not implemented')),
    isochronousTransferOut: () => Promise.reject(new Error('not implemented')),
    reset: () => Promise.resolve(),
  } as unknown as USBDevice;

  return { dev, calls };
}

describe('connectDevice addressing', () => {
  it('selects by configurationValue, not array index', async () => {
    // selectConfiguration takes a configurationValue. Passing a hardcoded 1
    // rejects outright on any device whose configuration is numbered
    // differently.
    const { dev, calls } = fakeDevice({ configurationValue: 3 });

    await UsbDeviceChannel.fromDevice(dev, { debug: false });

    expect(calls.selectedConfiguration).toStrictEqual([3]);
  });

  it('claims by interfaceNumber, not array index', async () => {
    // claimInterface takes an interfaceNumber. On a composite device - the
    // usual shape for a printer bound to WinUSB on Windows - the bulk
    // interface is not number 0, so a hardcoded 0 claims the wrong interface.
    const { dev, calls } = fakeDevice({ interfaceNumber: 2, decoyInterfaces: 1 });

    await UsbDeviceChannel.fromDevice(dev, { debug: false });

    expect(calls.claimedInterfaces).toStrictEqual([2]);
  });

  it('reads endpoints from the interface it actually claimed', async () => {
    // Claiming one interface and then transferring on another's endpoints
    // makes every transfer fail with "endpoint not part of a claimed
    // interface".
    const { dev } = fakeDevice({ interfaceNumber: 2, decoyInterfaces: 2 });

    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    expect(channel['deviceIn']?.endpointNumber).toBe(5);
    expect(channel['deviceOut']?.endpointNumber).toBe(6);
  });

  it('skips interfaces that expose no endpoints', async () => {
    const { dev, calls } = fakeDevice({ interfaceNumber: 7, decoyInterfaces: 3 });

    await UsbDeviceChannel.fromDevice(dev, { debug: false });

    expect(calls.claimedInterfaces).toStrictEqual([7]);
  });
});

describe('connectDevice driver conflicts', () => {
  it('maps a claimInterface SecurityError to DriverAccessDeniedError', async () => {
    // On Windows the device usually opens fine and it is the claim that the OS
    // refuses, because usbprint.sys already owns the interface. Only open()
    // was mapped, so this surfaced as a bare DOMException instead of the
    // actionable "replace the driver" guidance.
    const { dev } = fakeDevice({
      claimInterfaceError: new DOMException('Access denied.', 'SecurityError'),
    });

    await expect(UsbDeviceChannel.fromDevice(dev, { debug: false }))
      .rejects.toThrow(DriverAccessDeniedError);
  });

  it('maps a claimInterface NetworkError to DriverAccessDeniedError', async () => {
    const { dev } = fakeDevice({
      claimInterfaceError: new DOMException('Unable to claim interface.', 'NetworkError'),
    });

    await expect(UsbDeviceChannel.fromDevice(dev, { debug: false }))
      .rejects.toThrow(DriverAccessDeniedError);
  });

  it('does not let a close failure mask the real connection error', async () => {
    // setup() disposes on failure. If dispose throws, the close error replaces
    // the claim error - destroying the diagnosis in exactly the Windows case
    // the DriverAccessDeniedError message exists to explain.
    const { dev } = fakeDevice({
      claimInterfaceError: new DOMException('Access denied.', 'SecurityError'),
      closeError: new Error('close blew up'),
    });

    await expect(UsbDeviceChannel.fromDevice(dev, { debug: false }))
      .rejects.toThrow(DriverAccessDeniedError);
  });

  it('reports a device with no configurations rather than throwing raw', async () => {
    const { dev } = fakeDevice();
    (dev as { configurations: USBConfiguration[] }).configurations = [];

    await expect(UsbDeviceChannel.fromDevice(dev, { debug: false }))
      .rejects.toThrow(DeviceCommunicationError);
  });
});

describe('UsbDeviceChannel.dispose', () => {
  it('does not throw when close fails', async () => {
    const { dev } = fakeDevice({ closeError: new Error('nope') });
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    await expect(channel.dispose()).resolves.toBeUndefined();
  });

  it('is idempotent', async () => {
    const { dev, calls } = fakeDevice();
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    await channel.dispose();
    await channel.dispose();

    expect(calls.closed).toBe(1);
  });
});

describe('UsbDeviceChannel.send', () => {
  it('reports a stalled write instead of returning success', async () => {
    // The transfer result was discarded entirely, so a stall silently swallowed
    // the job and the caller then waited out its full timeout for a reply that
    // could never come.
    const { dev, calls } = fakeDevice({ outStatus: 'stall' });
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    const result = await channel.send(new Uint8Array([1, 2, 3]));

    expect(result).toBeInstanceOf(DeviceCommunicationError);
    expect(calls.clearedHalts).toContain('out');
  });

  it('reports a short write', async () => {
    const { dev } = fakeDevice({ bytesWritten: 1 });
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    const result = await channel.send(new Uint8Array([1, 2, 3]));

    expect(result).toBeInstanceOf(DeviceCommunicationError);
  });

  it('terminates a packet-sized transfer with a zero length packet', async () => {
    // A bulk transfer that is an exact multiple of the endpoint packet size
    // leaves the device waiting for more, so the job hangs until the device
    // times out on its own.
    const { dev, calls } = fakeDevice({ outPacketSize: 8 });
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    expect(await channel.send(new Uint8Array(16))).toBeUndefined();

    expect(calls.transfersOut.map(t => t.length)).toStrictEqual([16, 0]);
  });

  it('does not add a zero length packet to a short transfer', async () => {
    const { dev, calls } = fakeDevice({ outPacketSize: 8 });
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    expect(await channel.send(new Uint8Array(12))).toBeUndefined();

    expect(calls.transfersOut.map(t => t.length)).toStrictEqual([12]);
  });

  it('sends on the claimed interface endpoint', async () => {
    const { dev, calls } = fakeDevice({ outPacketSize: 64 });
    const channel = await UsbDeviceChannel.fromDevice(dev, { debug: false });

    await channel.send(new Uint8Array([1]));

    expect(calls.transfersOut[0]?.endpoint).toBe(6);
  });
});

describe('getTransferLength', () => {
  it('never asks for a zero length read', async () => {
    // 1024 * floor(512 / 1024) is 0, and transferIn(endpoint, 0) reads nothing
    // forever. Reachable on any high-speed 1024-byte bulk IN endpoint when the
    // caller sets a smaller maxReceivePacketSize.
    const { dev } = fakeDevice();
    const spy = vi.spyOn(dev, 'transferIn');
    const channel = await UsbDeviceChannel.fromDevice(
      dev, { debug: false, maxReceivePacketSize: 512 });
    // Force the endpoint to look like a high-speed one.
    (channel['deviceIn'] as { packetSize: number }).packetSize = 1024;

    await channel.receive();

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[1]).toBeGreaterThan(0);
  });
});
