import { ConnectionDirectionMode, type IDeviceChannel, type IDeviceCommunicationOptions } from "../Channel.js";
import type { IDeviceInformation } from "../Device.js";
import { DeviceCommunicationError, DeviceNotReadyError } from "../Error.js";

/** Device information extended with USB information. */
export interface IUSBDeviceInformation extends IDeviceInformation {
  readonly deviceClass: number;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceVersionMajor: number;
  readonly deviceVersionMinor: number;
  readonly deviceVersionSubminor: number;
}

/** Convert a USBDevice object to an IUSBDeviceInformation object. */
function deviceToInfo(device: USBDevice): IUSBDeviceInformation {
  return {
    deviceClass          : device.deviceClass,
    deviceProtocol       : device.deviceProtocol,
    deviceSubclass       : device.deviceSubclass,
    deviceVersionMajor   : device.deviceVersionMajor,
    deviceVersionMinor   : device.deviceVersionMinor,
    deviceVersionSubminor: device.deviceVersionSubminor,
    productId            : device.productId,
    vendorId             : device.vendorId,
    manufacturerName     : device.manufacturerName ?? undefined,
    productName          : device.productName ?? undefined,
    serialNumber         : device.serialNumber ?? undefined,
  };
}

function getTransferLength(
  maxRecieve?: number,
  devicePacket?: number,
) {
  // Math is hard, let's go shopping
  const defaultMax = 4096;
  if (maxRecieve === undefined && devicePacket === 64) {
    return defaultMax;
  }

  let maxPacket = maxRecieve ?? defaultMax;
  maxPacket = maxPacket > 0 ? maxPacket : defaultMax;

  let devicePacketSize = devicePacket ?? 64;
  devicePacketSize = devicePacketSize > 0 ? devicePacketSize : 64;

  // Never round down to zero. A device with a 1024-byte high-speed bulk IN
  // endpoint plus a caller-supplied maxReceivePacketSize below that would
  // otherwise produce transferIn(endpoint, 0), which reads nothing forever.
  return Math.max(devicePacketSize, devicePacketSize * Math.floor(maxPacket / devicePacketSize));
}

if (import.meta.vitest) {
  const { it, expect, describe } = import.meta.vitest

  describe('deviceToInfo', () => {
    it('Translates all values', () => {
      const dev = {
        deviceClass          : 1,
        deviceProtocol       : 2,
        deviceSubclass       : 3,
        deviceVersionMajor   : 4,
        deviceVersionMinor   : 5,
        deviceVersionSubminor: 6,
        productId            : 7,
        vendorId             : 8,
        manufacturerName     : 'man',
        productName          : 'name',
        serialNumber         : 'ser',
      } as unknown as USBDevice;
      expect(deviceToInfo(dev)).toEqual(dev);
    });
  });
}

/** Class for managing the WebUSB communication with a device. */
export class UsbDeviceChannel implements IDeviceChannel<Uint8Array, Uint8Array> {
  private device: USBDevice;
  private deviceIn?: USBEndpoint | undefined;
  private deviceOut?: USBEndpoint | undefined;

  private _commOptions: IDeviceCommunicationOptions;

  public readonly channelType = "USB" as const;

  private _commMode = ConnectionDirectionMode.none;
  public get commMode() { return this._commMode; }

  public get connected() {
    return !this._disposed && this.device.opened;
  }

  private _disposed = false;

  static async fromDevice(
    device: USBDevice,
    options: IDeviceCommunicationOptions = { debug: false },
  ): Promise<UsbDeviceChannel> {
    const c = new UsbDeviceChannel(device, options);
    await c.setup();
    return c;
  }

  protected constructor(
    device: USBDevice,
    commOptions: IDeviceCommunicationOptions
  ) {
    this.device = device;
    this._commOptions = commOptions;
  }

  private async setup() {
    try {
      const { input, output } = await connectDevice(this.device);

      this.deviceIn = input;
      this.deviceOut = output;
      this._commMode = getCommMode(this.deviceOut !== undefined, this.deviceIn !== undefined);
      if (this._commOptions.debug) {
        console.debug('Comm mode with device is', ConnectionDirectionMode[this._commMode]);
      }
    } catch (e) {
      await this.dispose();
      throw e;
    }
  }

