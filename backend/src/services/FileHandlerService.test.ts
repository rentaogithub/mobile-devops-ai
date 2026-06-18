import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { FileHandlerService } from './FileHandlerService';

describe('FileHandlerService', () => {
  let root: string;
  let uploadDir: string;
  let dsymDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-handler-'));
    uploadDir = path.join(root, 'uploads');
    dsymDir = path.join(root, 'dsyms');
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DSYM_DIR = dsymDir;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
    delete process.env.DSYM_DIR;
  });

  it('extracts dSYM from tgz archives', async () => {
    const sourceDir = path.join(root, 'source');
    const dsymDirInArchive = path.join(sourceDir, 'Demo.app.dSYM', 'Contents', 'Resources', 'DWARF');
    fs.mkdirSync(dsymDirInArchive, { recursive: true });
    fs.writeFileSync(path.join(dsymDirInArchive, 'Demo'), 'mock dwarf');

    const tgzPath = path.join(root, 'Demo.dSYM.tgz');
    await tar.c(
      {
        cwd: sourceDir,
        file: tgzPath,
        gzip: true,
      },
      ['Demo.app.dSYM']
    );

    const service = new FileHandlerService();
    const extracted = await service.extractTarGz(tgzPath);

    expect(extracted.endsWith('Demo.app.dSYM')).toBe(true);
    expect(fs.existsSync(path.join(extracted, 'Contents', 'Resources', 'DWARF', 'Demo'))).toBe(true);
  });

  it('cleans archive and extracted wrapper after moving dSYM to permanent storage', async () => {
    const sourceDir = path.join(root, 'source-cleanup');
    const dsymDirInArchive = path.join(sourceDir, 'Demo.app.dSYM', 'Contents', 'Resources', 'DWARF');
    fs.mkdirSync(dsymDirInArchive, { recursive: true });
    fs.writeFileSync(path.join(dsymDirInArchive, 'Demo'), 'mock dwarf');

    fs.mkdirSync(uploadDir, { recursive: true });
    const tgzPath = path.join(uploadDir, 'Demo.dSYM.tgz');
    await tar.c(
      {
        cwd: sourceDir,
        file: tgzPath,
        gzip: true,
      },
      ['Demo.app.dSYM']
    );

    const service = new FileHandlerService();
    const extracted = await service.extractTarGz(tgzPath);
    const extractionRoot = path.dirname(extracted);
    const permanent = await service.moveToPermanentStorage(extracted, 'UUID-DEMO');

    await service.cleanupUploadArtifacts(tgzPath, extracted, permanent);

    expect(fs.existsSync(tgzPath)).toBe(false);
    expect(fs.existsSync(extractionRoot)).toBe(false);
    expect(fs.existsSync(permanent)).toBe(true);
    expect(path.basename(permanent)).toBe('Demo.app.dSYM');
  });
});
