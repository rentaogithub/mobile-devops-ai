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
});
