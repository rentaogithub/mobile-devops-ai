import fs from 'fs';
import path from 'path';
import { DSYMInfo } from '../types';
import { StorageService } from './StorageService';
import logger from '../utils/logger';
import { currentProductLineId, getProductLineContext } from './ProductLineContext';
import { productLineConfigService } from './ProductLineConfigService';

export interface DSYMCoverageSummary {
  appVersion: string;
  mainAppReady: boolean;
  relatedReady: boolean;
  total: number;
  valid: number;
  missingDwarf: number;
  modules: Array<{
    appName: string;
    uuid: string;
    version: string;
    buildNumber?: string;
    valid: boolean;
    reason?: string;
  }>;
}

export interface DSYMMatchResult {
  appVersion: string;
  matched: DSYMInfo[];
  missingUUIDs: string[];
  coverage: DSYMCoverageSummary;
  reason?: string;
}

function normalizeUUID(uuid?: string): string {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

function hasDWARFFile(dsymPath: string): boolean {
  const dwarfDir = path.join(dsymPath, 'Contents', 'Resources', 'DWARF');
  if (!fs.existsSync(dwarfDir)) {
    return false;
  }

  return fs.readdirSync(dwarfDir).some((file) => !file.startsWith('.'));
}

function extractCrashUUIDs(crashLog: string): string[] {
  const uuids = new Set<string>();
  const patterns = [
    /<([0-9a-fA-F-]{32,36})>/g,
    /"uuid"\s*:\s*"([0-9a-fA-F-]{32,36})"/g,
    /"debug_id"\s*:\s*"([0-9a-fA-F-]{32,36})"/g,
  ];

  patterns.forEach((pattern) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(crashLog)) !== null) {
      uuids.add(normalizeUUID(match[1]));
    }
  });

  return Array.from(uuids);
}

function extractCrashBinaryNames(crashLog: string): Set<string> {
  const names = new Set<string>();
  crashLog.split('\n').forEach((line) => {
    const frameMatch = line.match(/^\s*\d+\s+(\S+)\s+0x[0-9a-f]+/i);
    if (frameMatch?.[1]) {
      names.add(frameMatch[1]);
    }

    const imageMatch = line.match(/0x[0-9a-f]+\s+-\s+0x[0-9a-f]+\s+(\S+)\s+\S+\s+<[^>]+>/i);
    if (imageMatch?.[1]) {
      names.add(imageMatch[1]);
    }
  });
  return names;
}

