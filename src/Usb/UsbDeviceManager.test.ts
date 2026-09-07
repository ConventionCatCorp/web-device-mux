import { it, expect, describe, vi } from 'vitest';
import { UsbDeviceManager } from './UsbDeviceManager.js';
import type { IDevice } from '../Device.js';

/** A navigator.usb stand-in that lets a test fire connect/disconnect. */
function fakeUsb(devices: USBDevice[] = []) {
  const target = new EventTarget();
  const usb = Object.assign(target, {
    getDevices: () => Promise.resolve(devices),
    requestDevice: () => Promise.reject(new Error('not implemented')),
  }) as unknown as USB;
  const fire = (type: 'connect' | 'disconnect', device: USBDevice) => {
    target.dispatchEvent(Object.assign(new Event(type), { device }));
  };
  return { usb, fire };
}

const fakeDevice = (vendorId = 0x04b8) =>
  ({ vendorId, productId: 0x0202 }) as unknown as USBDevice;

function trackedDevice() {
  const dispose = vi.fn(() => Promise.resolve());
  return { dispose, ready: Promise.resolve() } as unknown as IDevice & {
    dispose: ReturnType<typeof vi.fn>;
  };
}

const opts = {
  debug: false,
  requestOptions: { filters: [{ vendorId: 0x04b8 }] },
};

describe('UsbDeviceManager', () => {
  it('reports a setup failure through deviceError instead of rejecting silently', async () => {
    const { usb } = fakeUsb();
    const failure = new Error('OS would not release the device');
    const mgr = new UsbDeviceManager<IDevice>(
      usb, () => Promise.reject(failure), opts);
    const onError = vi.fn();
    const onConnect = vi.fn();
    mgr.addEventListener('deviceError', onError);
    mgr.addEventListener('connectedDevice', onConnect);

    await expect(mgr.handleConnect(
      { device: fakeDevice() } as USBConnectionEvent)).rejects.toThrow(failure);

    expect(onConnect).not.toHaveBeenCalled();
    expect(mgr.devices).toHaveLength(0);
  });

  it('joins a concurrent connect for the same device rather than setting it up twice', async () => {
    const { usb } = fakeUsb();
    const device = fakeDevice();
    const getter = vi.fn(() => Promise.resolve(trackedDevice()));
    const mgr = new UsbDeviceManager<IDevice>(usb, getter, opts);

    // Both dispatched before either awaits, which is what a doubled hotplug
    // event does. Two setups would each open and claim the same handle.
    await Promise.all([
      mgr.handleConnect({ device } as USBConnectionEvent),
      mgr.handleConnect({ device } as USBConnectionEvent),
    ]);

    expect(getter).toHaveBeenCalledTimes(1);
    expect(mgr.devices).toHaveLength(1);
  });

  it('disposes a device unplugged while its setup was still running', async () => {
    const { usb } = fakeUsb();
    const device = fakeDevice();
    const dev = trackedDevice();
    let finishSetup!: () => void;
    const getter = () => new Promise<IDevice>(resolve => {
      finishSetup = () => { resolve(dev); };
    });
    const mgr = new UsbDeviceManager<IDevice>(usb, getter, opts);
    const onConnect = vi.fn();
    mgr.addEventListener('connectedDevice', onConnect);

    const connecting = mgr.handleConnect({ device } as USBConnectionEvent);
    // The cable is pulled mid-setup. The device is not in _devices yet, so the
    // disconnect handler cannot see it, and the browser fires disconnect once.
    await mgr.handleDisconnect({ device } as USBConnectionEvent);
    finishSetup();
    await connecting;

    expect(dev.dispose.mock.calls.length).toBeGreaterThan(0);
    expect(mgr.devices).toHaveLength(0);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('does not track a device whose setup finished after dispose', async () => {
    const { usb } = fakeUsb();
    const dev = trackedDevice();
    let finishSetup!: () => void;
    const mgr = new UsbDeviceManager<IDevice>(
      usb,
      () => new Promise<IDevice>(resolve => { finishSetup = () => { resolve(dev); }; }),
      opts);
    const onConnect = vi.fn();
    mgr.addEventListener('connectedDevice', onConnect);

    const connecting = mgr.handleConnect({ device: fakeDevice() } as USBConnectionEvent);
    const disposing = mgr.dispose();
    finishSetup();
    await Promise.all([connecting, disposing]);

    expect(dev.dispose.mock.calls.length).toBeGreaterThan(0);
    expect(mgr.devices).toHaveLength(0);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('still reports a disconnect when the device fails to dispose cleanly', async () => {
    const { usb } = fakeUsb();
    const device = fakeDevice();
    const dev = {
      ready: Promise.resolve(),
      dispose: vi.fn(() => Promise.reject(new Error('close failed'))),
    } as unknown as IDevice;
    const mgr = new UsbDeviceManager<IDevice>(usb, () => Promise.resolve(dev), opts);
    const onDisconnect = vi.fn();
    mgr.addEventListener('disconnectedDevice', onDisconnect);

    await mgr.handleConnect({ device } as USBConnectionEvent);
    await mgr.handleDisconnect({ device } as USBConnectionEvent);

    // A device that failed to close is still gone; swallowing the event would
    // leave the consumer holding state for a device that no longer exists.
    expect(onDisconnect).toHaveBeenCalled();
    expect(mgr.devices).toHaveLength(0);
  });

  it('ignores a device that does not match its filters', async () => {
    const { usb } = fakeUsb();
    const getter = vi.fn(() => Promise.resolve(trackedDevice()));
    const mgr = new UsbDeviceManager<IDevice>(usb, getter, opts);

    await mgr.handleConnect({ device: fakeDevice(0x1234) } as USBConnectionEvent);

    expect(getter).not.toHaveBeenCalled();
  });
});
