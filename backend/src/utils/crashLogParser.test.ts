import { extractCrashInfo } from './crashLogParser';

describe('crashLogParser crash module attribution', () => {
  it('attributes timed out runloop hangs to the blocker thread UUID', () => {
    const log = [
      '{"bug_type":"228","app_name":"NNIM","app_version":"5.14.10"}',
      'Reason:           UIKit-runloop-NNIM: timeout 9850ms',
      'Event:            Timed Out Runloop Hang',
      '',
      'Process:          NNIM [3715]',
      '',
      '  Thread 0xf1970    DispatchQueue "com.apple.main-thread"(1)',
      '  60  ??? (<9D233F9C-ABAB-3B54-B675-07FAF65FBFB9> + 3439660) [0x109853c2c]',
      '   *1   ??? (<84FA5857-FE25-36F6-ACB0-828CE29EC10F> + 4970440) [0xfffffff0081f57c8] (blocked by turnstile waiting for NNIM [3715] thread 0xf1aeb)',
      '',
      '  Thread 0xf1aeb    Thread name "SDKTaskManager-TaskWorker-0"    60 samples (1-60)',
      '  60  ??? (<32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62> + 1053172) [0x10feb91f4]',
      '    60  ??? (<32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62> + 1046964) [0x10feb79b4]',
      '',
      '  Thread 0xf1aec    60 samples (1-60)',
      '  60  libsystem_pthread.dylib  0x00000001fbde3a10 <unknown> + 1',
    ].join('\n');

    const info = extractCrashInfo(log, log);

    expect(info.crashType).toBe('Runloop Hang');
    expect(info.crashReason).toBe('UIKit-runloop-NNIM: timeout 9850ms');
    expect(info.crashModule).toBe('UUID:32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62');
    expect(info.crashModuleUuid).toBe('32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62');
    expect(info.crashLocation).toBe('SDKTaskManager-TaskWorker-0');
    expect(info.blockerThreadId).toBe('0xf1aeb');
  });

  it('uses the first actionable blocker frame after UUID-offset hang symbolication', () => {
    const log = [
      '{"bug_type":"228","app_name":"NNIM","app_version":"5.14.10"}',
      'Reason:           UIKit-runloop-NNIM: timeout 9850ms',
      'Event:            Timed Out Runloop Hang',
      '',
      '  Thread 0xf1970    DispatchQueue "com.apple.main-thread"(1)',
      '   *1   ??? (<84FA5857-FE25-36F6-ACB0-828CE29EC10F> + 4970440) [0xfffffff0081f57c8] (blocked by turnstile waiting for NNIM [3715] thread 0xf1aeb)',
      '',
      '  Thread 0xf1aeb    Thread name "SDKTaskManager-TaskWorker-0"    60 samples (1-60)',
      '  60  leigod_im_cross_sdk  0x10feb91f4 void* std::__1::__thread_proxy[abi:ne190102]<std::__1::tuple<...>>(void*) (in leigod_im_cross_sdk) (thread.h:207)',
      '    60  leigod_im_cross_sdk  0x10feb79b4 im_sdk::common::TaskManager::worker(int, std::__1::shared_ptr<im_sdk::common::TaskData>) (in leigod_im_cross_sdk) (TaskManager.cpp:156)',
      '      60  leigod_im_cross_sdk  0x10fe405d8 im_sdk::SDKTaskManager::doTask(std::__1::shared_ptr<im_sdk::common::Task>, std::__1::shared_ptr<im_sdk::common::TaskData>) (in leigod_im_cross_sdk) (SDKTaskManager.cpp:50)',
    ].join('\n');

    const info = extractCrashInfo(log, log);

    expect(info.crashModule).toBe('leigod_im_cross_sdk - im_sdk::common::TaskManager(worker)');
    expect(info.crashLocation).toBe('im_sdk::common::TaskManager(worker)');
  });

  it('attributes image decoding crashes to ImageIO before later app frames', () => {
    const log = [
      'Exception Type: MXCPUException',
      'Crashed Thread: 0',
      '',
      'Thread 0 Crashed:',
      '0  ImageIO  0x00000001a450a3b4 GetCoeffsFast (in ImageIO) + 83',
      '1  ImageIO  0x00000001a4509b00 VP8DecodeMB (in ImageIO) + 431',
      '2  NNRtc    0x0000000100001000 std::__Cr::vector<absl::time_internal::cctz::TransitionType>::(__swap_out_circular_buffer)',
    ].join('\n');

    const info = extractCrashInfo(log, log);

    expect(info.crashModule).toBe('ImageIO - GetCoeffsFast');
    expect(info.crashLocation).toBe('GetCoeffsFast');
  });

  it('keeps ImageIO attribution when ColorSync appears above it', () => {
    const log = [
      'Exception Type: MXHangDiagnostic',
      'Crashed Thread: 0',
      '',
      'Thread 0 Crashed:',
      '0  libsystem_m.dylib  0x00000002bc143268 <unknown>',
      '1  ColorSync          0x00000001b33d00c4 <unknown>',
      '6  CoreGraphics       0x000000019bfb380d CGColorSpaceCreateWithICCData (in CoreGraphics) + 179',
      '7  ImageIO            0x000000019e06fad4 CGColorSpaceCreateWithCopyOfData (in ImageIO) + 55',
      '8  NNRtc              0x0000000100001000 chacha20_poly1305_seal',
    ].join('\n');

    const info = extractCrashInfo(log, log);

    expect(info.crashModule).toBe('ImageIO - CGColorSpaceCreateWithCopyOfData');
    expect(info.crashLocation).toBe('CGColorSpaceCreateWithCopyOfData');
  });

  it('attributes app hangs caused by WebP decoding to ImageIO instead of app main', () => {
    const log = [
      'Exception Type:      App Hang Fully Blocked',
      'Exception Message:   App hanging between 4.8 and 5.6 seconds.',
      'Crashed Thread:      0',
      '',
      'Thread 0 Crashed:',
      '0  libsystem_platform.dylib  0x00000002a3e4a9e4 <unknown>',
      '1  ImageIO  0x00000001867a0e84 FinishRow (in ImageIO) + 1572',
      '2  ImageIO  0x00000001867b2220 VP8Decode (in ImageIO) + 288',
      '3  ImageIO  0x00000001867a9254 WebPDecode (in ImageIO) + 340',
      '4  QuartzCore  0x000000018404a0d4 CA::Render::copy_image(CGImage*, CGColorSpace*, unsigned int, double, double) (in QuartzCore) + 3048',
      '5  UIKitCore  0x00000001892cc244 -[UIApplication _run] (in UIKitCore) + 796',
      '6  NNIM  0x0000000102571388 main (in NNIM) (AppDelegate.swift:0)',
    ].join('\n');

    const info = extractCrashInfo(log, log);

    expect(info.crashType).toBe('App Hang Fully Blocked');
    expect(info.crashReason).toBe('App hanging between 4.8 and 5.6 seconds.');
    expect(info.crashModule).toBe('ImageIO - FinishRow');
    expect(info.crashLocation).toBe('FinishRow');
  });
});
