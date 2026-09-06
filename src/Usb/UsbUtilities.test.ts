import { it, expect, describe } from 'vitest';
import { isManageableDevice } from './UsbUtilities.js';

describe('Filter Includes Work', () => {
  const device = {
    vendorId: 0x1234,
  } as USBDevice;
  it('No filters means no device', () => {
    const filter = {} as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(false);
  });

  it('Filter mismatch excludes device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x9999,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(false);
  });

  it('Multiple filters with all mismatch excludes device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x9999,
        },
        {
          vendorId: 0x9998,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(false);
  });

  it('Blank filter allows device', () => {
    const filter = {
      filters: [{}]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(true);
  });

  it('Filter match allows device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(true);
  });

  it('Multiple filters with some match allows device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
        },
        {
          vendorId: 0x9999,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(true);
  });

  it('Multiple filters with all match allows device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
        },
        {
          vendorId: 0x1234,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(true);
  });
});

describe('Multiple filter fields work', () => {
  const device = {
    vendorId: 0x1234,
    productId: 0xabcd,
    deviceClass: 0x42,
    deviceSubclass: 0x01,
    deviceProtocol: 0x00,
    serialNumber: '1234567890'
  } as USBDevice;

  it('Filter multiple data match includes device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
          productId: 0xabcd,
          classCode: 0x42,
          subclassCode: 0x01,
          protocolCode: 0x00,
          serialNumber: '1234567890'
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(true);
  });

  it('Multiple filters with one valid includes device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
          productId: 0xabcd,
        },
        {
          vendorId: 0x1234,
          productId: 0x1234,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(true);
  });

  it('Mixed field match excludes device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
          productId: 0x1234,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(false);
  });

  it('Multiple mixed field mismatch excludes device', () => {
    const filter = {
      filters: [
        {
          vendorId: 0x1234,
          productId: 0x1234,
        },
        {
          vendorId: 0xabcd,
          productId: 0xabcd,
        }
      ]
    } as USBDeviceRequestOptions;
    expect(isManageableDevice(device, filter)).toBe(false);
  });
});

describe('exclusionFilters', () => {
  const epson = {
    vendorId: 0x04b8,
    productId: 0x0202,
    deviceClass: 7,
    deviceSubclass: 1,
    deviceProtocol: 2,
    serialNumber: 'abc',
  } as USBDevice;
  const sameVendorOtherProduct = { ...epson, productId: 0x0e15 } as USBDevice;

  const options = (exclusionFilters: USBDeviceFilter[]): USBDeviceRequestOptions =>
    ({ filters: [{ vendorId: 0x04b8 }], exclusionFilters });

  it('excludes only the device matching every field', () => {
    // Fields within one filter are ANDed. OR-ing them made
    // { vendorId, productId } exclude the whole vendor, silently dropping
    // every other printer that vendor makes.
    const opts = options([{ vendorId: 0x04b8, productId: 0x0202 }]);
    expect(isManageableDevice(epson, opts)).toBe(false);
    expect(isManageableDevice(sameVendorOtherProduct, opts)).toBe(true);
  });

  it('excludes a whole vendor when only the vendor is named', () => {
    const opts = options([{ vendorId: 0x04b8 }]);
    expect(isManageableDevice(epson, opts)).toBe(false);
    expect(isManageableDevice(sameVendorOtherProduct, opts)).toBe(false);
  });

  it('does not exclude on a partial match', () => {
    const opts = options([{ vendorId: 0x9999, productId: 0x0202 }]);
    expect(isManageableDevice(epson, opts)).toBe(true);
  });

  it('matches on serial number alongside ids', () => {
    expect(isManageableDevice(epson, options([{ vendorId: 0x04b8, serialNumber: 'abc' }]))).toBe(false);
    expect(isManageableDevice(epson, options([{ vendorId: 0x04b8, serialNumber: 'xyz' }]))).toBe(true);
  });
});