  public async dispose() {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Disposal must not throw. It runs from three places that cannot handle a
    // rejection: setup()'s failure path, where a close error would REPLACE the
    // real diagnosis (exactly the driver-conflict case on Windows); the device
    // manager's disconnect handler, where a throw means the disconnect event
    // never fires and the rejection is unhandled; and consumer teardown.
    try {
      await this.device.close();
    } catch (e) {
      // Matching on the exact English message text is fragile across browser
      // versions and locales, so treat any close failure as best-effort.
      if (this._commOptions.debug) {
        console.debug('Ignoring error while closing the USB device.', e);
      }
    }
  }

  public async send(
    commandBuffer: Uint8Array
  ): Promise<DeviceNotReadyError | undefined> {
    if (this.deviceOut === undefined || !this.connected) {
      return new DeviceNotReadyError();
    }

    if (this._commOptions.debug) {
      console.debug('Sending command buffer to device via USB.');
      console.time('commandBufferSendTime');
    }

    try {
      // TOOD: Add timeout in case of communication hang.
      // transferOut wants a view over a plain ArrayBuffer. A Uint8Array is
      // typed as possibly backed by a SharedArrayBuffer, which WebUSB rejects
      // at runtime anyway, so narrowing here rather than copying every send.
      const outBuffer = commandBuffer as Uint8Array<ArrayBuffer>;
      const result = await this.device.transferOut(this.deviceOut.endpointNumber, outBuffer);

      // The result was previously ignored entirely, so a stalled endpoint or a
      // short write silently swallowed the job and the caller then waited out
      // its full timeout for a reply that could never come.
      if (result.status === 'stall') {
        await this.device.clearHalt('out', this.deviceOut.endpointNumber)
          .catch(() => { /* the device is likely gone; the error below says so */ });
        return new DeviceCommunicationError(
          `USB device gave 'stall' error while sending data. The endpoint has been reset, but the data was not delivered.`
        );
      }
      if (result.status === 'babble') {
        return new DeviceCommunicationError(
          `USB device gave 'babble' error while sending data. The data was not delivered.`
        );
      }
      if (result.bytesWritten !== commandBuffer.byteLength) {
        return new DeviceCommunicationError(
          `USB device accepted only ${String(result.bytesWritten)} of ${String(commandBuffer.byteLength)} bytes.`
        );
      }

      // A bulk transfer whose length is an exact multiple of the endpoint's
      // packet size needs a zero length packet to mark the end, otherwise many
      // devices keep waiting for more and the job hangs until they time out.
      const packetSize = this.deviceOut.packetSize;
      if (packetSize > 0
        && commandBuffer.byteLength > 0
        && commandBuffer.byteLength % packetSize === 0
      ) {
        await this.device.transferOut(this.deviceOut.endpointNumber, new Uint8Array(0));
      }
      return;
    } catch (e: unknown) {
      if (typeof e === 'string') {
        return new DeviceCommunicationError(e);
      }
      if (e instanceof Error ) {
        return new DeviceCommunicationError(undefined, e);
      }
      // Dunno what this is but we can't wrap it.
      throw e;
    } finally {
      if (this._commOptions.debug) {
        console.timeEnd('commandBufferSendTime');
        console.debug('Completed sending commands.');
      }
    }
  }

  public getDeviceInfo() {
    return Promise.resolve(deviceToInfo(this.device));
  }

  public async receive(): Promise<Uint8Array[] | DeviceNotReadyError> {
    if (this.deviceIn === undefined || !this.connected) { return new DeviceNotReadyError('Channel is not connected.'); }

    const result = await this.device.transferIn(
      this.deviceIn.endpointNumber,
      getTransferLength(
        this._commOptions.maxReceivePacketSize,
        this.deviceIn?.packetSize,
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof DOMException
        && error.message.endsWith('A transfer error has occurred.')
        && error.name === 'NetworkError'
      ){
        // The device disconnected, this is fine.
        return new DeviceNotReadyError('Channel has disconnected');
      }
      // dunno what happened
      throw error;
    });

    if (result instanceof DeviceNotReadyError) {
      return result;
    }

