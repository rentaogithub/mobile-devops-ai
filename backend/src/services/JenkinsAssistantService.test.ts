import { JenkinsAssistantService } from './JenkinsAssistantService';
import axios from 'axios';

describe('Jenkins assistant closed-loop operations', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats a successful build with a blocked release gate as not verified', async () => {
    const service = new JenkinsAssistantService();
    jest.spyOn(service, 'getBuildSnapshot').mockResolvedValue({
      number: 1584,
      result: 'SUCCESS',
      building: false,
      branchName: 'develop',
      appVersion: '5.15.0',
      log: '',
    } as any);
    jest.spyOn(service, 'previewReleaseGate').mockResolvedValue({
      releaseGate: { status: 'blocked', score: 75, result: { summary: '缺少 smoke 质检' } },
    });

    const result = await service.verifyBuild(1584, false);

    expect(result).toMatchObject({
      kind: 'build_verification',
      status: 'passed',
      passed: false,
      releaseGate: { status: 'blocked' },
      nextActions: ['处理质量门禁阻断项后重新验证'],
    });
  });

  it('does not retry an Apple release through the ordinary build retry tool', async () => {
    const service = new JenkinsAssistantService();
    jest.spyOn(service, 'getBuildSnapshot').mockResolvedValue({
      number: 100,
      result: 'FAILURE',
      building: false,
      branchName: 'release/5.15.0',
      deployTarget: 'TestFlight',
      log: '',
    } as any);
    const trigger = jest.spyOn(service, 'triggerRelease');

    await expect(service.retryBuild(100)).rejects.toThrow('受控发布工具');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('replays a quality task with its original safe parameters', async () => {
    const service = new JenkinsAssistantService();
    jest.spyOn(service, 'getBuildSnapshot').mockResolvedValue({
      number: 88,
      result: 'FAILURE',
      building: false,
      sourceBuildNumber: 1584,
      suite: 'smoke',
      branchName: 'develop',
      commitHash: 'abc1234',
      appVersion: '5.15.0',
      devicePool: 'ios-default',
      log: '',
    } as any);
    const trigger = jest.spyOn(service, 'triggerQuality').mockResolvedValue({ id: 'task-retry', status: 'queued' } as any);

    await expect(service.retryQualityBuild(88)).resolves.toMatchObject({
      kind: 'quality_retry',
      retryOf: 88,
      task: { id: 'task-retry', status: 'queued' },
    });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      sourceBuildNumber: 1584,
      suite: 'smoke',
      branch: 'develop',
      appVersion: '5.15.0',
    }));
  });

  it('resolves a queued submission to its live Jenkins build status', async () => {
    const service = new JenkinsAssistantService();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: { executable: { number: 1585 } } } as any);
    jest.spyOn(service, 'getBuildSnapshot').mockResolvedValue({
      number: 1585,
      result: null,
      building: true,
      branchName: 'develop',
      deployTarget: 'Pgyer',
      url: 'http://jenkins/job/nn/1585/',
    } as any);

    await expect(service.getBuildSubmissionStatus({
      queueUrl: `${(service as any).baseUrl}/queue/item/123/`,
      branch: 'develop',
      deployTarget: 'Pgyer',
    })).resolves.toMatchObject({
      phase: 'running',
      terminal: false,
      buildNumber: 1585,
      branch: 'develop',
    });
  });

  it('finds the new build by branch and submission time after Jenkins removes the queue item', async () => {
    const service = new JenkinsAssistantService();
    const submittedAt = '2026-07-29T04:45:00.000Z';
    jest.spyOn(axios, 'get')
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        data: {
          builds: [{
            number: 1585,
            timestamp: Date.parse(submittedAt) + 5_000,
            actions: [{ parameters: [{ name: 'branch', value: 'origin/develop' }] }],
          }],
        },
      } as any);
    jest.spyOn(service, 'getBuildSnapshot').mockResolvedValue({
      number: 1585,
      result: 'SUCCESS',
      building: false,
      branchName: 'develop',
      deployTarget: 'Pgyer',
      url: 'http://jenkins/job/nn/1585/',
    } as any);

    await expect(service.getBuildSubmissionStatus({
      queueUrl: `${(service as any).baseUrl}/queue/item/263/`,
      branch: 'develop',
      deployTarget: 'Pgyer',
      submittedAt,
    })).resolves.toMatchObject({
      phase: 'success',
      terminal: true,
      buildNumber: 1585,
      result: 'SUCCESS',
    });
  });
});
