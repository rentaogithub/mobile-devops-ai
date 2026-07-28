import { SymbolizerService } from './SymbolizerService';
import { StackFrame } from './CrashLogParser';
import { CrashLogParser } from './CrashLogParser';

describe('SymbolizerService simplified crash load address inference', () => {
  it('parses mixed JSON-header sampled hang reports as text logs', () => {
    const parser = new CrashLogParser();
    const parsed = parser.parseCrashLog([
      '{"bug_type":"228","app_name":"NNIM"}',
      'Incident Identifier: D6718F0D-3223-4EE2-AC47-1BFE70B7C96D',
      'Reason:           UIKit-runloop-NNIM: timeout 9850ms',
      '',
      '  Thread 0xf1aeb    Thread name "SDKTaskManager-TaskWorker-0"',
      '  60  ??? (<32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62> + 1053172) [0x10feb91f4]',
    ].join('\n'));

    expect(parsed.format).toBe('apple');
    expect(parsed.stackFrames[0]).toMatchObject({
      binaryName: '???',
      address: '0x10feb91f4',
      offset: '1053172',
    });
  });

  it('symbolicates UUID offset sampled frames with the matching dSYM UUID', async () => {
    const service = new SymbolizerService() as any;
    service.symbolicateWithAtos = jest.fn(async () => new Map([
      [
        '0x10feb91f4',
        'void* std::__1::__thread_proxy<...>(void*) (in leigod_im_cross_sdk) (thread.h:207)',
      ],
      [
        '0x10feb79b4',
        'im_sdk::common::TaskManager::worker(int, std::__1::shared_ptr<im_sdk::common::TaskData>) (in leigod_im_cross_sdk) (TaskManager.cpp:156)',
      ],
    ]));

    const log = [
      'Binary Images:',
      '           0x10fdb8000 -                ???  ???                           <32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62>',
      '',
      '  Thread 0xf1aeb    Thread name "SDKTaskManager-TaskWorker-0"',
      '  60  ??? (<32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62> + 1053172) [0x10feb91f4]',
      '    60  ??? (<32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62> + 1046964) [0x10feb79b4] (blocked by turnstile waiting for this thread)',
    ].join('\n');

    const result = await service.symbolicateUUIDOffsetFrames(
      log,
      '/tmp/leigod_im_cross_sdk.dSYM',
      '32AA34A5-8A47-3BE0-97AF-CF3E2BF70B62',
      'leigod_im_cross_sdk'
    );

    expect(service.symbolicateWithAtos).toHaveBeenCalledWith(
      ['0x10feb91f4', '0x10feb79b4'],
      '/tmp/leigod_im_cross_sdk.dSYM',
      '0x10fdb8000',
      { includeAddressOnly: true }
    );
    expect(result.symbolicatedCount).toBe(2);
    expect(result.symbolicatedLog).toContain('leigod_im_cross_sdk  0x10feb91f4 void* std::__1::__thread_proxy');
    expect(result.symbolicatedLog).toContain('TaskManager.cpp:156');
    expect(result.symbolicatedLog).toContain('(blocked by turnstile waiting for this thread)');
  });

  it('extracts load address from unslid VM address style unknown frames', () => {
    const service = new SymbolizerService() as any;
    const crashLog = [
      'Thread 0 Crashed:',
      '7   NNIM                            0x200e28cd0         <unknown> + 4309814480',
      '8   NNIM                            0x20142794c         <unknown> + 4316100940',
    ].join('\n');

    const loadAddress = service.extractLoadAddressForBinary(crashLog, 'NNIM');

    expect(loadAddress).toBe('0x200000000');
  });

  it('uses <unknown> unslid VM addresses as high-priority load address candidates', () => {
    const service = new SymbolizerService() as any;
    const frames: StackFrame[] = [
      {
        index: 7,
        binaryName: 'NNIM',
        address: '0x200e28cd0',
        symbol: '<unknown>',
        offset: '4309814480',
        line: '7  NNIM  0x200e28cd0  <unknown> + 4309814480',
      },
      {
        index: 8,
        binaryName: 'NNIM',
        address: '0x20142794c',
        symbol: '<unknown>',
        offset: '4316100940',
        line: '8  NNIM  0x20142794c  <unknown> + 4316100940',
      },
    ];

    const candidates = service.inferLoadAddressesFromSimplifiedStack(frames, 'NNIM');

    expect(candidates[0]).toBe('0x200000000');
    expect(candidates).toContain('0x200e28000');
  });

  it('uses small <unknown> offsets directly as load address candidates', () => {
    const service = new SymbolizerService() as any;
    const frames: StackFrame[] = [
      {
        index: 3,
        binaryName: 'NNIM',
        address: '0x200e28cd0',
        symbol: '<unknown>',
        offset: '123456',
        line: '3  NNIM  0x200e28cd0  <unknown> + 123456',
      },
    ];

    const candidates = service.inferLoadAddressesFromSimplifiedStack(frames, 'NNIM');

    expect(candidates[0]).toBe('0x200e0aa90');
  });

  it('falls back to page-aligned candidates when the plus value is an absolute address', () => {
    const service = new SymbolizerService() as any;
    const frames: StackFrame[] = [
      {
        index: 5,
        binaryName: 'NNRtc',
        address: '0x103c03650',
        symbol: '<unknown>',
        offset: '4357895760',
        line: '5  NNRtc  0x103c03650  <unknown> + 4357895760',
      },
    ];

    const candidates = service.inferLoadAddressesFromSimplifiedStack(frames, 'NNRtc');

    expect(candidates[0]).toBe('0x103c00000');
  });

  it('prefers candidates that symbolize deeper frames when symbol counts tie', async () => {
    const service = new SymbolizerService() as any;
    service.symbolicateWithAtos = jest.fn(async (_addresses: string[], _dsymPath: string, loadAddress: string) => {
      if (loadAddress === '0x100000000') {
        return new Map([['0x100001000', 'firstFrame']]);
      }

      return new Map([['0x100002000', 'secondFrame']]);
    });

    const result = await service.symbolicateWithCandidateLoadAddresses(
      ['0x100001000', '0x100002000'],
      '/tmp/NNIM.dSYM',
      ['0x100000000', '0x100001000']
    );

    expect(result.get('0x100002000')).toBe('secondFrame');
  });

  it('does not count address-only atos output as a real symbol unless requested', () => {
    const service = new SymbolizerService() as any;

    expect(service.isUsableAtosSymbol('0x00003650 (in NNRtc)', '0x103c03650')).toBe(false);
    expect(
      service.isUsableAtosSymbol('0x00003650 (in NNRtc)', '0x103c03650', true)
    ).toBe(true);
  });

  it('fills unresolved app frames with address-only atos output after choosing the best candidate', async () => {
    const service = new SymbolizerService() as any;
    service.symbolicateWithAtos = jest.fn(
      async (addresses: string[], _dsymPath: string, loadAddress: string, options?: { includeAddressOnly?: boolean }) => {
        if (options?.includeAddressOnly) {
          return new Map(
            addresses.map((address) => [address, `0x00003650 (in NNRtc)`])
          );
        }

        if (loadAddress === '0x103c00000') {
          return new Map([['0x103c11460', 'ParseInt<int> (in NNRtc) (time_zone_format.cc:242)']]);
        }

        return new Map();
      }
    );

    const result = await service.symbolicateWithCandidateLoadAddresses(
      ['0x103c11460', '0x103c03650'],
      '/tmp/NNRtc.dSYM',
      ['0x103c00000', '0x100000000']
    );

    expect(result.get('0x103c11460')).toContain('ParseInt<int>');
    expect(result.get('0x103c03650')).toBe('0x00003650 (in NNRtc)');
  });

  it('prefers the best system library candidate load address', async () => {
    const service = new SymbolizerService() as any;
    service.symbolicateWithAtosForSystemLib = jest.fn(
      async (_addresses: string[], _binaryPath: string, loadAddress: string) => {
        if (loadAddress === '0x38e490000') {
          return new Map([
            ['0x38e4a71e4', '_dispatch_source_set_handler (in libdispatch.dylib) + 60'],
            ['0x38e492148', '_dispatch_xref_dispose (in libdispatch.dylib) + 8'],
          ]);
        }

        return new Map();
      }
    );

    const result = await service.symbolicateSystemLibWithCandidateLoadAddresses(
      ['0x38e4a71e4', '0x38e492148'],
      '/tmp/libdispatch.dylib',
      ['0x2bd906000', '0x38e490000'],
      'libdispatch.dylib'
    );

    expect(result.get('0x38e492148')).toContain('_dispatch_xref_dispose');
  });
});
