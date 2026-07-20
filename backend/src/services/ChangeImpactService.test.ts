import { ChangeImpactService } from './ChangeImpactService';

describe('ChangeImpactService', () => {
  it('maps iOS changes to business domains and targeted suites', () => {
    const result = new ChangeImpactService().analyze({
      files: [
        'NNMessage/Sources/Chat/ChatViewController.swift',
        'NNVoiceRoom/Sources/Room/VoiceRoomViewController.swift',
        'NNIM/PrivacyInfo.xcprivacy',
        'Podfile.lock',
      ],
    });

    expect(result.domains).toEqual(expect.arrayContaining(['im', 'voice_room']));
    expect(result.risks).toEqual(expect.arrayContaining(['privacy_signing_compliance', 'dependency_compatibility']));
    expect(result.recommendedSuites).toEqual(expect.arrayContaining(['smoke', 'im', 'rtc', 'build_validation']));
    expect(result.riskLevel).toBe('high');
  });
});

