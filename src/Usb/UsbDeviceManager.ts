import type { IDeviceCommunicationOptions } from "../Channel.js";
import type { IDevice, IDeviceEvent } from "../Device.js";
import { isManageableDevice } from "./UsbUtilities.js";

export interface IUsbDeviceManagerEventMap<TDevice extends IDevice> {
  connectedDevice: CustomEvent<IDeviceEvent<TDevice>>;
  disconnectedDevice: CustomEvent<IDeviceEvent<TDevice>>;
  /**
   * Fired when a device could not be set up, most often because the operating
   * system would not release it. Without this a failure during a hotplug is an
   * unhandled rejection inside the browser's event dispatch: no event is
   * raised, nothing is tracked, and from the user's point of view the device is
   * plugged in and the page simply does nothing.
   */
  deviceError: CustomEvent<IDeviceErrorEvent>;
}

export interface IDeviceErrorEvent {
  device: USBDevice;
  error: unknown;
}

export interface IUsbDeviceCommunicationOptions extends IDeviceCommunicationOptions {
  /** Connection options for what types of USB devices to pay attention to. */
  requestOptions: USBDeviceRequestOptions;
}

type DeviceGetter<TDevice extends IDevice> = (
  device: USBDevice,
  deviceCommunicationOptions: IUsbDeviceCommunicationOptions
) => Promise<TDevice>;

/** Singleton for handling USB device management.
 *
 * This class can be used to handle the WebUSB communication management for you
 * instead of handling device connections yourself. The promptToConnect method
 * is used to prompt the user to select a device using the browser's UI. Once
 * paired at least once the browser will remember and reconnect automatically.
 *
 * This class exposes events, which your code should add handlers for:
 * * connectedDevice: Fired when a device is ready to be interacted with.
 * * disconnectedDevice: Fired when a device is no longer connected.
 *
 * This class will attempt to manage any USB devices that match the filter you
 * provide in the constructor. If you instantiate it multiple times you must use
 * different USBDeviceFilters, otherwise managers will start managing each other's
 * devices. This will very likely lead to unintended operation.
 */
export class UsbDeviceManager<TDevice extends IDevice> extends EventTarget {
  private usb: USB;

  /** Map of tracked devices to their wrapper objects. */
  private _devices = new Map<USBDevice, TDevice>();
  public get devices() { return [...this._devices.values()]; }

  /**
   * Setups in progress, keyed by device.
   *
   * Registered synchronously so a second connect event for the same device
   * joins the first attempt instead of starting its own. Two concurrent
   * setups would both open and claim the same handle; the loser typically
   * fails, and whichever wins overwrites the map entry, leaving a fully opened
   * channel that nothing references and nothing can dispose.
   */
  private _pending = new Map<USBDevice, Promise<TDevice>>();

  /**
   * Devices that went away, or whose manager was disposed, while their setup
   * was still in flight.
   *
   * Setup takes tens of milliseconds, and both a disconnect and a dispose can
   * land inside that window. Neither could see the device, because it is not
   * in _devices until setup resolves, so the finished channel was tracked and
   * announced as connected on a device that was already gone - open forever,
   * with no further disconnect event coming to clean it up.
   */
  private _abandoned = new Set<USBDevice>();

  private _disposed = false;

  private readonly _onConnect = (e: USBConnectionEvent) => {
    void this.handleConnect(e).catch((error: unknown) => {
      this.sendErrorEvent(e.device, error);
    });
  };
  private readonly _onDisconnect = (e: USBConnectionEvent) => {
    void this.handleDisconnect(e).catch((error: unknown) => {
      this.sendErrorEvent(e.device, error);
    });
  };

  private deviceGetter: DeviceGetter<TDevice>;

  /** Communication behavior when communicating with devices. */
  public deviceCommunicationOptions: IUsbDeviceCommunicationOptions;

  constructor(
    navigatorUsb: USB,
    deviceConstructor: DeviceGetter<TDevice>,
    commOpts?: IUsbDeviceCommunicationOptions
  ) {
    super();
    this.usb = navigatorUsb;
    this.deviceGetter = deviceConstructor;
    this.deviceCommunicationOptions = commOpts ?? {
      debug: true,
      requestOptions: {
        filters: [{
          vendorId: 0x04B8, // Epson
        }]
      }
    };

    // Registered through stable references so dispose() can remove them.
    // Binding inline made them unremovable, so every manager instance retained
    // its navigator.usb listeners and whole device map forever.
    this.usb.addEventListener('connect', this._onConnect);
    this.usb.addEventListener('disconnect', this._onDisconnect);
  }