    // Sanity tests
    if (result.status === "stall") {
      // TODO: Way better error handling if this is encountered...
      console.error(`USB device gave 'stall' error on receipt of data. Automatically resetting the connection to try again. This may indicate a problem with the device.`);
      // Must be awaited. Left floating, the retry is issued before the halt is
      // actually cleared so the stall just repeats, and a rejection here (which
      // does happen once the device is gone) becomes an unhandled rejection.
      await this.device.clearHalt("in", this.deviceIn.endpointNumber)
        .catch((e: unknown) => {
          console.error('Failed to clear the halt on the USB input endpoint.', e);
        });
      // Whatever came back with the stall is not trustworthy data.
      return [];
    }
    if (result.status === "babble") {
      console.error(`USB device gave 'babble' error on receipt of data. Response data was likely lost. This may indicate an issue with the device or the way this library tries to communicate to the device.`);
      // The transfer overran, so what we have is a torn frame. Handing it up
      // would desynchronize whatever is parsing this stream.
      return [];
    }
    if (result.data === undefined || result.data.byteLength === 0) { return []; }

    // Copy rather than aliasing the transfer buffer, which the user agent is
    // free to reuse once this transfer is done with.
    return [new Uint8Array(
      result.data.buffer.slice(
        result.data.byteOffset,
        result.data.byteOffset + result.data.byteLength))];
  }
}

/**
 * Run one of the connection steps, mapping an OS-level refusal to the
 * actionable DriverAccessDeniedError.
 *
 * The driver-conflict case is NOT limited to open(). On Windows the device
 * usually opens fine and the refusal comes from selectConfiguration or
 * claimInterface, because usbprint.sys or a vendor driver already owns the
 * interface. Chrome reports that as SecurityError ("Access denied") or
 * NetworkError ("Unable to claim interface"), so without this the caller gets
 * a bare DOMException instead of the "replace the driver" guidance.
 */
async function claimStep(step: () => Promise<void>, description: string) {
  try {
    await step();
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'NetworkError')) {
      throw new DriverAccessDeniedError();
    }
    if (e instanceof DOMException) {
      throw new DeviceCommunicationError(
        `Failed to ${description} the USB device: ${e.name}: ${e.message}`,
        e
      );
    }
    throw e;
  }
}

async function connectDevice(d: USBDevice) {
  // Most devices have two endpoints on one interface for bidirectional bulk
  // in and out. The more poorly performing a device the more random this
  // layout will be, so we must go and look for these two endpoints.
  if (d.configurations.length === 0) {
    // Can't talk to the device at all???
    throw new DeviceCommunicationError(
      'USB device did not expose an endpoint to communicate with. Try power-cycling the device, or checking its settings. This is a hardware problem.'
    );
  }

  // Open the connection! Stop having it be closed!
  try {
    await d.open();
  } catch (e) {
    if (
      e instanceof DOMException &&
      e.name === 'SecurityError' &&
      e.message === "Failed to execute 'open' on 'USBDevice': Access denied."
    ) {
      // This can happen if something else, usually the operating system, has taken
      // exclusive access of the USB device and won't allow WebUSB to take control.
      // This most often happens on Windows. You can use Zadig to replace the driver.
      throw new DriverAccessDeniedError();
    }

    throw e;
  }

  // selectConfiguration takes a configurationValue and claimInterface takes an
  // interfaceNumber. Neither is an array index, so hardcoding 1 and 0 and then
  // reading endpoints out of configurations[0].interfaces[0] mixes two
  // different addressing spaces. On a device whose sole configuration has a
  // configurationValue other than 1, selectConfiguration rejects outright; on a
  // composite device whose bulk interface is not interfaceNumber 0 - very
  // common for printers bound to WinUSB on Windows - it claims one interface
  // and then transfers on another's endpoints, so every transferOut fails with
  // "endpoint not part of a claimed interface".
  const configuration = d.configuration ?? d.configurations[0];
  if (configuration === undefined) {
    throw new DeviceCommunicationError(
      'USB device did not expose a configuration to communicate with. Try power-cycling the device. This is a hardware problem.'
    );
  }
  if (d.configuration?.configurationValue !== configuration.configurationValue) {
    await claimStep(
      () => d.selectConfiguration(configuration.configurationValue),
      'select the configuration on'
    );
  }

  // Pick the interface that actually exposes a bulk output endpoint rather than
  // assuming it is the first one.
  const candidates = configuration.interfaces
    .map(iface => ({ iface, alternate: iface.alternates[0] }))
    .filter((c): c is { iface: USBInterface, alternate: USBAlternateInterface } =>
      c.alternate !== undefined);
  const chosen =
    candidates.find(c => c.alternate.endpoints.some(e => e.direction === 'out'))
    ?? candidates[0];

  if (chosen === undefined) {
    throw new DeviceCommunicationError(
      'USB device did not expose an endpoint to communicate with. Try power-cycling the device, or checking its settings. This is a hardware problem.'
    );
  }

  if (!chosen.iface.claimed) {
    await claimStep(
      () => d.claimInterface(chosen.iface.interfaceNumber),
      'claim the interface on'
    );
  }

  // Read the endpoints from the alternate that is actually active after the
  // claim, falling back to the one we picked from the descriptor.
  const endpoints = (chosen.iface.alternate as USBAlternateInterface | undefined)?.endpoints
    ?? chosen.alternate.endpoints;

  let o: USBEndpoint | undefined = undefined;
  let i: USBEndpoint | undefined = undefined;
  for (const endpoint of endpoints) {
    if (endpoint.direction == 'out') {
      o = endpoint;
    } else if (endpoint.direction == 'in') {
      i = endpoint;
    }
  }

  // For no apparent reason sometimes devices will omit to advertise the
  // input endpoint. Sometimes they'll also omit the output endpoint. This
  // attempts to handle those situations in a degraded mode.
  if (!o) {
    throw new DeviceCommunicationError(
      'USB device did not expose an output endpoint. Try power-cycling the device. This is a hardware problem.'
    );
  }

  if (!i) {
    console.warn('USB device did not expose an input endpoint, using unidirectional mode.');
  }

  return {input: i, output: o}
}

