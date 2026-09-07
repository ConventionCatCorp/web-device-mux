/** Exception thrown from the WebDeviceMux library. */
export class WebDeviceMuxError extends Error {
  constructor(message: string) {
    super(message);
    // Not this.constructor.name: a minifier rewrites class names, and
    // consumers matching on err.name would silently stop matching. Each
    // subclass sets its own, or they would all report this one.
    this.name = 'WebDeviceMuxError';
  }
}

/** Error indicating communication with the device could not be initiated. */
export class DeviceConnectionError extends WebDeviceMuxError {
  constructor(message?: string, innerException?: Error) {
    super(message ?? innerException?.message ?? 'Error connecting to device');
    this.name = 'DeviceConnectionError';
    this.innerException = innerException;
  }

  innerException?: Error | undefined;
}

/** Error indicating communication with the device failed. */
export class DeviceCommunicationError extends WebDeviceMuxError {
  constructor(message?: string, innerException?: Error) {
    super(message ?? innerException?.message ?? 'Error communicating with device');
    this.name = 'DeviceCommunicationError';
    this.innerException = innerException;
  }

  innerException?: Error | undefined;
}

/** Error indicating the device was not ready to communicate. */
export class DeviceNotReadyError extends DeviceCommunicationError {
  constructor(message?: string, innerException?: Error) {
    // innerException must be forwarded. Dropping it left every
    // DeviceNotReadyError with an undefined cause, so consumers logging
    // error.innerException got nothing at exactly the moment they needed it.
    super(message ?? innerException?.message ?? 'Device not ready to communicate.', innerException);
    this.name = 'DeviceNotReadyError';
  }
}
