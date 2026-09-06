/** Determine if a given device is allowed to be managed by this manager. */
export function isManageableDevice(
  device: USBDevice,
  requestOptions: USBDeviceRequestOptions
): boolean {
  // The type marks filters as required, but this is caller-supplied data that
  // reaches us from plain JS, so the guard is load-bearing at runtime.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const filters = requestOptions.filters ?? [];
  const exclusionFilters = requestOptions.exclusionFilters ?? [];

  // Sanity check: No filters, no devices.
  if (filters.length === 0) {
    return false;
  }

  // Step 1: Device must match at least one inclusion filter.
  if (!filters.some(f => matchesFilter(device, f))) {
    return false;
  }

  // Step 2: Look for exclusions where the device does match.
  if (exclusionFilters.some(f => matchesFilter(device, f))) {
    return false;
  }

  // Not filtered!
  return true;
}

/**
 * Whether a device matches a filter.
 *
 * Per the WebUSB spec every field a filter specifies must match; a filter with
 * no fields matches nothing. The previous implementation OR'd the fields
 * together, which happened to give the right answer for inclusion (by De
 * Morgan, since it tested the negated form against every filter) but was wrong
 * for exclusion: `{ vendorId, productId }` excluded every device from that
 * vendor rather than the single product named.
 */
function matchesFilter(device: USBDevice, filter: USBDeviceFilter): boolean {
  // Following the spec's algorithm: each present field that disagrees rules the
  // device out, and a filter that specifies nothing matches everything.
  if (filter.vendorId     !== undefined && filter.vendorId     !== device.vendorId)        { return false; }
  if (filter.productId    !== undefined && filter.productId    !== device.productId)       { return false; }
  if (filter.classCode    !== undefined && filter.classCode    !== device.deviceClass)     { return false; }
  if (filter.subclassCode !== undefined && filter.subclassCode !== device.deviceSubclass)  { return false; }
  if (filter.protocolCode !== undefined && filter.protocolCode !== device.deviceProtocol)  { return false; }
  if (filter.serialNumber !== undefined && filter.serialNumber !== device.serialNumber)    { return false; }
  return true;
}