  public override addEventListener<T extends keyof IUsbDeviceManagerEventMap<TDevice>>(
    type: T,
    listener: EventListenerObject | null | ((this: UsbDeviceManager<TDevice>, ev: IUsbDeviceManagerEventMap<TDevice>[T]) => void),
    options?: boolean | AddEventListenerOptions
  ): void;
  public override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, callback, options);
  }

  public override removeEventListener<T extends keyof IUsbDeviceManagerEventMap<TDevice>>(
    type: T,
    listener: EventListenerObject | null | ((this: UsbDeviceManager<TDevice>, ev: IUsbDeviceManagerEventMap<TDevice>[T]) => void),
    options?: boolean | AddEventListenerOptions
  ): void;
  public override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions  
  ): void {
      super.removeEventListener(type, callback, options);
  }

  /** Ask the user to connect to a device, using the filter from deviceCommunicationOptions. */
  public async promptForNewDevice(): Promise<boolean> {
    try {
      const device = await this.usb.requestDevice(this.deviceCommunicationOptions.requestOptions);
      await this.handleConnect(new USBConnectionEvent('connect', { device }));
    } catch (e) {
      // User cancelled
      if (
        e instanceof DOMException &&
        e.name === 'NotFoundError' &&
        e.message.endsWith('No device selected.')
      ) {
        return false;
      }
      throw e;
    }
    return true;
  }

  /** Disconnect then reconnect all devices */
  public async forceReconnect() {
    const oldList = Array.from(this._devices.values());
    this._devices.clear();
    // allSettled, not all: one device failing to dispose or reconnect must not
    // abandon the rest half-initialized and unreachable, since the map has
    // already been cleared and nothing else holds a reference to them.
    await Promise.allSettled(oldList.map(value => value.dispose()));

    const newDevices = await this.usb.getDevices();
    const results = await Promise.allSettled(
      newDevices.map(d => this.handleConnect(new USBConnectionEvent('connect', { device: d })))
    );
    results.forEach((r, idx) => {
      if (r.status === 'rejected') {
        const device = newDevices[idx];
        if (device !== undefined) { this.sendErrorEvent(device, r.reason); }
      }
    });
  }

  /** Detach this manager's listeners and dispose every device it tracks. */
  public async dispose() {
    this._disposed = true;
    this.usb.removeEventListener('connect', this._onConnect);
    this.usb.removeEventListener('disconnect', this._onDisconnect);
    const devices = Array.from(this._devices.values());
    // Setups still running have to be waited on, not just forgotten. Dropping
    // the reference leaves an open channel that nothing can ever close.
    const pending = Array.from(this._pending.values());
    this._devices.clear();
    this._pending.clear();
    this._abandoned.clear();
    await Promise.allSettled([
      ...devices.map(d => d.dispose()),
      ...pending.map(p => p.then(d => d.dispose(), () => undefined)),
    ]);
  }

  /** Handler for device connection events. */
  public async handleConnect({ device }: USBConnectionEvent): Promise<void> {
    // Make sure it's a device this manager cares about.
    if (!isManageableDevice(device, this.deviceCommunicationOptions.requestOptions)) {
      // Whatever device this is it isn't one we'd be able to ask the user to
      // connect to. We shouldn't attempt to talk to it.
      return;
    }

    // Only handle registration if we aren't already tracking a device
    let dev = this._devices.get(device);
    if (dev === undefined) {
      // Claim the slot synchronously, before the first await, so a concurrent
      // connect event joins this attempt rather than racing it.
      let pending = this._pending.get(device);
      if (pending === undefined) {
        pending = this.deviceGetter(device, this.deviceCommunicationOptions);
        this._pending.set(device, pending);
      }
      try {
        dev = await pending;
      } finally {
        this._pending.delete(device);
      }

      // The device may have been unplugged, or this manager disposed, while
      // the setup above was running. Neither could see it then, so clean up
      // here rather than announcing a device that is already gone.
      if (this._disposed || this._abandoned.delete(device)) {
        await dev.dispose().catch(() => { /* already gone */ });
        return;
      }

      this._devices.set(device, dev);
    }

    // Don't notify that the device exists until it's ready to exist.
    await dev.ready;

    this.sendEvent('connectedDevice', { device: dev });
  }

  /** Handler for device disconnection events. */
  public async handleDisconnect({ device }: USBConnectionEvent): Promise<void> {
    const dev = this._devices.get(device);
    if (dev === undefined) {
      // A setup in flight has nothing to dispose yet. Mark it so the connect
      // path tears it down instead of tracking a device that is already gone;
      // the browser only fires disconnect once, so this is the only chance.
      if (this._pending.has(device)) { this._abandoned.add(device); }
      return;
    }
    this._devices.delete(device);
    // Dispose must not stop the notification. A device that failed to close
    // cleanly is still gone, and swallowing the event here means consumers
    // never learn about the disconnect and leak their own state.
    try {
      await dev.dispose();
    } catch (e) {
      this.sendErrorEvent(device, e);
    }

    this.sendEvent('disconnectedDevice', { device: dev });
  }

  private sendEvent(
    eventName: 'connectedDevice' | 'disconnectedDevice',
    detail: IDeviceEvent<TDevice>
  ): boolean {
    return super.dispatchEvent(new CustomEvent<IDeviceEvent<TDevice>>(eventName, { detail }));
  }

  private sendErrorEvent(device: USBDevice, error: unknown): boolean {
    console.error('Failed to handle a USB device event.', error);
    return super.dispatchEvent(
      new CustomEvent<IDeviceErrorEvent>('deviceError', { detail: { device, error } })
    );
  }
}
