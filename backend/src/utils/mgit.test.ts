import { buildMgitPublishArgs } from './mgit';

describe('buildMgitPublishArgs', () => {
  it('passes the selected base branch explicitly to mgit publish', () => {
    expect(buildMgitPublishArgs('release/6.2.1', 'release/6.2.0')).toEqual([
      'publish',
      'release/6.2.1',
      '--base-branch',
      'release/6.2.0',
    ]);
  });

  it('passes the selected product line before the mgit action', () => {
    expect(buildMgitPublishArgs('release/1.8.0', 'develop', 'mobileRtc')).toEqual([
      '--line',
      'mobileRtc',
      'publish',
      'release/1.8.0',
      '--base-branch',
      'develop',
    ]);
  });
});