function normalizedAppName(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function configuredMainAppNames(): Set<string> {
  const config = productLineConfigService.podxConfig();
  const names = [
    getProductLineContext()?.name,
    config.publishMainRepo,
    config.targetName,
  ];
  if (currentProductLineId() === 'nn') names.push('NNIM', 'NNIOS', 'NN');
  return new Set(names.map(normalizedAppName).filter(Boolean));
}

export function isMainAppDSYM(dsym: DSYMInfo, appVersion?: string | null): boolean {
  if (configuredMainAppNames().has(normalizedAppName(dsym.appName))) return true;
  return Boolean(appVersion)
    && dsym.version === appVersion
    && (!Array.isArray(dsym.relatedAppVersions) || dsym.relatedAppVersions.length === 0);
}

export class DSYMMatcherService {
  private storage = new StorageService();

  async getCoverage(appVersion: string): Promise<DSYMCoverageSummary> {
    const dsymInfos = await this.findDSYMsForAppVersion(appVersion);
    const modules = dsymInfos.map((dsym) => {
      const filePath = this.resolveDSYMFilePath(dsym);
      const valid = hasDWARFFile(filePath);
      return {
        appName: dsym.appName,
        uuid: dsym.uuid,
        version: dsym.version,
        buildNumber: dsym.buildNumber,
        valid,
        reason: valid ? undefined : '缺少 DWARF 文件',
      };
    });

    const valid = modules.filter((item) => item.valid).length;
    return {
      appVersion,
      mainAppReady: dsymInfos.some((dsym, index) => isMainAppDSYM(dsym, appVersion) && modules[index]?.valid),
      relatedReady: dsymInfos.some((dsym, index) => !isMainAppDSYM(dsym, appVersion) && modules[index]?.valid),
      total: modules.length,
      valid,
      missingDwarf: modules.length - valid,
      modules,
    };
  }

  async matchForCrash(appVersion: string, crashLog: string): Promise<DSYMMatchResult> {
    const coverage = await this.getCoverage(appVersion);
    const dsymInfos = await this.findDSYMsForAppVersion(appVersion);
    const crashUUIDs = extractCrashUUIDs(crashLog);
    const crashUUIDSet = new Set(crashUUIDs);
    const crashBinaryNames = extractCrashBinaryNames(crashLog);
    const normalizedCrashLog = normalizeUUID(crashLog);

    const validCandidates = dsymInfos
      .map((dsym) => ({ ...dsym, filePath: this.resolveDSYMFilePath(dsym) }))
      .filter((dsym) => hasDWARFFile(dsym.filePath));

    const matched = validCandidates.filter((dsym) => {
      const uuidMatches = crashUUIDSet.has(normalizeUUID(dsym.uuid)) || normalizedCrashLog.includes(normalizeUUID(dsym.uuid));
      const nameMatches = crashBinaryNames.has(dsym.appName);
      const isMainApp = isMainAppDSYM(dsym, appVersion);
      return uuidMatches || (nameMatches && (!isMainApp || dsym.version === appVersion));
    });

    const finalMatched = matched.length > 0 ? matched : validCandidates;
    const matchedUUIDs = new Set(finalMatched.map((dsym) => normalizeUUID(dsym.uuid)));
    const missingUUIDs = crashUUIDs.filter((uuid) => !matchedUUIDs.has(uuid));
    const reason = finalMatched.length === 0
      ? (dsymInfos.length === 0 ? '未找到对应版本 dSYM' : 'dSYM 文件缺少 DWARF 或不适用于本次崩溃')
      : undefined;

    return {
      appVersion,
      matched: finalMatched,
      missingUUIDs,
      coverage,
      reason,
    };
  }

  async findDSYMsForAppVersion(appVersion: string): Promise<DSYMInfo[]> {
    const allDSYMs = await this.storage.getAllDSYMs();
    const exactMainApps = allDSYMs.filter((dsym) => isMainAppDSYM(dsym, appVersion) && dsym.version === appVersion);
    const relatedComponents = allDSYMs.filter((dsym) =>
      !isMainAppDSYM(dsym, appVersion) &&
      Array.isArray(dsym.relatedAppVersions) &&
      dsym.relatedAppVersions.includes(appVersion)
    );
    const candidates = exactMainApps.length > 0 || relatedComponents.length > 0
      ? [...exactMainApps, ...relatedComponents]
      : allDSYMs.filter((dsym) => dsym.version === appVersion);
    const unique = new Map<string, DSYMInfo>();
    candidates.forEach((dsym) => unique.set(dsym.uuid, dsym));
    return Array.from(unique.values());
  }

  resolveDSYMFilePath(dsym: DSYMInfo): string {
    if (hasDWARFFile(dsym.filePath)) {
      return dsym.filePath;
    }

    const baseDsymDir = process.env.DSYM_DIR || path.resolve(process.cwd(), '..', 'nn-ios-platform-data', 'dsyms');
    const safeProductLineId = currentProductLineId().replace(/[^a-zA-Z0-9_-]/g, '_');
    const dsymDir = currentProductLineId() === 'nn' ? baseDsymDir : path.join(baseDsymDir, safeProductLineId);
    const dsymName = path.basename(dsym.filePath || `${dsym.appName}.dSYM`);
    const candidates = [
      path.join(dsymDir, dsym.uuid, dsymName),
      path.join(dsymDir, dsym.uuid, `${dsym.appName}.dSYM`),
      path.join(dsymDir, dsym.uuid, `${dsym.appName}.app.dSYM`),
    ];
    const resolved = candidates.find((candidate) => hasDWARFFile(candidate));
    if (resolved) {
      logger.warn('修正 dSYM 旧路径', {
        appName: dsym.appName,
        uuid: dsym.uuid,
        oldPath: dsym.filePath,
        resolvedPath: resolved,
      });
      return resolved;
    }

    return dsym.filePath;
  }
}

export const dsymMatcherService = new DSYMMatcherService();