if (import.meta.vitest) {
  const { it, expect, describe } = import.meta.vitest;

  describe('connectDevice', () => {
    it('Throws on no endpoint', async () => {
      const badDevice: USBDevice = {
        configurations: []
      } as unknown as USBDevice;
      await expect(() => connectDevice(badDevice)).rejects.toThrowError();
    });

    it('Throws on access denied', async () => {
      // This is thrown if the operating system won't let the browser talk to
      // the device directly.
      const accessException = new DOMException(
        "Failed to execute 'open' on 'USBDevice': Access denied.",
        'SecurityError'
      );
      const badDevice: USBDevice = {
        configurations: [
          {
            interfaces: [
              {
                alternates: [
                  {}
                ]
              }
            ]
          }
        ],
        open() {
          throw accessException;
        },
      } as unknown as USBDevice;
      await expect(() => connectDevice(badDevice)).rejects.toThrow(new DriverAccessDeniedError());
    });
  });
}

function getCommMode(output: boolean, input: boolean) {
  // TODO: Figure out if getting the Interface Protocol Mode is more
  // reliable than the detection method used here...
  if (output === false) {
    // Can't talk to something that isn't listening...
    return ConnectionDirectionMode.none;
  }
  if (input === false) {
    // Can send commands but can't get info back. Operating in the blind.
    return ConnectionDirectionMode.unidirectional;
  }
  return ConnectionDirectionMode.bidirectional;
}

if (import.meta.vitest) {
  const { it, expect, describe } = import.meta.vitest

  describe('getCommMode', () => {
    it('Gets sane result', () => {
      expect(getCommMode(false, false)).toBe(ConnectionDirectionMode.none);
      expect(getCommMode(false, true)).toBe(ConnectionDirectionMode.none);
      expect(getCommMode(true, false)).toBe(ConnectionDirectionMode.unidirectional);
      expect(getCommMode(true, true)).toBe(ConnectionDirectionMode.bidirectional);
    });
  });
}

/** Error indicating the devices's driver cannot be used by WebUSB. */
export class DriverAccessDeniedError extends DeviceCommunicationError {
  constructor() {
    super(
      'Operating system prevented accessing the USB device. If this is on Windows you may need to replace the driver. See https://cellivar.github.io/WebZLP/docs/windows_driver for more details.'
    );
  }
}
