import { describe, expect, it } from 'vitest';
import { findRegisteredAppleDevice, getAppleRegistrationAutoAction } from './appleDeviceUtils';

const udid = '00008020-001D31642E81002E';
const device = { id: 'device', udid, name: 'iPhone', platform: 'IOS', status: 'ENABLED' };

describe('Apple registration evidence', () => {
  it('does not use cached device lists or lookups as registration confirmation', () => {
    expect(findRegisteredAppleDevice({
      udid,
      developerDevices: { devices: [device], total: 1, platform: 'IOS', source: 'cache' },
      lookup: { registered: true, device, source: 'cache' },
    })).toBeNull();
  });
  it('matches a live Apple device despite separator and case differences', () => {
    expect(findRegisteredAppleDevice({
      udid: udid.replace(/-/g, '').toLowerCase(), lookup: { registered: true, device, source: 'apple' },
    })).toEqual(device);
  });
  it('only auto-submits after a successful live query confirms the device is absent', () => {
    expect(getAppleRegistrationAutoAction({ udid, lookup: { registered: false, source: 'cache', warning: 'offline' } }).shouldSubmit).toBeUndefined();
    expect(getAppleRegistrationAutoAction({ udid, lookup: { registered: false, source: 'apple' } }).shouldSubmit).toBe(true);
  });
});
