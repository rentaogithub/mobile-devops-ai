import { useState } from 'react';
import { Alert, Button, Collapse, Empty, Space, Tag, Typography, message } from 'antd';
import { JenkinsQualityBuild, dsymApi, jenkinsApi, symbolicateApi } from '../../services/api';
import type { DSYMInfo, SymbolicationResult } from '../../types';
import { isComponentDSYM, isMainAppDSYM } from '../../utils/dsym';

const { Text } = Typography;

function tailLines(content: string, maxLines = 80) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-maxLines).join('\n');
}

function normalizeUUID(uuid?: string) {
  return (uuid || '').trim().toUpperCase();
}

function parseCrashJsonHeader(content: string): Record<string, any> {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().startsWith('{'))?.trim();
  if (!firstLine) return {};
  try {
    return JSON.parse(firstLine);
  } catch {
    return {};
  }
}

function extractCrashField(content: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim();
}

function extractCrashVersion(content: string) {
  const header = parseCrashJsonHeader(content);
  const version = header.app_version || header.bundleVersion || header.bundleShortVersion;
  if (version) return String(version).trim();
  const versionLine = extractCrashField(content, 'Version');
  return versionLine?.match(/^([^\s(]+)/)?.[1]?.trim() || '';
}

function extractCrashMetadata(content: string) {
  const header = parseCrashJsonHeader(content);
  return {
    appName: String(header.app_name || header.procName || extractCrashField(content, 'Command') || extractCrashField(content, 'Process') || '').trim(),
    version: extractCrashVersion(content),
    buildVersion: String(header.build_version || header.bundleShortVersion || '').trim(),
    bundleId: String(header.bundleID || extractCrashField(content, 'Identifier') || '').trim(),
    incidentId: String(header.incident_id || header.incidentID || extractCrashField(content, 'Incident Identifier') || '').trim(),
    sliceUUID: normalizeUUID(header.slice_uuid || header.uuid || ''),
    exceptionType: extractCrashField(content, 'Exception Type') || '',
    terminationReason: extractCrashField(content, 'Termination Reason') || '',
  };
}

function extractResourceStackBinaries(content: string) {
  if (!/Heaviest stack for the target process:/i.test(content)) return [];
  const binaries = new Set<string>();
  for (const match of content.matchAll(/^\s*\d+\s+\S+\s+\(([^+()]+)\s+\+\s+\d+\)\s+\[0x[0-9a-f]+\]/gim)) {
    const binaryName = match[1]?.trim();
    if (binaryName && !['dyld'].includes(binaryName)) {
      binaries.add(binaryName.toUpperCase());
    }
  }
  return Array.from(binaries);
}

function selectCrashDsymUUIDs(content: string, dsyms: DSYMInfo[]) {
  const metadata = extractCrashMetadata(content);
  const stackBinaries = extractResourceStackBinaries(content);
  const appearsInResourceStack = (dsym: DSYMInfo) => (
    stackBinaries.length === 0 || stackBinaries.includes(dsym.appName.replace(/\.app$/i, '').toUpperCase())
  );
  const exactUUID = metadata.sliceUUID;
  const exactMatch = exactUUID ? dsyms.find((dsym) => normalizeUUID(dsym.uuid) === exactUUID) : undefined;
  if (exactMatch) {
    return { uuids: [exactMatch.uuid], metadata, matchType: 'uuid' as const };
  }

  if (!metadata.version) {
    return { uuids: [] as string[], metadata, matchType: 'none' as const };
  }

  const mainApp = dsyms.find((dsym) => isMainAppDSYM(dsym, metadata.version) && dsym.version.trim() === metadata.version && appearsInResourceStack(dsym));
  const relatedComponents = dsyms.filter((dsym) => (
    isComponentDSYM(dsym, metadata.version) &&
    dsym.relatedAppVersions?.map((version) => version.trim()).includes(metadata.version) &&
    appearsInResourceStack(dsym)
  ));
  const uuids = [
    ...(mainApp ? [mainApp.uuid] : []),
    ...relatedComponents.map((component) => component.uuid),
  ];
  return { uuids, metadata, matchType: uuids.length > 0 ? 'version' as const : 'none' as const };
}

function analysisSeverityColor(severity?: string) {
  if (severity === 'failed') return 'red';
  if (severity === 'warning') return 'orange';
  if (severity === 'passed') return 'green';
  return 'default';
}

type CrashSymbolicationState = {
  loading?: boolean;
  error?: string;
  result?: SymbolicationResult;
  usedUUIDs?: string[];
  metadata?: ReturnType<typeof extractCrashMetadata>;
  matchType?: 'uuid' | 'version' | 'none';
};

function SymbolicatedCrashAnalysisDigest({
  analysis,
}: {
  analysis?: SymbolicationResult['analysis'] | SymbolicationResult['aiAnalysis'];
}) {
  if (!analysis) return null;
  return (
    <Alert
      showIcon
      type={analysis.severity === 'critical' || analysis.severity === 'high' ? 'error' : 'info'}
      message={analysis.summary || '崩溃分析结果'}
      description={(
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Space wrap>
            {analysis.crashType && <Tag color="red">{analysis.crashType}</Tag>}
            {analysis.crashModule && <Tag>{analysis.crashModule}</Tag>}
            {analysis.crashLocation && <Tag color="orange">{analysis.crashLocation}</Tag>}
            {analysis.appVersion && <Tag color="purple">版本 {analysis.appVersion}</Tag>}
          </Space>
          {analysis.possibleCauses?.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              可能原因：{analysis.possibleCauses.slice(0, 3).join('；')}
            </Text>
          )}
          {analysis.suggestions?.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              建议：{analysis.suggestions.slice(0, 3).join('；')}
            </Text>
          )}
        </Space>
      )}
    />
  );
}

