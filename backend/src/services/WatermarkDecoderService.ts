import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface WatermarkCandidate {
  anchor: string;
  env: string;
  uid: string;
  score: number;
  repaired: boolean;
  scale: number;
  safeTop: number;
  start: {
    x: number;
    y: number;
  };
  enhancement: string;
  payloadHex: string;
}

export interface WatermarkDecodeResult {
  success: boolean;
  deep: boolean;
  candidates: WatermarkCandidate[];
  bestCandidate?: WatermarkCandidate;
  rawOutput: string;
}

class WatermarkDecoderService {
  private readonly decoderDir = path.resolve(__dirname, '../../tools/watermark-decoder-rs');
  private readonly binaryPath = path.join(
    this.decoderDir,
    'target',
    'release',
    process.platform === 'win32' ? 'nn-watermark-decode.exe' : 'nn-watermark-decode'
  );

  async decode(imagePath: string, options: { deep?: boolean; limit?: number } = {}): Promise<WatermarkDecodeResult> {
    const deep = options.deep ?? true;
    const limit = options.limit ?? 20;
    const args = [imagePath, '--limit', String(limit)];
    if (deep) {
      args.push('--deep');
    }

    const output = await this.runDecoder(args);
    const candidates = this.parseCandidates(output);

    return {
      success: candidates.length > 0,
      deep,
      candidates,
      bestCandidate: candidates[0],
      rawOutput: output.trim(),
    };
  }

  private async runDecoder(args: string[]): Promise<string> {
    try {
      if (fs.existsSync(this.binaryPath)) {
        const { stdout, stderr } = await execFileAsync(this.binaryPath, args, {
          cwd: this.decoderDir,
          maxBuffer: 1024 * 1024,
        });
        return `${stdout || ''}${stderr || ''}`;
      }

      const { stdout, stderr } = await execFileAsync('cargo', ['run', '--release', '--', ...args], {
        cwd: this.decoderDir,
        maxBuffer: 1024 * 1024,
      });
      return `${stdout || ''}${stderr || ''}`;
    } catch (error: any) {
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      if (output.includes('No UID watermark decoded.')) {
        return output;
      }
      throw new Error(output.trim() || error.message || '水印解析失败');
    }
  }

  private parseCandidates(output: string): WatermarkCandidate[] {
    const pattern = /^anchor=(\S+)\s+env=(\S+)\s+uid=(\d+)\s+score=([\d.]+)\s+repaired=(true|false)\s+scale=([\d.]+)\s+safeTop=([\d.]+)\s+start=\(([-\d.]+),([-\d.]+)\)\s+enhancement=(\S+)\s+payloadHex=([0-9a-fA-F]+)$/;

    return output
      .split(/\r?\n/)
      .map((line) => line.trim().match(pattern))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({
        anchor: match[1],
        env: match[2],
        uid: match[3],
        score: Number(match[4]),
        repaired: match[5] === 'true',
        scale: Number(match[6]),
        safeTop: Number(match[7]),
        start: {
          x: Number(match[8]),
          y: Number(match[9]),
        },
        enhancement: match[10],
        payloadHex: match[11],
      }));
  }
}

export default new WatermarkDecoderService();
