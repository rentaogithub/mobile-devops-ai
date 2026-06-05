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

export interface WatermarkImageTimeInfo {
  time?: string;
  timestamp?: number;
  source: 'exif' | 'pngText' | 'none';
  field?: string;
  reliable: boolean;
}

export interface WatermarkDecodeResult {
  success: boolean;
  deep: boolean;
  candidates: WatermarkCandidate[];
  bestCandidate?: WatermarkCandidate;
  imageTime: WatermarkImageTimeInfo;
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
    const imageTime = await this.extractImageTime(imagePath);

    return {
      success: candidates.length > 0,
      deep,
      candidates,
      bestCandidate: candidates[0],
      imageTime,
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

  private async extractImageTime(imagePath: string): Promise<WatermarkImageTimeInfo> {
    try {
      const buffer = await fs.promises.readFile(imagePath);
      const fromJpeg = this.extractJpegExifTime(buffer);
      if (fromJpeg) {
        return fromJpeg;
      }

      const fromPng = this.extractPngTextTime(buffer);
      if (fromPng) {
        return fromPng;
      }

      return {
        source: 'none',
        reliable: false,
      };
    } catch {
      return {
        source: 'none',
        reliable: false,
      };
    }
  }

  private extractJpegExifTime(buffer: Buffer): WatermarkImageTimeInfo | undefined {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return undefined;
    }

    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        break;
      }

      const marker = buffer[offset + 1];
      const segmentLength = buffer.readUInt16BE(offset + 2);
      const segmentStart = offset + 4;
      const segmentEnd = segmentStart + segmentLength - 2;
      if (segmentLength < 2 || segmentEnd > buffer.length) {
        break;
      }

      if (marker === 0xe1 && buffer.subarray(segmentStart, segmentStart + 6).toString('ascii') === 'Exif\0\0') {
        return this.extractExifTimeFromTiff(buffer.subarray(segmentStart + 6, segmentEnd));
      }

      offset = segmentEnd;
    }

    return undefined;
  }

  private extractExifTimeFromTiff(tiff: Buffer): WatermarkImageTimeInfo | undefined {
    if (tiff.length < 8) {
      return undefined;
    }

    const littleEndian = tiff.subarray(0, 2).toString('ascii') === 'II';
    const bigEndian = tiff.subarray(0, 2).toString('ascii') === 'MM';
    if (!littleEndian && !bigEndian) {
      return undefined;
    }

    const readUInt16 = (offset: number) => littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
    const readUInt32 = (offset: number) => littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
    const readAscii = (offset: number, length: number) => {
      if (offset < 0 || offset + length > tiff.length) {
        return undefined;
      }
      return tiff.subarray(offset, offset + length).toString('ascii').replace(/\0+$/, '').trim();
    };

    const ifd0Offset = readUInt32(4);
    const ifd0Entries = this.readTiffEntries(tiff, ifd0Offset, readUInt16, readUInt32);
    const exifIfdPointer = ifd0Entries.get(0x8769);
    const exifIfdEntries = exifIfdPointer ? this.readTiffEntries(tiff, exifIfdPointer.valueOffset, readUInt16, readUInt32) : new Map<number, { length: number; valueOffset: number }>();

    const candidates: Array<{ tag: number; field: string; entries: Map<number, { length: number; valueOffset: number }> }> = [
      { tag: 0x9003, field: 'DateTimeOriginal', entries: exifIfdEntries },
      { tag: 0x9004, field: 'DateTimeDigitized', entries: exifIfdEntries },
      { tag: 0x0132, field: 'DateTime', entries: ifd0Entries },
    ];

    for (const candidate of candidates) {
      const entry = candidate.entries.get(candidate.tag);
      if (!entry) {
        continue;
      }
      const raw = readAscii(entry.valueOffset, entry.length);
      const date = raw ? this.parseExifDate(raw) : undefined;
      if (date) {
        return this.makeTimeInfo(date, 'exif', candidate.field, true);
      }
    }

    return undefined;
  }

  private readTiffEntries(
    tiff: Buffer,
    ifdOffset: number,
    readUInt16: (offset: number) => number,
    readUInt32: (offset: number) => number
  ): Map<number, { length: number; valueOffset: number }> {
    const entries = new Map<number, { length: number; valueOffset: number }>();
    if (ifdOffset + 2 > tiff.length) {
      return entries;
    }

    const count = readUInt16(ifdOffset);
    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > tiff.length) {
        break;
      }

      const tag = readUInt16(entryOffset);
      const type = readUInt16(entryOffset + 2);
      const length = readUInt32(entryOffset + 4);
      const valueOffset = length <= 4 && type === 2 ? entryOffset + 8 : readUInt32(entryOffset + 8);
      entries.set(tag, { length, valueOffset });
    }

    return entries;
  }

  private extractPngTextTime(buffer: Buffer): WatermarkImageTimeInfo | undefined {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(pngSignature)) {
      return undefined;
    }

    const acceptedFields = new Set(['creation time', 'date:create', 'date:modify', 'createdate', 'modifydate', 'datetime']);
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) {
        break;
      }

      if (type === 'tEXt' || type === 'iTXt') {
        const text = buffer.subarray(dataStart, dataEnd).toString('utf8');
        const firstNull = text.indexOf('\0');
        const key = firstNull >= 0 ? text.slice(0, firstNull) : '';
        const value = firstNull >= 0 ? text.slice(firstNull + 1).replace(/\0/g, ' ').trim() : text.trim();
        const normalizedKey = key.toLowerCase();
        if (acceptedFields.has(normalizedKey)) {
          const date = this.parseFlexibleDate(value);
          if (date) {
            return this.makeTimeInfo(date, 'pngText', key, true);
          }
        }
      }

      offset = dataEnd + 4;
    }

    return undefined;
  }

  private parseExifDate(value: string): Date | undefined {
    const match = value.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!match) {
      return undefined;
    }

    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    );
  }

  private parseFlexibleDate(value: string): Date | undefined {
    const normalized = value.replace(/^XML:\s*/i, '').trim();
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    return this.parseExifDate(normalized);
  }

  private makeTimeInfo(
    date: Date,
    source: WatermarkImageTimeInfo['source'],
    field: string,
    reliable: boolean
  ): WatermarkImageTimeInfo {
    return {
      time: date.toISOString(),
      timestamp: date.getTime(),
      source,
      field,
      reliable,
    };
  }
}

export default new WatermarkDecoderService();