interface CrashAnalysisSummaryProps {
  analysis?: NonNullable<NonNullable<JenkinsQualityBuild['qualitySummary']>['exceptionAnalysis']>;
  crashReportsUrl?: string;
}

export function CrashAnalysisSummary({ analysis, crashReportsUrl }: CrashAnalysisSummaryProps) {
  const [symbolicationByFile, setSymbolicationByFile] = useState<Record<string, CrashSymbolicationState>>({});
  if (!analysis) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次任务没有异常分析结果" />;
  }
  const logSamples = analysis.samples || [];
  const hangStackAnalysis = analysis.hangStackAnalysis || [];
  const crashFileName = (file?: string) => (file || '').split('/').filter(Boolean).at(-1) || '';
  const autoHangAnalysisByFile = new Map(hangStackAnalysis.map((item) => [crashFileName(item.file), item]));
  const crashFileUrl = (file?: string) => {
    const fileName = crashFileName(file);
    if (!fileName || !crashReportsUrl) return '';
    return `${crashReportsUrl.replace(/\/$/, '')}/${encodeURIComponent(fileName)}`;
  };
  const crashFiles = Array.from(new Set((analysis.crashReports?.files || []).map(crashFileName).filter(Boolean)));
  const downloadCrashIps = async (file: string) => {
    const url = crashFileUrl(file);
    if (!url) {
      message.warning('未找到 ips 文件下载地址');
      return;
    }
    const fileName = file.toLowerCase().endsWith('.ips') ? file : `${file}.ips`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('下载 ips 失败');
      }
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (error: any) {
      message.error(error?.message || '下载 ips 失败');
    }
  };
  const handleSymbolicateCrash = async (file: string) => {
    const url = crashFileUrl(file);
    if (!url) {
      message.warning('未找到 ips 文件下载地址');
      return;
    }
    setSymbolicationByFile((prev) => ({
      ...prev,
      [file]: { ...(prev[file] || {}), loading: true, error: undefined },
    }));
    try {
      const previewResponse = await jenkinsApi.previewQualityArtifact(url);
      if (!previewResponse.success || !previewResponse.data?.content) {
        throw new Error(previewResponse.error || '读取 ips 文件失败');
      }

      const crashLog = previewResponse.data.content;
      const dsymResponse = await dsymApi.list();
      if (!dsymResponse.success || !dsymResponse.data) {
        throw new Error(dsymResponse.error || '读取 dSYM 列表失败');
      }

      const { uuids, metadata, matchType } = selectCrashDsymUUIDs(crashLog, dsymResponse.data);
      if (uuids.length === 0) {
        const versionText = metadata.version ? `版本 ${metadata.version}` : '当前崩溃文件';
        throw new Error(`未匹配到 ${versionText} 对应的 dSYM，请先上传或关联 dSYM 后再解析`);
      }

      const symbolicationResponse = await symbolicateApi.symbolicate(crashLog, uuids);
      if (!symbolicationResponse.success || !symbolicationResponse.data) {
        throw new Error(symbolicationResponse.error || '符号化解析失败');
      }

      setSymbolicationByFile((prev) => ({
        ...prev,
        [file]: {
          loading: false,
          result: symbolicationResponse.data,
          usedUUIDs: uuids,
          metadata,
          matchType,
        },
      }));
      message.success('符号化解析完成');
    } catch (error: any) {
      setSymbolicationByFile((prev) => ({
        ...prev,
        [file]: {
          ...(prev[file] || {}),
          loading: false,
          error: error?.error || error?.message || '符号化解析失败',
        },
      }));
    }
  };
  const renderHangStackAnalysis = (hang: NonNullable<typeof hangStackAnalysis[number]>) => (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Text>{hang.mainThread?.summary || hang.reason || '检测到 Watchdog 卡顿。'}</Text>
      <Collapse
        size="small"
        items={[
          {
            key: 'main-thread',
            label: `主线程堆栈 ${hang.mainThread?.queue || hang.mainThread?.name || ''}`,
            children: (
              <pre style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5, background: '#fafafa', padding: 12, border: '1px solid #f0f0f0', borderRadius: 4 }}>
                {(hang.mainThread?.frames || []).slice(0, 24).map((frame, frameIndex) => (
                  `${frameIndex.toString().padStart(2, ' ')} ${frame.image || ''} ${frame.symbol || ''}`
                )).join('\n')}
              </pre>
            ),
          },
          {
            key: 'suspicious',
            label: `可疑同步等待线程 ${hang.suspiciousThreads?.length || 0}`,
            children: (hang.suspiciousThreads?.length || 0) > 0 ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {(hang.suspiciousThreads || []).map((thread) => (
                  <pre key={`${thread.index}-${thread.queue || thread.name || 'thread'}`} style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5, background: '#fafafa', padding: 12, border: '1px solid #f0f0f0', borderRadius: 4 }}>
                    {[
                      `Thread ${thread.index ?? '-'} ${thread.queue || thread.name || ''}`,
                      ...(thread.frames || []).map((frame, frameIndex) => `${frameIndex.toString().padStart(2, ' ')} ${frame.image || ''} ${frame.symbol || ''}`),
                    ].join('\n')}
                  </pre>
                ))}
              </Space>
            ) : (
              <Text type="secondary">未发现明显同步等待线程。</Text>
            ),
          },
          {
            key: 'suggestions',
            label: '排查建议',
            children: (
              <Space direction="vertical" size={4}>
                {(hang.suggestions || []).map((item) => (
                  <Text key={item} type="secondary">{item}</Text>
                ))}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color={analysisSeverityColor(analysis.severity)}>{analysis.severity || 'unknown'}</Tag>
        <Tag>崩溃 {analysis.crashCount || 0}</Tag>
        <Tag>异常 {analysis.exceptionCount || 0}</Tag>
        <Tag>卡死/Watchdog {analysis.watchdogCount || 0}</Tag>
        <Tag>内存问题 {analysis.memoryIssueCount || 0}</Tag>
        <Tag>错误日志 {analysis.errorCount || 0}</Tag>
      </Space>
      {(analysis.crashReports?.count || 0) > 0 ? (
        <Alert
          showIcon
          type="error"
          message={`发现 ${crashFiles.length || analysis.crashReports?.count || 0} 个崩溃文件`}
          description={(
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {crashFiles.slice(0, 5).map((file) => {
                const autoHangAnalysis = autoHangAnalysisByFile.get(file);
                return (
                  <Space key={file} direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space size={8} wrap>
                      <Text type="secondary" style={{ fontSize: 12 }}>{file}</Text>
                      {crashFileUrl(file) && (
                        <Button size="small" type="link" onClick={() => downloadCrashIps(file)}>
                          下载 ips
                        </Button>
                      )}
                      {autoHangAnalysis ? (
                        <Tag color="green">已自动解析</Tag>
                      ) : (
                        <Button
                          size="small"
                          type="link"
                          disabled={!crashFileUrl(file)}
                          loading={symbolicationByFile[file]?.loading}
                          onClick={() => handleSymbolicateCrash(file)}
                        >
                          符号化解析
                        </Button>
                      )}
                    </Space>
                    {autoHangAnalysis && renderHangStackAnalysis(autoHangAnalysis)}
                    {!autoHangAnalysis && symbolicationByFile[file]?.error && (
                      <Alert showIcon type="warning" message={symbolicationByFile[file]?.error} />
                    )}
                    {!autoHangAnalysis && symbolicationByFile[file]?.result && (
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Space wrap>
                          {symbolicationByFile[file]?.metadata?.appName && <Tag>{symbolicationByFile[file]?.metadata?.appName}</Tag>}
                          {symbolicationByFile[file]?.metadata?.version && <Tag color="purple">版本 {symbolicationByFile[file]?.metadata?.version}</Tag>}
                          {symbolicationByFile[file]?.metadata?.bundleId && <Tag>{symbolicationByFile[file]?.metadata?.bundleId}</Tag>}
                          <Tag color={symbolicationByFile[file]?.matchType === 'uuid' ? 'green' : 'blue'}>
                            dSYM {symbolicationByFile[file]?.usedUUIDs?.length || 0} 个
                          </Tag>
                          {symbolicationByFile[file]?.result?.fromHistory && <Tag color="cyan">历史结果</Tag>}
                          {symbolicationByFile[file]?.result?.fromCache && <Tag color="cyan">缓存结果</Tag>}
                        </Space>
                        {symbolicationByFile[file]?.result?.warning && (
                          <Alert showIcon type="warning" message={symbolicationByFile[file]?.result?.warning} />
                        )}
                        <SymbolicatedCrashAnalysisDigest
                          analysis={symbolicationByFile[file]?.result?.aiAnalysis || symbolicationByFile[file]?.result?.analysis}
                        />
                        <Collapse
                          size="small"
                          items={[
                            {
                              key: 'symbolicated-log',
                              label: '查看符号化日志',
                              children: (
                                <pre style={{ margin: 0, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5, background: '#fafafa', padding: 12, border: '1px solid #f0f0f0', borderRadius: 4 }}>
                                  {tailLines(symbolicationByFile[file]?.result?.symbolicatedLog || '', 180)}
                                </pre>
                              ),
                            },
                          ]}
                        />
                      </Space>
                    )}
                  </Space>
                );
              })}
            </Space>
          )}
        />
      ) : (
        <Alert showIcon type="success" message="未发现崩溃报告" />
      )}
      {logSamples.length > 0 && (
        <Space direction="vertical" size={4}>
          {logSamples.slice(0, 5).map((sample, index) => (
            <Text key={`${sample.type || 'sample'}-${index}`} type="secondary" style={{ fontSize: 12 }}>
              [{sample.type || 'log'}] {sample.message}
            </Text>
          ))}
        </Space>
      )}
    </Space>
  );
}
