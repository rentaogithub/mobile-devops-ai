import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Typography, Card, Table, Tag, Space, Button, Input, Modal, Form,
  Upload, message, Drawer, Descriptions, Tooltip, Badge, List, Empty, Select, Tabs, Checkbox, Popconfirm, Progress,
} from 'antd';
import {
  AppstoreOutlined, SearchOutlined, PlusOutlined, SyncOutlined,
  UploadOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined,
  CopyOutlined, CheckCircleOutlined, CloseCircleOutlined, CloudUploadOutlined,
  RightOutlined, EditOutlined, SaveOutlined, DownloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { jenkinsApi, podsApi, PodComponent, NNRtcJenkinsBuild, NNRtcJenkinsConfig, NNRtcPodTask, LeigodIMSDKVersion } from '../services/api';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;
const NNRTC_JENKINS_JOB_URL_FALLBACK = 'http://10.1.2.175:8080/job/nnrtc-ios-build/';

interface ComponentGroup {
  name: string;
  versions: PodComponent[];
  latestVersion: string;
  totalVersions: number;
  latestStatus: string;
  latestTime: string;
  isInternal: boolean;
}

function isReleaseBranch(branch: string) {
  return /^release\/\d+(?:\.\d+){2,}$/.test(branch);
}

function compareReleaseBranches(a: string, b: string) {
  const parse = (branch: string) =>
    (branch.match(/^release\/(\d+(?:\.\d+){2,})$/)?.[1] || '')
      .split('.')
      .map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function isNNRtcReleaseBuildBranch(branch?: string) {
  return /^release[_/]\d+(?:\.\d+){2,}$/.test(String(branch || ''));
}

function getNNRtcReleaseVersion(branch?: string) {
  return String(branch || '').match(/^release[_/](\d+(?:\.\d+){2,})$/)?.[1] || '';
}

function isNNRtcTestVersion(version?: string) {
  return /(?:_test|-test)$/.test(String(version || ''));
}

function buildNNRtcTestVersion(version: string) {
  return `${version}-test`;
}

function compareVersionText(a: string, b: string) {
  const parse = (version: string) => version
    .replace(/(?:_test|-test)$/, '')
    .split('.')
    .map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function buildNniosBranchOptions(branches: string[]) {
  const releaseBranches = branches.filter(isReleaseBranch);
  const latestRelease = releaseBranches.sort(compareReleaseBranches)[releaseBranches.length - 1];
  return branches.filter((branch) => !isReleaseBranch(branch) || branch === latestRelease);
}

function formatBuildTime(timestamp?: number) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNNRtcBuildLabel(build: NNRtcJenkinsBuild) {
  const time = formatBuildTime(build.timestamp);
  return `#${build.number}${build.branchName ? ` ${build.branchName}` : ''}${time ? ` ${time}` : ''}`;
}

function normalizeNNRtcBuildId(buildId?: string | number) {
  return String(buildId || '').trim().replace(/^#+/, '').trim();
}

function getNNRtcJenkinsJobUrl(config?: NNRtcJenkinsConfig | null) {
  return config?.jobUrl || NNRTC_JENKINS_JOB_URL_FALLBACK;
}

function buildNNRtcJenkinsBuildUrl(jobUrl: string, buildId: string | number) {
  const normalizedBuildId = normalizeNNRtcBuildId(buildId);
  if (!normalizedBuildId) return jobUrl;
  return `${jobUrl.replace(/\/$/, '')}/${encodeURIComponent(normalizedBuildId)}/`;
}

function supportsNniosBuildTask(name?: string) {
  const normalized = String(name || '').trim();
  return normalized === 'NNRtc' || normalized === 'leigod_im_cross_sdk';
}

function isLeigodIMCrossSDK(name?: string) {
  return String(name || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '') === 'leigod_im_cross_sdk';
}

function isLeigodIMComponent(component?: PodComponent | null) {
  if (!component) return false;
  return isLeigodIMCrossSDK(component.name) ||
    String(component.source_zip_url || '').includes('/leigod_im_cross_sdk/') ||
    String(component.podspec_content || '').includes("s.name         = 'leigod_im_cross_sdk'");
}

function isInternalComponent(component?: PodComponent | null) {
  if (!component) return false;
  if (isLeigodIMComponent(component)) return true;
  return String(component.name || '').trim() === 'NNRtc';
}

function isOfficialComponent(component?: PodComponent | null) {
  return !isInternalComponent(component);
}

export default function PodsPage() {
  const [components, setComponents] = useState<PodComponent[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [selectedComponent, setSelectedComponent] = useState<PodComponent | null>(null);
  const [editingPodspec, setEditingPodspec] = useState(false);
  const [podspecDraft, setPodspecDraft] = useState('');
  const [savingPodspec, setSavingPodspec] = useState(false);
  const [replacingZip, setReplacingZip] = useState(false);
  const [form] = Form.useForm();
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [officialName, setOfficialName] = useState('');
  const [officialVersions, setOfficialVersions] = useState<string[]>([]);
  const [officialVersion, setOfficialVersion] = useState<string>('');
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [importing, setImporting] = useState(false);
  const [buildBinary, setBuildBinary] = useState(false);
  const [buildOutputType, setBuildOutputType] = useState<string>('framework');
  const [dependencies, setDependencies] = useState<Array<{
    name: string;
    versionRequirement: string;
    existsInInternal: boolean;
    internalVersions: string[];
    officialVersions: string[];
  }>>([]);
  const [checkingDeps, setCheckingDeps] = useState(false);
  const [depSelectedVersions, setDepSelectedVersions] = useState<Record<string, string>>({});
  const [depPublishing, setDepPublishing] = useState<Record<string, boolean>>({});
  const [availableSubspecs, setAvailableSubspecs] = useState<string[]>([]);
  const [selectedSubspecs, setSelectedSubspecs] = useState<string[]>([]);
  const [internalVersion, setInternalVersion] = useState<string>('');
  const [prepareCommand, setPrepareCommand] = useState<string>('');
  const [officialTargetBranch, setOfficialTargetBranch] = useState<string>('develop');
  const [officialTriggerNniosBuild, setOfficialTriggerNniosBuild] = useState(false);
  const [publishTabKey, setPublishTabKey] = useState<string>('local');
  const [nniosBranches, setNniosBranches] = useState<string[]>([]);
  const [nniosBranchLoading, setNniosBranchLoading] = useState(false);
  const [detailTargetBranch, setDetailTargetBranch] = useState<string>('develop');
  const [detailJenkinsBuildNumber, setDetailJenkinsBuildNumber] = useState('');
  const [detailTriggerNniosBuild, setDetailTriggerNniosBuild] = useState(false);
  const [nnrtcBuilds, setNnrtcBuilds] = useState<NNRtcJenkinsBuild[]>([]);
  const [nnrtcJenkinsConfig, setNnrtcJenkinsConfig] = useState<NNRtcJenkinsConfig | null>(null);
  const [nnrtcBuildLoading, setNnrtcBuildLoading] = useState(false);
  const [leigodIMSDKVersions, setLeigodIMSDKVersions] = useState<LeigodIMSDKVersion[]>([]);
  const [leigodIMSDKLoading, setLeigodIMSDKLoading] = useState(false);
  const [nnrtcTaskModalOpen, setNnrtcTaskModalOpen] = useState(false);
  const [nnrtcTask, setNnrtcTask] = useState<NNRtcPodTask | null>(null);
  const nnrtcTaskContextRef = useRef<{
    action: 'publish' | 'replace';
    name: string;
    version: string;
    targetBranch: string;
    triggerNniosBuild: boolean;
  } | null>(null);
  const nnrtcHandledTasksRef = useRef<Set<string>>(new Set());
  const nnrtcBuildTriggeredTasksRef = useRef<Set<string>>(new Set());
  const publishName = Form.useWatch('name', form);
  const nnrtcPackageType = Form.useWatch('nnrtc_package_type', form) || 'release';
  const nnrtcTestSource = Form.useWatch('nnrtc_test_source', form) || 'jenkins';
  const nnrtcBuildNumber = Form.useWatch('nnrtc_build_number', form);
  const leigodIMSDKVersion = Form.useWatch('leigod_im_sdk_version', form);
  const isNNRtcPublish = publishName === 'NNRtc';
  const isLeigodIMPublish = isLeigodIMCrossSDK(publishName);
  const nnrtcUseUpload = isNNRtcPublish && nnrtcPackageType === 'test' && nnrtcTestSource === 'upload';
  const nnrtcUseJenkins = isNNRtcPublish && (nnrtcPackageType !== 'test' || nnrtcTestSource !== 'upload');
  const showPublishNniosBuildTask = supportsNniosBuildTask(publishName);
  const selectedIsOfficial = isOfficialComponent(selectedComponent);
  const selectedNNRtcPackageType = selectedComponent?.name === 'NNRtc'
    ? (selectedComponent.package_type || (isNNRtcTestVersion(selectedComponent.version) ? 'test' : 'release'))
    : undefined;
  const detailNNRtcBuilds = useMemo(() => (
    nnrtcBuilds.filter((build) => selectedNNRtcPackageType === 'release'
      ? isNNRtcReleaseBuildBranch(build.branchName)
      : !isNNRtcReleaseBuildBranch(build.branchName))
  ), [nnrtcBuilds, selectedNNRtcPackageType]);

  // 检查是否是管理员
  const isAdmin = authUtils.isAdmin();

  const loadNniosBranches = useCallback(async (): Promise<string[]> => {
    if (!isAdmin) return [];
    setNniosBranchLoading(true);
    try {
      const res = await jenkinsApi.listBranches();
      const branches = buildNniosBranchOptions(res.data || []);
      setNniosBranches(branches);
      if (!form.getFieldValue('target_branch')) {
        form.setFieldValue('target_branch', branches.includes('develop') ? 'develop' : branches[0]);
      }
      if (!officialTargetBranch || !branches.includes(officialTargetBranch)) {
        setOfficialTargetBranch(branches.includes('develop') ? 'develop' : branches[0]);
      }
      return branches;
    } catch (error: any) {
      message.warning(error?.error || error?.message || '加载 nnios 分支失败，请稍后重试');
      return [];
    } finally {
      setNniosBranchLoading(false);
    }
  }, [form, isAdmin, officialTargetBranch]);

  const loadNNRtcBuilds = useCallback(async () => {
    if (!isAdmin) return;
    setNnrtcBuildLoading(true);
    try {
      const [configRes, res] = await Promise.all([
        podsApi.getNNRtcJenkinsConfig(),
        podsApi.listNNRtcJenkinsBuilds(),
      ]);
      if (configRes.success && configRes.data) {
        setNnrtcJenkinsConfig(configRes.data);
      }
      const builds = res.data || [];
      setNnrtcBuilds(builds);
      if (!form.getFieldValue('nnrtc_build_number') && builds.length > 0) {
        form.setFieldValue('nnrtc_build_number', String(builds[0].number));
      } else if (builds.length === 0) {
        form.setFieldValue('nnrtc_build_number', undefined);
      }
      if (!detailJenkinsBuildNumber && builds.length > 0) {
        setDetailJenkinsBuildNumber(String(builds[0].number));
      }
    } catch (error: any) {
      message.warning(error?.error || error?.message || '加载 NNRtc Jenkins 构建号失败');
    } finally {
      setNnrtcBuildLoading(false);
    }
  }, [detailJenkinsBuildNumber, form, isAdmin]);

  const loadLeigodIMSDKVersions = useCallback(async () => {
    if (!isAdmin) return;
    setLeigodIMSDKLoading(true);
    try {
      const res = await podsApi.listLeigodIMSDKVersions();
      const versions = res.data || [];
      setLeigodIMSDKVersions(versions);
      const current = form.getFieldValue('leigod_im_sdk_version');
      const next = versions.some((item) => item.version === current)
        ? current
        : versions[0]?.version;
      if (next) {
        form.setFieldsValue({
          leigod_im_sdk_version: next,
          version: next,
        });
      }
    } catch (error: any) {
      message.warning(error?.error || error?.message || '加载 IMSDK 版本失败');
    } finally {
      setLeigodIMSDKLoading(false);
    }
  }, [form, isAdmin]);

  const fetchComponents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await podsApi.list();
      if (res.success) {
        setComponents(res.data || []);
      }
    } catch (error: any) {
      message.error(error?.error || '获取组件列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchComponents();
  }, [fetchComponents]);

  useEffect(() => {
    if (publishModalOpen && isAdmin) {
      loadNniosBranches();
    }
  }, [isAdmin, loadNniosBranches, publishModalOpen]);

  useEffect(() => {
    if (publishModalOpen && publishTabKey === 'local' && isNNRtcPublish) {
      setUploadFile(null);
      loadNNRtcBuilds();
    }
  }, [isNNRtcPublish, loadNNRtcBuilds, publishModalOpen, publishTabKey]);

  useEffect(() => {
    if (publishModalOpen && publishTabKey === 'local' && isLeigodIMPublish) {
      setUploadFile(null);
      loadLeigodIMSDKVersions();
    }
  }, [isLeigodIMPublish, loadLeigodIMSDKVersions, publishModalOpen, publishTabKey]);

  useEffect(() => {
    if (detailDrawerOpen && isAdmin) {
      loadNniosBranches();
    }
  }, [detailDrawerOpen, isAdmin, loadNniosBranches]);

  useEffect(() => {
    if (detailDrawerOpen && selectedComponent?.name === 'NNRtc') {
      loadNNRtcBuilds();
    }
  }, [detailDrawerOpen, loadNNRtcBuilds, selectedComponent?.name]);

  useEffect(() => {
    if (!detailDrawerOpen || selectedComponent?.name !== 'NNRtc') return;
    const currentInOptions = detailNNRtcBuilds.some((build) => String(build.number) === detailJenkinsBuildNumber);
    if (!currentInOptions) {
      setDetailJenkinsBuildNumber(detailNNRtcBuilds[0] ? String(detailNNRtcBuilds[0].number) : '');
    }
  }, [detailDrawerOpen, detailJenkinsBuildNumber, detailNNRtcBuilds, selectedComponent?.name]);

  const triggerNniosBuildTask = useCallback(async (branch: string) => {
    const targetBranch = branch.trim();
    if (!targetBranch) {
      message.warning('未选择 nnios 分支，已跳过 nnios 构建任务');
      return;
    }
    await jenkinsApi.publishNN({
      deployTarget: 'Pgyer',
      branch: targetBranch,
    });
    message.success(`已触发 nnios/${targetBranch} 构建任务`);
  }, []);

  const startNNRtcTaskPolling = useCallback((task: NNRtcPodTask, context: {
    action: 'publish' | 'replace';
    name: string;
    version: string;
    targetBranch: string;
    triggerNniosBuild: boolean;
  }) => {
    nnrtcTaskContextRef.current = context;
    nnrtcHandledTasksRef.current.delete(task.id);
    setNnrtcTask(task);
    setNnrtcTaskModalOpen(true);
  }, []);

  useEffect(() => {
    if (!nnrtcTaskModalOpen || !nnrtcTask || ['success', 'failed'].includes(nnrtcTask.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const res = await podsApi.getNNRtcTask(nnrtcTask.id);
        if (!res.data) return;
        setNnrtcTask(res.data);
        if (res.data.status === 'success') {
          if (nnrtcHandledTasksRef.current.has(res.data.id)) return;
          nnrtcHandledTasksRef.current.add(res.data.id);
          const context = nnrtcTaskContextRef.current;
          if (res.warning || res.data.warning) {
            message.warning(res.warning || res.data.warning);
          } else {
            message.success(context?.action === 'replace' ? 'NNRtc 替换完成' : 'NNRtc 发布完成');
          }
          if (context?.action === 'publish') {
            setPublishModalOpen(false);
            form.resetFields();
            setUploadFile(null);
            setSelectedName(context.name);
          }
          if (context?.action === 'replace' && res.data.data) {
            setSelectedComponent(res.data.data);
            setPodspecDraft(res.data.data.podspec_content);
            setDetailJenkinsBuildNumber('');
          }
          fetchComponents();
          if (context?.triggerNniosBuild && !nnrtcBuildTriggeredTasksRef.current.has(res.data.id)) {
            nnrtcBuildTriggeredTasksRef.current.add(res.data.id);
            try {
              await triggerNniosBuildTask(context.targetBranch);
            } catch (error: any) {
              message.error(error?.error || error?.message || '触发 nnios 构建任务失败');
            }
          }
        } else if (res.data.status === 'failed') {
          if (nnrtcHandledTasksRef.current.has(res.data.id)) return;
          nnrtcHandledTasksRef.current.add(res.data.id);
          message.error(res.data.error || 'NNRtc 任务失败');
        }
      } catch (error: any) {
        message.error(error?.error || '查询 NNRtc 任务失败');
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [fetchComponents, form, nnrtcTask, nnrtcTaskModalOpen, triggerNniosBuildTask]);

  // 按组件名称分组
  const groups: ComponentGroup[] = useMemo(() => {
    const map = new Map<string, PodComponent[]>();
    components.forEach((c) => {
      const list = map.get(c.name) || [];
      list.push(c);
      map.set(c.name, list);
    });

    return Array.from(map.entries())
      .map(([name, versions]) => {
        // 按时间倒序
        versions.sort((a, b) => new Date(b.upload_time).getTime() - new Date(a.upload_time).getTime());
        const latest = versions[0];
        return {
          name,
          versions,
          latestVersion: latest.version,
          totalVersions: versions.length,
          latestStatus: latest.status,
          latestTime: latest.upload_time,
          isInternal: isInternalComponent(latest),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [components]);

  const filteredGroups = useMemo(() => {
    if (!searchText) return groups;
    const lower = searchText.toLowerCase();
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(lower) ||
        g.versions.some((v) => v.version.includes(searchText))
    );
  }, [groups, searchText]);

  // 当前选中组件的版本列表
  const selectedGroup = useMemo(() => {
    if (!selectedName) return null;
    return groups.find((g) => g.name === selectedName) || null;
  }, [groups, selectedName]);

  const nnrtcPublishBuilds = useMemo(() => (
    nnrtcBuilds.filter((build) => nnrtcPackageType === 'release'
      ? isNNRtcReleaseBuildBranch(build.branchName)
      : !isNNRtcReleaseBuildBranch(build.branchName))
  ), [nnrtcBuilds, nnrtcPackageType]);

  const latestNNRtcReleaseVersion = useMemo(() => {
    const versions = components
      .filter((item) => item.name === 'NNRtc' && !isNNRtcTestVersion(item.version))
      .map((item) => item.version)
      .filter((version) => /^\d+(?:\.\d+){2,}$/.test(version));
    return versions.sort(compareVersionText).at(-1) || '';
  }, [components]);

  useEffect(() => {
    if (!isNNRtcPublish) return;
    if (!form.getFieldValue('nnrtc_package_type')) {
      form.setFieldValue('nnrtc_package_type', 'release');
    }

    if (nnrtcPackageType === 'test') {
      if (!form.getFieldValue('nnrtc_test_source')) {
        form.setFieldValue('nnrtc_test_source', 'jenkins');
      }
      const nextVersion = latestNNRtcReleaseVersion ? buildNNRtcTestVersion(latestNNRtcReleaseVersion) : '';
      if (nnrtcTestSource === 'upload' && form.getFieldValue('nnrtc_build_number')) {
        form.setFieldValue('nnrtc_build_number', undefined);
      }
      if (form.getFieldValue('version') !== nextVersion) {
        form.setFieldValue('version', nextVersion);
      }
      if (nnrtcTestSource === 'upload') return;
    }

    const currentBuild = String(nnrtcBuildNumber || form.getFieldValue('nnrtc_build_number') || '');
    const currentInOptions = nnrtcPublishBuilds.some((build) => String(build.number) === currentBuild);
    const nextBuild = currentInOptions ? currentBuild : (nnrtcPublishBuilds[0] ? String(nnrtcPublishBuilds[0].number) : undefined);
    if (nextBuild !== currentBuild) {
      form.setFieldValue('nnrtc_build_number', nextBuild);
    }

    const selectedBuild = nnrtcPublishBuilds.find((build) => String(build.number) === (nextBuild || currentBuild));
    const nextVersion = nnrtcPackageType === 'release'
      ? getNNRtcReleaseVersion(selectedBuild?.branchName)
      : (latestNNRtcReleaseVersion ? buildNNRtcTestVersion(latestNNRtcReleaseVersion) : '');
    if (form.getFieldValue('version') !== nextVersion) {
      form.setFieldValue('version', nextVersion);
    }
  }, [form, isNNRtcPublish, latestNNRtcReleaseVersion, nnrtcBuildNumber, nnrtcPackageType, nnrtcPublishBuilds, nnrtcTestSource]);

  useEffect(() => {
    if (!isLeigodIMPublish) return;
    const selected = String(leigodIMSDKVersion || form.getFieldValue('leigod_im_sdk_version') || '');
    if (selected && form.getFieldValue('version') !== selected) {
      form.setFieldValue('version', selected);
    }
  }, [form, isLeigodIMPublish, leigodIMSDKVersion]);

  // 自动选中第一个
  useEffect(() => {
    if (!selectedName && filteredGroups.length > 0) {
      setSelectedName(filteredGroups[0].name);
    }
    // 如果当前选中的被过滤掉了，切换到第一个
    if (selectedName && !filteredGroups.find((g) => g.name === selectedName)) {
      setSelectedName(filteredGroups.length > 0 ? filteredGroups[0].name : null);
    }
  }, [filteredGroups, selectedName]);

  const doPublish = async (values: any, file?: File) => {
    setPublishing(true);
    const shouldTriggerNniosBuild = supportsNniosBuildTask(values.name) && Boolean(values.trigger_nnios_build);
    try {
      if (values.name === 'NNRtc' && values.nnrtc_test_source !== 'upload') {
        const taskRes = await podsApi.startNNRtcPublishTask({
            build_number: values.nnrtc_build_number,
            version: values.version,
            package_type: values.nnrtc_package_type === 'test' ? 'test' : 'release',
            sys_frameworks: values.sys_frameworks,
            sys_libraries: values.sys_libraries,
            target_branch: values.target_branch,
        });
        if (taskRes.success && taskRes.data) {
          startNNRtcTaskPolling(taskRes.data, {
            action: 'publish',
            name: values.name,
            version: values.version,
            targetBranch: values.target_branch,
            triggerNniosBuild: shouldTriggerNniosBuild,
          });
          message.success('NNRtc 发布任务已开始');
        }
        return;
      }

      if (isLeigodIMCrossSDK(values.name)) {
        const res = await podsApi.publishLeigodIMFromIMSDK({
          version: values.version,
          sys_frameworks: values.sys_frameworks,
          sys_libraries: values.sys_libraries,
          target_branch: values.target_branch,
        });
        if (res.success) {
          if (res.warning) {
            message.warning(res.warning);
          } else if (res.data?.status === 'published') {
            message.success(`${values.name}@${values.version} 发布成功`);
          } else {
            message.warning(res.data?.error_message || '组件已上传，但后续同步失败，可稍后重试');
          }
          setPublishModalOpen(false);
          form.resetFields();
          setUploadFile(null);
          setSelectedName(values.name);
          fetchComponents();
          if (shouldTriggerNniosBuild) {
            try {
              await triggerNniosBuildTask(values.target_branch);
            } catch (error: any) {
              message.error(error?.error || error?.message || '触发 nnios 构建任务失败');
            }
          }
        }
        return;
      }

      const res = await podsApi.publish(file!, {
            name: values.name,
            version: values.version,
            lib_type: values.lib_type,
            lib_name: values.lib_name,
            sys_frameworks: values.sys_frameworks,
            sys_libraries: values.sys_libraries,
            target_branch: values.target_branch,
            package_type: values.name === 'NNRtc'
              ? (values.nnrtc_package_type === 'test' || isNNRtcTestVersion(values.version) ? 'test' : 'release')
              : undefined,
      });
      if (res.success) {
        if (res.warning) {
          message.warning(res.warning);
        } else if (res.data?.status === 'published') {
          message.success(`${values.name}@${values.version} 发布成功`);
        } else {
          message.warning(res.data?.error_message || '组件已上传，但后续同步失败，可稍后重试');
        }
        setPublishModalOpen(false);
        form.resetFields();
        setUploadFile(null);
        setSelectedName(values.name);
        fetchComponents();
        if (shouldTriggerNniosBuild) {
          try {
            await triggerNniosBuildTask(values.target_branch);
          } catch (error: any) {
            message.error(error?.error || error?.message || '触发 nnios 构建任务失败');
          }
        }
      }
    } catch (error: any) {
      message.error(error?.error || error?.message || '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const handlePublish = async () => {
    try {
      const values = await form.validateFields();
      if (!isLeigodIMCrossSDK(values.name) && (values.name !== 'NNRtc' || values.nnrtc_test_source === 'upload') && !uploadFile) {
        message.error(values.name === 'NNRtc' ? '请选择 zip/tgz 文件' : '请选择 zip 文件');
        return;
      }

      const targetBranch = values.target_branch || 'develop';
      const sourceText = values.name === 'NNRtc'
        ? (values.nnrtc_test_source === 'upload' ? uploadFile?.name : `Jenkins 构建 #${values.nnrtc_build_number}`)
        : isLeigodIMCrossSDK(values.name)
          ? `IMSDK/${values.leigod_im_sdk_version || values.version}`
          : uploadFile?.name;
      const shouldTriggerNniosBuild = supportsNniosBuildTask(values.name) && Boolean(values.trigger_nnios_build);
      let confirmBranch = '';
      Modal.confirm({
        title: `${values.name}@${values.version} 发布确认`,
        content: (
          <div>
            <p>
              将发布组件 <Text strong code>{values.name}@{values.version}</Text>，
              并同步到 nnios 分支 <Text strong code>{targetBranch}</Text>。
            </p>
            <p>发布来源：<Text strong code>{sourceText}</Text></p>
            {shouldTriggerNniosBuild && (
              <p>发布成功后会触发 nnios/<Text strong code>{targetBranch}</Text> 的构建任务。</p>
            )}
            <p>
              请再次输入 nnios 目标分支 <Text strong code>{targetBranch}</Text> 确认：
            </p>
            <Input
              placeholder={`请输入 ${targetBranch}，不是版本号`}
              onChange={(e) => { confirmBranch = e.target.value.trim(); }}
            />
          </div>
        ),
        okText: '确认发布',
        cancelText: '取消',
        onOk: async () => {
          if (confirmBranch !== targetBranch) {
            message.error(`nnios 目标分支输入不匹配，请输入 ${targetBranch}`);
            return Promise.reject();
          }
          await doPublish(values, uploadFile || undefined);
        },
      });
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.error || error?.message || '发布失败');
    }
  };

  const handleRetry = async (record: PodComponent, targetBranch: string) => {
    if (!targetBranch) {
      message.error('请选择 nnios 分支');
      return;
    }
    try {
      const res = await podsApi.retry(record.name, record.version, targetBranch);
      if (res.data?.status === 'failed') {
        message.warning(res.data.error_message || 'Spec 已同步，但 nnios 分支同步失败');
      } else {
        message.success('同步成功');
      }
      if (selectedComponent?.name === record.name && selectedComponent.version === record.version && res.data) {
        setSelectedComponent(res.data);
      }
      fetchComponents();
    } catch (error: any) {
      message.error(error?.error || '重试失败');
    }
  };

  const handleSyncBranch = async (record: PodComponent) => {
    const branches = nniosBranches.length > 0 ? nniosBranches : await loadNniosBranches();
    let targetBranch = detailTargetBranch || (branches.includes('develop') ? 'develop' : branches[0] || '');
    let confirmBranch = '';
    Modal.confirm({
      title: `同步 ${record.name}@${record.version}`,
      content: (
        <div>
          <p>
            将把当前组件版本写入指定 nnios 分支的 <Text code>NNIM/third_sdk.rb</Text>。
          </p>
          <p>请选择要同步的分支：</p>
          <Select
            showSearch
            defaultValue={targetBranch || undefined}
            loading={nniosBranchLoading}
            style={{ width: '100%' }}
            placeholder="选择 nnios 分支"
            options={branches.map((branch) => ({ value: branch, label: branch }))}
            onChange={(value) => { targetBranch = value; }}
          />
          <p style={{ marginTop: 12 }}>
            请再次输入 nnios 目标分支 <Text strong code>{targetBranch || '上方选择的分支'}</Text> 确认：
          </p>
          <Input
            placeholder={targetBranch ? `请输入 ${targetBranch}` : '请输入上方选择的分支'}
            onChange={(e) => { confirmBranch = e.target.value.trim(); }}
          />
        </div>
      ),
      okText: '同步',
      cancelText: '取消',
      onOk: async () => {
        if (!targetBranch) {
          message.error('请输入要同步的分支');
          return Promise.reject();
        }
        if (confirmBranch !== targetBranch) {
          message.error(`nnios 目标分支输入不匹配，请输入 ${targetBranch}`);
          return Promise.reject();
        }
        try {
          const res = await podsApi.syncBranch(record.name, record.version, targetBranch);
          if (res.success) {
            message.success(`已同步到 nnios/${targetBranch}`);
            fetchComponents();
          }
        } catch (error: any) {
          message.error(error?.error || '同步失败');
          return Promise.reject();
        }
      },
    });
  };

  const handleSyncIntegratedBranch = async (record: PodComponent) => {
    const targetBranch = record.nnios_branch || detailTargetBranch;
    if (!targetBranch) {
      message.error('当前测试包没有记录 nnios 集成分支，请重新发布或先选择分支同步一次');
      return;
    }
    try {
      const res = await podsApi.syncBranch(record.name, record.version, targetBranch);
      if (res.success) {
        message.success(`已同步到 nnios/${targetBranch}`);
        if (res.data) {
          setSelectedComponent(res.data);
          setDetailTargetBranch(res.data.nnios_branch || targetBranch);
        }
        fetchComponents();
      }
    } catch (error: any) {
      message.error(error?.error || '同步失败');
    }
  };

  const handleDelete = async (record: PodComponent) => {
    const isNNRtcTestPackage = record.name === 'NNRtc' && (record.package_type === 'test' || isNNRtcTestVersion(record.version));
    const branches = isNNRtcTestPackage ? [] : (nniosBranches.length > 0 ? nniosBranches : await loadNniosBranches());
    const branchOptions = branches.length > 0 ? branches : ['develop'];
    let confirmText = '';
    let targetBranch = isNNRtcTestPackage
      ? (record.nnios_branch || detailTargetBranch)
      : (detailTargetBranch && branchOptions.includes(detailTargetBranch)
        ? detailTargetBranch
        : (branchOptions.includes('develop') ? 'develop' : branchOptions[0]));
    let confirmBranch = '';
    Modal.confirm({
      title: `删除版本 ${record.name}@${record.version}`,
      content: (
        <div>
          <p>将同时删除 Nexus 上的 zip 文件，此操作不可恢复。</p>
          <p>如果 nnios 目标分支正在引用该版本，会自动回退到此组件剩余的最新版本。</p>
          {record.name === 'NNRtc' && (
            <p>将同时删除 dSYM 管理中的 <Text strong code>NNRtc@{record.version}</Text> 符号文件。</p>
          )}
          {isNNRtcTestPackage ? (
            <div style={{ marginBottom: 12 }}>
              <Text strong>nnios 目标分支</Text>
              <div style={{ marginTop: 6 }}>
                {targetBranch ? <Tag color="blue">{targetBranch}</Tag> : <Text type="secondary">未记录</Text>}
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <Text strong>nnios 目标分支</Text>
              <Select
                showSearch
                defaultValue={targetBranch}
                style={{ width: '100%', marginTop: 6 }}
                options={branchOptions.map((branch) => ({ value: branch, label: branch }))}
                onChange={(value) => { targetBranch = value; }}
              />
            </div>
          )}
          <p>请输入版本号 <Text strong code>{record.version}</Text> 确认删除：</p>
          <Input
            placeholder={record.version}
            onChange={(e) => { confirmText = e.target.value; }}
          />
          {!isNNRtcTestPackage && (
            <>
              <p style={{ marginTop: 12 }}>
                请再次输入 nnios 目标分支 <Text strong code>{targetBranch}</Text> 确认：
              </p>
              <Input
                placeholder={`请输入 ${targetBranch}`}
                onChange={(e) => { confirmBranch = e.target.value.trim(); }}
              />
            </>
          )}
        </div>
      ),
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (confirmText !== record.version) {
          message.error('版本号输入不匹配，取消删除');
          return Promise.reject();
        }
        if (!targetBranch) {
          message.error('当前测试包没有记录 nnios 集成分支，无法删除');
          return Promise.reject();
        }
        if (!isNNRtcTestPackage && confirmBranch !== targetBranch) {
          message.error(`nnios 目标分支输入不匹配，请输入 ${targetBranch}`);
          return Promise.reject();
        }
        try {
          const res = await podsApi.delete(record.name, record.version, targetBranch);
          if (res.warning || res.data?.warning) {
            message.warning(res.warning || res.data?.warning);
          } else if (res.data?.fallbackVersion) {
            message.success(`删除成功，nnios/${targetBranch} 已回退到 ${record.name}@${res.data.fallbackVersion}`);
          } else {
            message.success('删除成功');
          }
          fetchComponents();
        } catch (error: any) {
          message.error(error?.error || '删除失败');
        }
      },
    });
  };

  // 从 podspec 内容中解析字段，用于预填表单
  const parsePodspecFields = (podspec: string) => {
    const fields: Record<string, string> = {};

    const match = (pattern: RegExp) => {
      const m = podspec.match(pattern);
      return m ? m[1].trim() : undefined;
    };

    // 检测库类型
    if (podspec.includes('vendored_libraries')) {
      fields.lib_type = 'static_library';
      const libName = match(/vendored_libraries\s*=\s*'([^']+)'/);
      if (libName) fields.lib_name = libName;
    } else if (podspec.includes('vendored_frameworks')) {
      fields.lib_type = 'framework';
      const fwName = match(/vendored_frameworks\s*=\s*'([^']+)'/);
      if (fwName) fields.lib_name = fwName;
    }

    // 系统 frameworks
    const fwMatch = podspec.match(/^\s*s\.frameworks\s*=\s*(.+)$/m);
    if (fwMatch) {
      const fws = fwMatch[1].replace(/'/g, '').replace(/,/g, ', ').trim();
      fields.sys_frameworks = fws;
    }

    // 系统 libraries
    const libMatch = podspec.match(/^\s*s\.libraries\s*=\s*(.+)$/m);
    if (libMatch) {
      const libs = libMatch[1].replace(/'/g, '').replace(/,/g, ', ').trim();
      fields.sys_libraries = libs;
    }

    return fields;
  };

  const handleCopyPodspec = (content: string) => {
    navigator.clipboard.writeText(content);
    message.success('Podspec 已复制到剪贴板');
  };

  const handleSavePodspec = async () => {
    if (!selectedComponent) return;
    setSavingPodspec(true);
    try {
      const res = await podsApi.updatePodspec(selectedComponent.name, selectedComponent.version, podspecDraft, detailTargetBranch);
      if (res.success) {
        if (res.data?.status === 'failed') {
          message.warning(res.data.error_message || 'Podspec 已同步，但 nnios 分支同步失败');
        } else {
          message.success('Podspec 更新成功，已同步到远程仓库');
        }
        setSelectedComponent(res.data || { ...selectedComponent, podspec_content: podspecDraft, status: 'published' });
        setEditingPodspec(false);
        fetchComponents();
      }
    } catch (error: any) {
      message.error(error?.error || '更新失败');
    } finally {
      setSavingPodspec(false);
    }
  };

  const handleReplaceZip = async (file: File) => {
    if (!selectedComponent) return;
    setReplacingZip(true);
    try {
      const res = await podsApi.replaceZip(selectedComponent.name, selectedComponent.version, file, detailTargetBranch);
      if (res.success && res.data) {
        if (res.warning) {
          message.warning(res.warning);
        } else if (res.data.status === 'failed') {
          message.warning(res.data.error_message || 'zip 已替换，但 nnios 分支同步失败');
        } else {
          message.success('zip 替换成功，podspec 已更新');
        }
        setSelectedComponent(res.data);
        setPodspecDraft(res.data.podspec_content);
        fetchComponents();
        if (supportsNniosBuildTask(selectedComponent.name) && detailTriggerNniosBuild) {
          try {
            await triggerNniosBuildTask(detailTargetBranch);
          } catch (error: any) {
            message.error(error?.error || error?.message || '触发 nnios 构建任务失败');
          }
        }
      }
    } catch (error: any) {
      message.error(error?.error || '替换失败');
    } finally {
      setReplacingZip(false);
    }
  };

  const confirmReplaceZip = (file: File) => {
    if (!selectedComponent) return;
    let confirmBranch = '';
    Modal.confirm({
      title: `替换 ${selectedComponent.name}@${selectedComponent.version} 的 zip`,
      content: (
        <div>
          <p>
            将替换 Nexus 上的二进制，并同步到 nnios 分支 <Text strong code>{detailTargetBranch}</Text>。
          </p>
          {supportsNniosBuildTask(selectedComponent.name) && detailTriggerNniosBuild && (
            <p>替换成功后会触发 nnios/<Text strong code>{detailTargetBranch}</Text> 的构建任务。</p>
          )}
          <p>
            请再次输入 nnios 目标分支 <Text strong code>{detailTargetBranch}</Text> 确认：
          </p>
          <Input
            placeholder={`请输入 ${detailTargetBranch}`}
            onChange={(e) => { confirmBranch = e.target.value.trim(); }}
          />
        </div>
      ),
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (confirmBranch !== detailTargetBranch) {
          message.error(`nnios 目标分支输入不匹配，请输入 ${detailTargetBranch}`);
          return Promise.reject();
        }
        await handleReplaceZip(file);
      },
    });
  };

  const handleReplaceLeigodIMFromIMSDK = async () => {
    if (!selectedComponent) return;
    setReplacingZip(true);
    try {
      const res = await podsApi.replaceLeigodIMFromIMSDK(selectedComponent.version, detailTargetBranch);
      if (res.success && res.data) {
        if (res.warning) {
          message.warning(res.warning);
        } else if (res.data.status === 'failed') {
          message.warning(res.data.error_message || 'IMSDK 包已替换，但 nnios 分支同步失败');
        } else {
          message.success('IMSDK 包替换成功，podspec 已更新');
        }
        setSelectedComponent(res.data);
        setPodspecDraft(res.data.podspec_content);
        fetchComponents();
        if (detailTriggerNniosBuild) {
          try {
            await triggerNniosBuildTask(detailTargetBranch);
          } catch (error: any) {
            message.error(error?.error || error?.message || '触发 nnios 构建任务失败');
          }
        }
      }
    } catch (error: any) {
      message.error(error?.error || '替换失败');
    } finally {
      setReplacingZip(false);
    }
  };

  const confirmReplaceLeigodIMFromIMSDK = () => {
    if (!selectedComponent) return;
    let confirmBranch = '';
    Modal.confirm({
      title: `从 IMSDK 替换 ${selectedComponent.name}@${selectedComponent.version}`,
      content: (
        <div>
          <p>
            将使用 <Text strong code>smb://192.168.3.30/share/IMSDK/{selectedComponent.version}</Text> 对应版本包，
            提取 leigod_im_cross_sdk.framework 替换 Nexus 二进制。
          </p>
          <p>同步到 nnios 分支 <Text strong code>{detailTargetBranch}</Text>。</p>
          {detailTriggerNniosBuild && (
            <p>替换成功后会触发 nnios/<Text strong code>{detailTargetBranch}</Text> 的构建任务。</p>
          )}
          <p>
            请再次输入 nnios 目标分支 <Text strong code>{detailTargetBranch}</Text> 确认：
          </p>
          <Input
            placeholder={`请输入 ${detailTargetBranch}`}
            onChange={(e) => { confirmBranch = e.target.value.trim(); }}
          />
        </div>
      ),
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (confirmBranch !== detailTargetBranch) {
          message.error(`nnios 目标分支输入不匹配，请输入 ${detailTargetBranch}`);
          return Promise.reject();
        }
        await handleReplaceLeigodIMFromIMSDK();
      },
    });
  };

  const handleReplaceNNRtcFromJenkins = async (buildNumber: string) => {
    if (!selectedComponent) return;
    setReplacingZip(true);
    try {
      const res = await podsApi.startNNRtcReplaceTask(selectedComponent.version, buildNumber, detailTargetBranch);
      if (res.success && res.data) {
        startNNRtcTaskPolling(res.data, {
          action: 'replace',
          name: selectedComponent.name,
          version: selectedComponent.version,
          targetBranch: detailTargetBranch,
          triggerNniosBuild: detailTriggerNniosBuild,
        });
        message.success('NNRtc 替换任务已开始');
      }
    } catch (error: any) {
      message.error(error?.error || '替换失败');
    } finally {
      setReplacingZip(false);
    }
  };

  const confirmReplaceNNRtcFromJenkins = () => {
    if (!selectedComponent) return;
    const buildNumber = detailJenkinsBuildNumber.trim();
    if (!buildNumber) {
      message.error('请输入 Jenkins 构建号');
      return;
    }
    let confirmBranch = '';
    Modal.confirm({
      title: `从 Jenkins 替换 ${selectedComponent.name}@${selectedComponent.version}`,
      content: (
        <div>
          <p>
            将使用 NNRtc Jenkins 构建 <Text strong code>#{buildNumber}</Text> 的 nrt/nrtc.tgz，
            提取 NNRtc.framework 发布，并同步 NNRtc.dSYM。
          </p>
          <p>同步到 nnios 分支 <Text strong code>{detailTargetBranch}</Text>。</p>
          {detailTriggerNniosBuild && (
            <p>替换成功后会触发 nnios/<Text strong code>{detailTargetBranch}</Text> 的构建任务。</p>
          )}
          <p>
            请再次输入 nnios 目标分支 <Text strong code>{detailTargetBranch}</Text> 确认：
          </p>
          <Input
            placeholder={`请输入 ${detailTargetBranch}`}
            onChange={(e) => { confirmBranch = e.target.value.trim(); }}
          />
        </div>
      ),
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (confirmBranch !== detailTargetBranch) {
          message.error(`nnios 目标分支输入不匹配，请输入 ${detailTargetBranch}`);
          return Promise.reject();
        }
        await handleReplaceNNRtcFromJenkins(buildNumber);
      },
    });
  };

  const handleFetchOfficialVersions = async () => {
    if (!officialName.trim()) {
      message.error('请输入官方组件名');
      return;
    }
    setLoadingVersions(true);
    setOfficialVersions([]);
    setOfficialVersion('');
    setDependencies([]);
    setDepSelectedVersions({});
    setAvailableSubspecs([]);
    setSelectedSubspecs([]);
    try {
      const res = await podsApi.officialVersions(officialName.trim());
      if (res.success && res.data) {
        setOfficialVersions(res.data);
        if (res.data.length > 0) {
          const firstVersion = res.data[0];
          setOfficialVersion(firstVersion);
          // 自动触发第一个版本的依赖检查
          setDependencies([]);
          setDepSelectedVersions({});
          setCheckingDeps(true);
          try {
            const depRes = await podsApi.checkDependencies(officialName.trim(), firstVersion);
            if (depRes.success && depRes.data) {
              setDependencies(depRes.data.dependencies);
              setAvailableSubspecs(depRes.data.subspecs || []);
              setSelectedSubspecs(depRes.data.defaultSubspecs?.length > 0 ? depRes.data.defaultSubspecs : depRes.data.subspecs || []);
              const defaults: Record<string, string> = {};
              for (const dep of depRes.data.dependencies) {
                if (dep.existsInInternal && dep.internalVersions.length > 0) {
                  defaults[dep.name] = dep.internalVersions[0];
                } else if (!dep.existsInInternal && dep.officialVersions.length > 0) {
                  defaults[dep.name] = dep.officialVersions[0];
                }
              }
              setDepSelectedVersions(defaults);
            }
          } catch {
            // 忽略
          } finally {
            setCheckingDeps(false);
          }
        }
      }
    } catch (error: any) {
      message.error(error?.error || '获取版本列表失败');
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleImportOfficial = async () => {
    if (!officialName.trim() || !officialVersion) {
      message.error('请选择组件和版本');
      return;
    }
    setImporting(true);
    try {
      const targetBranch = officialTargetBranch || 'develop';
      const shouldTriggerNniosBuild = officialTriggerNniosBuild;
      const res = await podsApi.importOfficial(
        officialName.trim(),
        officialVersion,
        buildBinary,
        buildOutputType,
        depSelectedVersions,
        selectedSubspecs.length > 0 ? selectedSubspecs : undefined,
        internalVersion.trim() || undefined,
        prepareCommand.trim() || undefined,
        targetBranch
      );
      if (res.success) {
        const status = res.data?.status;
        const publishedVer = internalVersion.trim() || officialVersion;
        if (status === 'published') {
          message.success(`${officialName}@${publishedVer} 导入成功，已同步到 nnios/${targetBranch}`);
        } else {
          message.warning(res.data?.error_message || 'Nexus 上传成功，但后续同步失败');
        }
        setPublishModalOpen(false);
        setOfficialName('');
        setOfficialVersions([]);
        setOfficialVersion('');
        setDependencies([]);
        setDepSelectedVersions({});
        setAvailableSubspecs([]);
        setSelectedSubspecs([]);
        setInternalVersion('');
        setPrepareCommand('');
        setOfficialTargetBranch('develop');
        setOfficialTriggerNniosBuild(false);
        setSelectedName(officialName.trim());
        fetchComponents();
        if (status === 'published' && shouldTriggerNniosBuild) {
          try {
            await triggerNniosBuildTask(targetBranch);
          } catch (error: any) {
            message.error(error?.error || error?.message || '触发 nnios 构建任务失败');
          }
        }
      }
    } catch (error: any) {
      message.error(error?.error || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const showDetail = (record: PodComponent) => {
    setSelectedComponent(record);
    setEditingPodspec(false);
    setPodspecDraft(record.podspec_content);
    setDetailTargetBranch(record.nnios_branch || 'develop');
    setDetailJenkinsBuildNumber('');
    setDetailTriggerNniosBuild(false);
    setDetailDrawerOpen(true);
  };

  const statusTag = (status: string) => {
    const config: Record<string, { color: string; icon: React.ReactNode; text: string }> = {
      published: { color: 'green', icon: <CheckCircleOutlined />, text: '已发布' },
      uploaded: { color: 'blue', icon: <CloudUploadOutlined />, text: '已上传' },
      failed: { color: 'red', icon: <CloseCircleOutlined />, text: '失败' },
    };
    const c = config[status] || config.uploaded;
    return <Tag color={c.color} icon={c.icon}>{c.text}</Tag>;
  };

  const versionColumns: ColumnsType<PodComponent> = [
    {
      title: '版本号',
      dataIndex: 'version',
      key: 'version',
      width: 120,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '包类型',
      dataIndex: 'package_type',
      key: 'package_type',
      width: 90,
      render: (_: string | undefined, record) => {
        if (record.name !== 'NNRtc') return <Text type="secondary">-</Text>;
        const type = record.package_type || (isNNRtcTestVersion(record.version) ? 'test' : 'release');
        return <Tag color={type === 'test' ? 'orange' : 'green'}>{type === 'test' ? '测试包' : '正式包'}</Tag>;
      },
    },
    {
      title: '构建ID',
      dataIndex: 'build_id',
      key: 'build_id',
      width: 90,
      render: (buildId: string | undefined, record) => (
        record.name === 'NNRtc' && buildId
          ? (
            <a href={buildNNRtcJenkinsBuildUrl(getNNRtcJenkinsJobUrl(nnrtcJenkinsConfig), buildId)} target="_blank" rel="noopener noreferrer">
              <Text code>#{normalizeNNRtcBuildId(buildId)}</Text>
            </a>
          )
          : <Text type="secondary">-</Text>
      ),
    },
    {
      title: 'nnios 集成分支',
      dataIndex: 'nnios_branch',
      key: 'nnios_branch',
      width: 220,
      render: (branch: string | undefined, record) => {
        const type = record.package_type || (isNNRtcTestVersion(record.version) ? 'test' : 'release');
        if (record.name === 'NNRtc' && type === 'test') {
          return branch ? (
            <Tooltip title={branch}>
              <Tag
                color="blue"
                style={{
                  maxWidth: 190,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  verticalAlign: 'middle',
                }}
              >
                {branch}
              </Tag>
            </Tooltip>
          ) : <Text type="secondary">未记录</Text>;
        }
        return <Text type="secondary">-</Text>;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: statusTag,
    },
    {
      title: 'Nexus 地址',
      dataIndex: 'source_zip_url',
      key: 'url',
      ellipsis: true,
      render: (url: string) => (
        <Tooltip title={url}>
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>{url}</a>
        </Tooltip>
      ),
    },
    {
      title: '发布时间',
      dataIndex: 'upload_time',
      key: 'upload_time',
      width: 170,
      render: (t: string) => <Text type="secondary" style={{ fontSize: 13 }}>{t}</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: isAdmin ? 230 : 80,
      render: (_, record) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => showDetail(record)}>
            详情
          </Button>
          {isAdmin && (
            <>
              {!(record.name === 'NNRtc' && (record.package_type === 'test' || isNNRtcTestVersion(record.version))) && (
                <Button type="link" size="small" icon={<SyncOutlined />} onClick={() => handleSyncBranch(record)}>
                  同步
                </Button>
              )}
              <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)}>
                删除
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <Title level={4} style={{ marginBottom: 4 }}>
            <AppstoreOutlined style={{ marginRight: 8, color: '#52c41a' }} />
            Pods 组件管理
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            上传 zip 组件到 Nexus 仓库，自动生成 podspec 并同步到 spec 仓库
          </Paragraph>
        </div>
        <Space>
          <Button icon={<SyncOutlined />} onClick={fetchComponents} loading={loading}>刷新</Button>
          {isAdmin && <Button type="primary" icon={<PlusOutlined />} onClick={() => { setPublishTabKey('local'); setPublishModalOpen(true); }}>发布组件</Button>}
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 16, minHeight: 500, minWidth: 0 }}>
        {/* 左侧：组件列表 */}
        <Card
          size="small"
          title={<span style={{ fontSize: 14 }}>组件列表 ({filteredGroups.length})</span>}
          style={{ width: 280, flexShrink: 0 }}
          styles={{ body: { padding: 0 } }}
        >
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
            <Input
              placeholder="搜索组件..."
              prefix={<SearchOutlined />}
              size="small"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />
          </div>
          <div style={{ maxHeight: 'calc(100vh - 340px)', overflow: 'auto' }}>
            {filteredGroups.length === 0 ? (
              <Empty description="暂无组件" style={{ padding: '40px 0' }} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <>
                {/* 内部组件 */}
                {filteredGroups.filter(g => g.isInternal).length > 0 && (
                  <>
                    <div style={{ padding: '6px 16px', background: '#f5f5f5', fontSize: 12, color: '#666', fontWeight: 500 }}>
                      内部组件 ({filteredGroups.filter(g => g.isInternal).length})
                    </div>
                    <List
                      dataSource={filteredGroups.filter(g => g.isInternal)}
                      renderItem={(group) => (
                        <List.Item
                          key={group.name}
                          onClick={() => setSelectedName(group.name)}
                          style={{
                            padding: '12px 16px',
                            cursor: 'pointer',
                            background: selectedName === group.name ? '#e6f4ff' : 'transparent',
                            borderLeft: selectedName === group.name ? '3px solid #1677ff' : '3px solid transparent',
                            transition: 'all 0.2s',
                          }}
                        >
                          <div style={{ width: '100%' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Text strong style={{ fontSize: 14 }}>{group.name}</Text>
                              <RightOutlined style={{ fontSize: 10, color: '#bbb' }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                              <Space size={4}>
                                <Tag color="blue" style={{ margin: 0, fontSize: 12 }}>{group.latestVersion}</Tag>
                                <Tag style={{ margin: 0, fontSize: 12 }}>{group.totalVersions} 版本</Tag>
                              </Space>
                              {group.latestStatus === 'failed' && <Badge status="error" />}
                              {group.latestStatus === 'published' && <Badge status="success" />}
                            </div>
                          </div>
                        </List.Item>
                      )}
                    />
                  </>
                )}
                {/* 外部组件 */}
                {filteredGroups.filter(g => !g.isInternal).length > 0 && (
                  <>
                    <div style={{ padding: '6px 16px', background: '#f5f5f5', fontSize: 12, color: '#666', fontWeight: 500 }}>
                      外部组件 ({filteredGroups.filter(g => !g.isInternal).length})
                    </div>
                    <List
                      dataSource={filteredGroups.filter(g => !g.isInternal)}
                      renderItem={(group) => (
                        <List.Item
                          key={group.name}
                          onClick={() => setSelectedName(group.name)}
                          style={{
                            padding: '12px 16px',
                            cursor: 'pointer',
                            background: selectedName === group.name ? '#e6f4ff' : 'transparent',
                            borderLeft: selectedName === group.name ? '3px solid #1677ff' : '3px solid transparent',
                            transition: 'all 0.2s',
                          }}
                        >
                          <div style={{ width: '100%' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Text strong style={{ fontSize: 14 }}>{group.name}</Text>
                              <RightOutlined style={{ fontSize: 10, color: '#bbb' }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                              <Space size={4}>
                                <Tag color="green" style={{ margin: 0, fontSize: 12 }}>{group.latestVersion}</Tag>
                                <Tag style={{ margin: 0, fontSize: 12 }}>{group.totalVersions} 版本</Tag>
                              </Space>
                              {group.latestStatus === 'failed' && <Badge status="error" />}
                              {group.latestStatus === 'published' && <Badge status="success" />}
                            </div>
                          </div>
                        </List.Item>
                      )}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </Card>

        {/* 右侧：版本列表 */}
        <Card
          size="small"
          style={{ flex: '1 1 0', minWidth: 0 }}
          styles={{ body: { overflow: 'hidden' } }}
          title={
            selectedGroup ? (
              <Space>
                <AppstoreOutlined style={{ color: '#52c41a' }} />
                <span>{selectedGroup.name}</span>
                <Tag color="blue">{selectedGroup.totalVersions} 个版本</Tag>
              </Space>
            ) : (
              <span style={{ fontSize: 14 }}>版本详情</span>
            )
          }
          extra={
            selectedGroup && isAdmin && (
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => {
                  if (selectedGroup.isInternal) {
                    // 内部组件：导航到"上传内部组件" Tab 并预填
                    const prefill: Record<string, string> = { name: selectedGroup.name };
                    if (selectedGroup.versions.length > 0) {
                      const latest = selectedGroup.versions[0];
                      const parsed = parsePodspecFields(latest.podspec_content);
                      Object.assign(prefill, parsed);
                    }
                    form.setFieldsValue(prefill);
                    setPublishTabKey('local');
                  } else {
                    // 官方组件：导航到"导入官方组件" Tab 并预填组件名
                    setOfficialName(selectedGroup.name);
                    setPublishTabKey('official');
                  }
                  setPublishModalOpen(true);
                }}
              >
                发布新版本
              </Button>
            )
          }
        >
          {selectedGroup ? (
            <Table
              columns={versionColumns}
              dataSource={selectedGroup.versions}
              rowKey={(r) => `${r.name}-${r.version}`}
              loading={loading}
              size="small"
              scroll={{ x: 1360 }}
              pagination={
                selectedGroup.versions.length > 10
                  ? { pageSize: 10, showTotal: (t) => `共 ${t} 个版本` }
                  : false
              }
            />
          ) : (
            <Empty description="请从左侧选择一个组件" style={{ padding: '80px 0' }} />
          )}
        </Card>
      </div>

      {/* 发布组件弹窗 */}
      <Modal
        title="发布 Pod 组件"
        open={publishModalOpen}
        onCancel={() => {
          setPublishModalOpen(false);
          form.resetFields();
          setUploadFile(null);
          setOfficialName('');
          setOfficialVersions([]);
          setOfficialVersion('');
          setDependencies([]);
          setDepSelectedVersions({});
          setAvailableSubspecs([]);
          setSelectedSubspecs([]);
          setCheckingDeps(false);
          setOfficialTargetBranch('develop');
          setOfficialTriggerNniosBuild(false);
          setNniosBranches([]);
          setNnrtcBuilds([]);
          setLeigodIMSDKVersions([]);
        }}
        footer={null}
        width={560}
        destroyOnClose
      >
        <Tabs
          activeKey={publishTabKey}
          onChange={(key) => setPublishTabKey(key)}
          items={[
            {
              key: 'local',
              label: '上传内部组件',
              children: (
                <div>
                  <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
                    <Form.Item name="name" label="组件名称" rules={[{ required: true, message: '请输入组件名称' }]}>
                      <Input placeholder="例如: NNRtc" />
                    </Form.Item>
                    {!isNNRtcPublish && !isLeigodIMPublish && (
                    <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请输入版本号' }]}>
                      <Input placeholder="例如: 2.7.0" />
                    </Form.Item>
                    )}
                    {isLeigodIMPublish && (
                      <>
                        <Form.Item
                          name="leigod_im_sdk_version"
                          label="IMSDK 发布版本"
                          rules={[{ required: true, message: '请选择 IMSDK 发布版本' }]}
                        >
                          <Select
                            showSearch
                            loading={leigodIMSDKLoading}
                            placeholder="选择 IMSDK 版本"
                            notFoundContent={leigodIMSDKLoading ? '加载中...' : '未找到可发布版本'}
                            optionFilterProp="label"
                            optionLabelProp="label"
                            options={leigodIMSDKVersions.map((item) => ({
                              value: item.version,
                              label: item.version,
                            }))}
                            onChange={(value) => {
                              form.setFieldValue('version', value);
                            }}
                            onDropdownVisibleChange={(open) => {
                              if (open && leigodIMSDKVersions.length === 0) loadLeigodIMSDKVersions();
                            }}
                          />
                        </Form.Item>
                        <Form.Item name="version" hidden rules={[{ required: true, message: '请选择 IMSDK 发布版本' }]}>
                          <Input />
                        </Form.Item>
                      </>
                    )}
                    {isNNRtcPublish && (
                      <>
                        <Form.Item
                          name="nnrtc_package_type"
                          label="包类型"
                          initialValue="release"
                          rules={[{ required: true, message: '请选择包类型' }]}
                        >
                          <Select
                            onChange={(value) => {
                              setUploadFile(null);
                              if (value === 'test' && !form.getFieldValue('nnrtc_test_source')) {
                                form.setFieldValue('nnrtc_test_source', 'jenkins');
                              }
                              if (value !== 'test') {
                                form.setFieldValue('nnrtc_test_source', undefined);
                              }
                              if (value === 'test' && form.getFieldValue('nnrtc_test_source') === 'upload') {
                                form.setFieldValue('nnrtc_build_number', undefined);
                              }
                            }}
                            options={[
                              { value: 'release', label: '正式包' },
                              { value: 'test', label: '测试包' },
                            ]}
                          />
                        </Form.Item>
                        {nnrtcPackageType === 'test' && (
                          <Form.Item
                            name="nnrtc_test_source"
                            label="测试包来源"
                            initialValue="jenkins"
                            rules={[{ required: true, message: '请选择测试包来源' }]}
                          >
                            <Select
                              onChange={(value) => {
                                setUploadFile(null);
                                if (value === 'upload') {
                                  form.setFieldValue('nnrtc_build_number', undefined);
                                }
                              }}
                              options={[
                                { value: 'jenkins', label: 'Jenkins 构建' },
                                { value: 'upload', label: '上传压缩包' },
                              ]}
                            />
                          </Form.Item>
                        )}
                        {nnrtcUseJenkins && (
                        <Form.Item
                          name="nnrtc_build_number"
                          label={(
                            <span>
                              NNRtc 发布来源（
                              <a
                                href={getNNRtcJenkinsJobUrl(nnrtcJenkinsConfig)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Jenkins
                              </a>
                              ）
                            </span>
                          )}
                          rules={[{ required: true, message: '请选择 Jenkins 构建号' }]}
                        >
                          <Select
                            showSearch
                            loading={nnrtcBuildLoading}
                            placeholder="选择构建号"
                            notFoundContent={nnrtcBuildLoading ? '加载中...' : (nnrtcPackageType === 'release' ? '未找到 release_x.x.x 构建' : '未找到非 release 构建')}
                            optionFilterProp="label"
                            options={nnrtcPublishBuilds.map((build) => ({
                              value: String(build.number),
                              label: formatNNRtcBuildLabel(build),
                            }))}
                            onDropdownVisibleChange={(open) => {
                              if (open && nnrtcBuilds.length === 0) loadNNRtcBuilds();
                            }}
                          />
                        </Form.Item>
                        )}
                        <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请输入版本号' }]}>
                          <Input
                            readOnly
                            placeholder={nnrtcPackageType === 'release' ? '按 release_x.x.x 构建分支自动获取' : '按当前正式包最高版本自动生成'}
                          />
                        </Form.Item>
                      </>
                    )}
                    {isAdmin && (
                      <Form.Item
                        name="target_branch"
                        label="同步到 nnios 分支"
                        initialValue="develop"
                        rules={[
                          { required: true, message: '请选择 nnios 分支' },
                        ]}
                      >
                        <Select
                          showSearch
                          loading={nniosBranchLoading}
                          placeholder="选择 nnios 分支"
                          options={nniosBranches.map((branch) => ({ value: branch, label: branch }))}
                          onDropdownVisibleChange={(open) => {
                            if (open && nniosBranches.length === 0) loadNniosBranches();
                          }}
                        />
                      </Form.Item>
                    )}
                    {showPublishNniosBuildTask && (
                      <Form.Item
                        name="trigger_nnios_build"
                        valuePropName="checked"
                        initialValue={false}
                        style={{ marginBottom: 16 }}
                      >
                        <Checkbox>是否发布 nnios 构建任务</Checkbox>
                      </Form.Item>
                    )}
                    {!isLeigodIMPublish && (!isNNRtcPublish || nnrtcUseUpload) && (
                      <Form.Item
                        label={isNNRtcPublish ? 'NNRtc 测试包' : '二进制库 zip 文件'}
                        required
                        extra={isNNRtcPublish ? '支持 zip、tgz、tar.gz，包内需要包含 NNRtc.framework，不同步 dSYM' : '将 .framework 或 .a 压缩为 zip，系统自动识别库类型'}
                      >
                        <Upload
                          accept={isNNRtcPublish ? '.zip,.tgz,.tar.gz' : '.zip'}
                          maxCount={1}
                          beforeUpload={(file) => {
                            const lowerName = file.name.toLowerCase();
                            const valid = isNNRtcPublish
                              ? (lowerName.endsWith('.zip') || lowerName.endsWith('.tgz') || lowerName.endsWith('.tar.gz'))
                              : lowerName.endsWith('.zip');
                            if (!valid) {
                              message.error(isNNRtcPublish ? '请上传 zip、tgz 或 tar.gz 格式文件' : '请上传 zip 格式文件');
                              return Upload.LIST_IGNORE;
                            }
                            setUploadFile(file);
                            return false;
                          }}
                          onRemove={() => setUploadFile(null)}
                          fileList={uploadFile ? [{ uid: '-1', name: uploadFile.name, status: 'done' as const }] : []}
                        >
                          <Button icon={<UploadOutlined />}>{isNNRtcPublish ? '选择压缩包' : '选择 zip 文件'}</Button>
                        </Upload>
                      </Form.Item>
                    )}
                    <Form.Item name="lib_type" label="库类型（可选，留空自动识别）">
                      <Select allowClear placeholder="自动识别" options={[
                        { value: 'framework', label: '.framework' },
                        { value: 'static_library', label: '.a（静态库）' },
                      ]} />
                    </Form.Item>
                    <Form.Item name="lib_name" label="库文件名（可选，留空自动识别）">
                      <Input placeholder="自动识别" />
                    </Form.Item>
                    <Form.Item name="sys_frameworks" label="系统 Frameworks（可选，逗号分隔）">
                      <Input placeholder="例如: UIKit, AVFoundation" />
                    </Form.Item>
                    <Form.Item name="sys_libraries" label="系统 Libraries（可选，逗号分隔）">
                      <Input placeholder="例如: c++, z" />
                    </Form.Item>
                  </Form>
                  <div style={{ textAlign: 'right' }}>
                    <Button onClick={() => setPublishModalOpen(false)} style={{ marginRight: 8 }}>取消</Button>
                    <Button type="primary" loading={publishing} onClick={handlePublish}>发布</Button>
                  </div>
                </div>
              ),
            },
            {
              key: 'official',
              label: <span><DownloadOutlined /> 导入官方组件</span>,
              children: (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 16 }}>
                    <Text type="secondary">从官方 CocoaPods 下载 SDK，自动上传到内部 Nexus 并同步 podspec 到 NNSpec</Text>
                  </div>
                  <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
                    <Input
                      placeholder="官方组件名，例如: WechatOpenSDK"
                      value={officialName}
                      onChange={(e) => setOfficialName(e.target.value)}
                      onPressEnter={handleFetchOfficialVersions}
                      style={{ flex: 1 }}
                    />
                    <Button type="primary" onClick={handleFetchOfficialVersions} loading={loadingVersions}>
                      查询版本
                    </Button>
                  </Space.Compact>
                  {officialVersions.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ marginBottom: 8 }}>
                        <Text strong>选择版本（共 {officialVersions.length} 个）</Text>
                      </div>
                      <Select
                        style={{ width: '100%' }}
                        value={officialVersion}
                        onChange={async (v) => {
                          setOfficialVersion(v);
                          setDependencies([]);
                          setDepSelectedVersions({});
                          if (v && officialName.trim()) {
                            setCheckingDeps(true);
                            try {
                              const res = await podsApi.checkDependencies(officialName.trim(), v);
                              if (res.success && res.data) {
                                setDependencies(res.data.dependencies);
                                setAvailableSubspecs(res.data.subspecs || []);
                                setSelectedSubspecs(res.data.defaultSubspecs?.length > 0 ? res.data.defaultSubspecs : res.data.subspecs || []);
                                const defaults: Record<string, string> = {};
                                for (const dep of res.data.dependencies) {
                                  if (dep.existsInInternal && dep.internalVersions.length > 0) {
                                    defaults[dep.name] = dep.internalVersions[0];
                                  } else if (!dep.existsInInternal && dep.officialVersions.length > 0) {
                                    defaults[dep.name] = dep.officialVersions[0];
                                  }
                                }
                                setDepSelectedVersions(defaults);
                              }
                            } catch {
                              // 忽略依赖检查失败
                            } finally {
                              setCheckingDeps(false);
                            }
                          }
                        }}
                        showSearch
                        options={officialVersions.map((v) => ({ value: v, label: v }))}
                      />
                    </div>
                  )}
                  {/* 依赖检查结果：只有存在第三方依赖时才展示 */}
                  {checkingDeps && (
                    <div style={{ marginBottom: 16, padding: '12px 16px', background: '#fafafa', borderRadius: 8 }}>
                      <SyncOutlined spin /> 检查依赖...
                    </div>
                  )}
                  {!checkingDeps && dependencies.length > 0 && (
                    <div style={{ marginBottom: 16, padding: '12px 16px', background: '#fafafa', borderRadius: 8 }}>
                      <Text strong>第三方依赖</Text>
                      <div style={{ marginTop: 8 }}>
                          {dependencies.map((dep) => (
                            <div key={dep.name} style={{ display: 'flex', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                              {dep.existsInInternal ? (
                                <Tag color="green">
                                  <CheckCircleOutlined /> 已发布
                                </Tag>
                              ) : (
                                <Tag color="red">
                                  <CloseCircleOutlined /> 未发布
                                </Tag>
                              )}
                              <Text strong style={{ minWidth: 120 }}>{dep.name}</Text>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                ({dep.versionRequirement})
                              </Text>
                              {dep.existsInInternal ? (
                                <Select
                                  size="small"
                                  style={{ width: 120 }}
                                  value={depSelectedVersions[dep.name] || dep.internalVersions[0]}
                                  onChange={(v) => setDepSelectedVersions(prev => ({ ...prev, [dep.name]: v }))}
                                  options={dep.internalVersions.map(v => ({ value: v, label: v }))}
                                />
                              ) : (
                                <>
                                  <Select
                                    size="small"
                                    style={{ width: 120 }}
                                    value={depSelectedVersions[dep.name]}
                                    onChange={(v) => setDepSelectedVersions(prev => ({ ...prev, [dep.name]: v }))}
                                    showSearch
                                    placeholder="选择版本"
                                    options={dep.officialVersions.map(v => ({ value: v, label: v }))}
                                  />
                                  <Button
                                    size="small"
                                    type="primary"
                                    loading={depPublishing[dep.name]}
                                    disabled={!depSelectedVersions[dep.name]}
                                    onClick={async () => {
                                      const depVersion = depSelectedVersions[dep.name];
                                      if (!depVersion) return;
                                      setDepPublishing(prev => ({ ...prev, [dep.name]: true }));
                                      try {
                                        const res = await podsApi.importOfficial(dep.name, depVersion, true, 'framework', undefined, undefined, undefined, undefined, officialTargetBranch || 'develop');
                                        if (res.success) {
                                          message.success(`${dep.name}@${depVersion} 发布成功`);
                                          setDependencies(prev => prev.map(d =>
                                            d.name === dep.name
                                              ? { ...d, existsInInternal: true, internalVersions: [depVersion, ...d.internalVersions] }
                                              : d
                                          ));
                                        }
                                      } catch (err: any) {
                                        message.error(`${dep.name} 发布失败: ${err?.error || '未知错误'}`);
                                      } finally {
                                        setDepPublishing(prev => ({ ...prev, [dep.name]: false }));
                                      }
                                    }}
                                  >
                                    发布
                                  </Button>
                                </>
                              )}
                            </div>
                          ))}
                          {dependencies.some(d => !d.existsInInternal) && (
                            <div style={{ marginTop: 4, color: '#ff4d4f', fontSize: 12 }}>
                              ⚠️ 请先发布缺失的依赖库，再发布当前组件
                            </div>
                          )}
                      </div>
                    </div>
                  )}
                  {/* Subspecs 选择（仅当有多个 subspec 时显示） */}
                  {availableSubspecs.length > 1 && (
                    <div style={{ marginBottom: 16, padding: '12px 16px', background: '#fafafa', borderRadius: 8 }}>
                      <Text strong>选择 Subspecs</Text>
                      <div style={{ marginTop: 8 }}>
                        <Select
                          mode="multiple"
                          style={{ width: '100%' }}
                          value={selectedSubspecs}
                          onChange={setSelectedSubspecs}
                          options={availableSubspecs.map(s => ({ value: s, label: s }))}
                          placeholder="选择要编译的 subspecs"
                        />
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          编译后的二进制会包含所选 subspecs 的代码，不选则引入全部
                        </Text>
                      </div>
                    </div>
                  )}
                  {officialVersions.length > 0 && (
                    <div style={{ marginBottom: 16, padding: '12px 16px', background: '#fafafa', borderRadius: 8 }}>
                      <Checkbox checked={buildBinary} onChange={(e) => setBuildBinary(e.target.checked)}>
                        <Text strong>源码编译为二进制</Text>
                      </Checkbox>
                      <div style={{ marginTop: 4, marginLeft: 24 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          适用于开源源码库，自动编译为真机二进制后发布
                        </Text>
                      </div>
                      {buildBinary && (
                        <div style={{ marginTop: 8, marginLeft: 24 }}>
                          <Select
                            value={buildOutputType}
                            onChange={setBuildOutputType}
                            style={{ width: 240 }}
                            options={[
                              { value: 'framework', label: '编译为 .framework' },
                              { value: 'static_library', label: '编译为 .a 静态库' },
                            ]}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {officialVersions.length > 0 && isAdmin && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ marginBottom: 4 }}>
                        <Text strong>同步到 nnios 分支</Text>
                      </div>
                      <Select
                        showSearch
                        loading={nniosBranchLoading}
                        value={officialTargetBranch}
                        style={{ width: '100%' }}
                        placeholder="选择 nnios 分支"
                        options={nniosBranches.map((branch) => ({ value: branch, label: branch }))}
                        onChange={setOfficialTargetBranch}
                        onDropdownVisibleChange={(open) => {
                          if (open && nniosBranches.length === 0) loadNniosBranches();
                        }}
                      />
                    </div>
                  )}
                  {officialVersions.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <Checkbox
                        checked={officialTriggerNniosBuild}
                        onChange={(e) => setOfficialTriggerNniosBuild(e.target.checked)}
                      >
                        是否发布 nnios 构建任务
                      </Checkbox>
                    </div>
                  )}
                  {officialVersions.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ marginBottom: 4 }}>
                        <Text strong>内部版本号</Text>
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          可选。留空则使用官方原版本号，填写后以此版本号发布（如 {officialVersion || '1.4.0'}.1）
                        </Text>
                      </div>
                      <Input
                        placeholder={`留空默认：${officialVersion || '版本号'}`}
                        value={internalVersion}
                        onChange={(e) => setInternalVersion(e.target.value)}
                        style={{ width: 300 }}
                      />
                    </div>
                  )}
                  {officialVersions.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ marginBottom: 4 }}>
                        <Text strong>prepare_command</Text>
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          可选。pod install 后执行的脚本（如把 .a 转动态库、patch swiftinterface 等）
                        </Text>
                      </div>
                      <Input.TextArea
                        placeholder="留空不注入。填写 shell/ruby 脚本，会写入 podspec 的 s.prepare_command"
                        value={prepareCommand}
                        onChange={(e) => setPrepareCommand(e.target.value)}
                        rows={4}
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                      />
                    </div>
                  )}
                  <div style={{ textAlign: 'right' }}>
                    <Button onClick={() => setPublishModalOpen(false)} style={{ marginRight: 8 }}>取消</Button>
                    <Button
                      type="primary"
                      icon={<DownloadOutlined />}
                      loading={importing}
                      disabled={!officialVersion}
                      onClick={handleImportOfficial}
                    >
                      {importing
                        ? (buildBinary ? '编译中...' : '导入中...')
                        : (buildBinary ? '编译并发布' : '导入到内部仓库')}
                    </Button>
                  </div>
                </div>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={nnrtcTask?.type === 'replace' ? 'NNRtc 构建替换进度' : 'NNRtc 发布进度'}
        open={nnrtcTaskModalOpen}
        onCancel={() => setNnrtcTaskModalOpen(false)}
        footer={
          nnrtcTask && ['success', 'failed'].includes(nnrtcTask.status)
            ? [<Button key="close" type="primary" onClick={() => setNnrtcTaskModalOpen(false)}>关闭</Button>]
            : null
        }
        closable={!nnrtcTask || ['success', 'failed'].includes(nnrtcTask.status)}
        maskClosable={false}
        width={520}
      >
        <div>
          <Progress
            percent={Math.min(100, Math.max(0, nnrtcTask?.progress || 0))}
            status={nnrtcTask?.status === 'failed' ? 'exception' : nnrtcTask?.status === 'success' ? 'success' : 'active'}
          />
          <div style={{ marginTop: 12 }}>
            <Text strong>{nnrtcTask?.message || '等待开始'}</Text>
          </div>
          {nnrtcTask?.warning && (
            <div style={{ marginTop: 8 }}>
              <Text type="warning">{nnrtcTask.warning}</Text>
            </div>
          )}
          {nnrtcTask?.error && (
            <div style={{ marginTop: 8 }}>
              <Text type="danger">{nnrtcTask.error}</Text>
            </div>
          )}
          {nnrtcTask?.logs && nnrtcTask.logs.length > 0 && (
            <div style={{ marginTop: 12, background: '#f5f5f5', padding: 12, borderRadius: 6, maxHeight: 180, overflow: 'auto' }}>
              {nnrtcTask.logs.map((line, index) => (
                <div key={`${line}-${index}`} style={{ fontSize: 12, lineHeight: 1.7 }}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* 版本详情抽屉 */}
      <Drawer
        title={selectedComponent ? `${selectedComponent.name}@${selectedComponent.version}` : '版本详情'}
        open={detailDrawerOpen}
        onClose={() => { setDetailDrawerOpen(false); setEditingPodspec(false); }}
        width={640}
      >
        {selectedComponent && (
          <div>
            <Descriptions column={1} bordered size="small" style={{ marginBottom: 24 }}>
              <Descriptions.Item label="组件名称">{selectedComponent.name}</Descriptions.Item>
              <Descriptions.Item label="版本号">
                <Tag color="blue">{selectedComponent.version}</Tag>
              </Descriptions.Item>
              {selectedComponent.name === 'NNRtc' && (
                <Descriptions.Item label="包类型">
                  <Tag color={selectedNNRtcPackageType === 'test' ? 'orange' : 'green'}>
                    {selectedNNRtcPackageType === 'test' ? '测试包' : '正式包'}
                  </Tag>
                </Descriptions.Item>
              )}
              {selectedComponent.name === 'NNRtc' && (
                <Descriptions.Item label="构建ID">
                  {selectedComponent.build_id ? (
                    <a
                      href={buildNNRtcJenkinsBuildUrl(getNNRtcJenkinsJobUrl(nnrtcJenkinsConfig), selectedComponent.build_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Text code>#{normalizeNNRtcBuildId(selectedComponent.build_id)}</Text>
                    </a>
                  ) : <Text type="secondary">-</Text>}
                </Descriptions.Item>
              )}
              {selectedComponent.name === 'NNRtc' && (
                <Descriptions.Item label="nnios 集成分支">
                  {selectedNNRtcPackageType === 'test'
                    ? (selectedComponent.nnios_branch ? <Tag color="blue">{selectedComponent.nnios_branch}</Tag> : <Text type="secondary">未记录</Text>)
                    : <Text type="secondary">-</Text>}
                </Descriptions.Item>
              )}
              <Descriptions.Item label="状态">{statusTag(selectedComponent.status)}</Descriptions.Item>
              <Descriptions.Item label="描述">{selectedComponent.summary || '-'}</Descriptions.Item>
              <Descriptions.Item label="Nexus 地址">
                <a href={selectedComponent.source_zip_url} target="_blank" rel="noopener noreferrer">
                  {selectedComponent.source_zip_url}
                </a>
              </Descriptions.Item>
              <Descriptions.Item label="Podspec 仓库">
                <a href={`http://git.leigod.top/nn_ios/nnspec/tree/master/${selectedComponent.name}/${selectedComponent.version}`} target="_blank" rel="noopener noreferrer">
                  nnspec/{selectedComponent.name}/{selectedComponent.version}
                </a>
              </Descriptions.Item>
              {selectedComponent.homepage && !selectedComponent.homepage.includes('leigod') && (
                <Descriptions.Item label="官方 CocoaPods">
                  <a href={`https://cocoapods.org/pods/${selectedComponent.name}`} target="_blank" rel="noopener noreferrer">
                    https://cocoapods.org/pods/{selectedComponent.name}
                  </a>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="发布时间">{selectedComponent.upload_time}</Descriptions.Item>
              {selectedComponent.error_message && (
                <Descriptions.Item label="错误信息">
                  <Text type="danger">{selectedComponent.error_message}</Text>
                </Descriptions.Item>
              )}
            </Descriptions>

            {isAdmin && !selectedIsOfficial && (
            <Card size="small" style={{ marginBottom: 8 }}>
              {selectedComponent.name === 'NNRtc' && selectedNNRtcPackageType === 'test' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Text strong style={{ whiteSpace: 'nowrap' }}>同步到 nnios 分支</Text>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{selectedComponent.nnios_branch || detailTargetBranch || '未记录'}</Tag>
                  <Button
                    size="small"
                    icon={<SyncOutlined />}
                    disabled={!selectedComponent.nnios_branch && !detailTargetBranch}
                    onClick={() => handleSyncIntegratedBranch(selectedComponent)}
                  >
                    同步
                  </Button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Text strong style={{ whiteSpace: 'nowrap' }}>同步到 nnios 分支</Text>
                  <Select
                    showSearch
                    loading={nniosBranchLoading}
                    value={detailTargetBranch}
                    style={{ flex: 1 }}
                    placeholder="选择 nnios 分支"
                    options={nniosBranches.map((branch) => ({ value: branch, label: branch }))}
                    onChange={setDetailTargetBranch}
                    onDropdownVisibleChange={(open) => {
                      if (open && nniosBranches.length === 0) loadNniosBranches();
                    }}
                  />
                </div>
              )}
            </Card>
            )}

            {isAdmin && !selectedIsOfficial && selectedComponent && supportsNniosBuildTask(selectedComponent.name) && (
            <Card size="small" style={{ marginBottom: 16 }}>
              <Checkbox
                checked={detailTriggerNniosBuild}
                onChange={(e) => setDetailTriggerNniosBuild(e.target.checked)}
              >
                是否发布 nnios 构建任务
              </Checkbox>
            </Card>
            )}

            {isAdmin && !selectedIsOfficial && (
            <Card size="small" style={{ marginBottom: 16 }}>
              {isLeigodIMComponent(selectedComponent) ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <Text strong>替换二进制文件</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      从 smb://192.168.3.30/share/IMSDK/{selectedComponent.version} 对应版本包替换，自动更新 sha256 和 podspec
                    </Text>
                  </div>
                  <Button
                    icon={<SyncOutlined />}
                    loading={replacingZip}
                    onClick={confirmReplaceLeigodIMFromIMSDK}
                  >
                    {replacingZip ? '替换中...' : 'IMSDK 替换'}
                  </Button>
                </div>
              ) : selectedComponent.name === 'NNRtc' && selectedNNRtcPackageType === 'test' ? (
                <div style={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', rowGap: 8, columnGap: 12, alignItems: 'center' }}>
                  <Text strong style={{ whiteSpace: 'nowrap' }}>替换来源1：</Text>
                  <div>
                    <Upload
                      accept=".zip,.tgz,.tar.gz"
                      maxCount={1}
                      showUploadList={false}
                      beforeUpload={(file) => {
                        const lowerName = file.name.toLowerCase();
                        if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.tgz') && !lowerName.endsWith('.tar.gz')) {
                          message.error('请上传 zip、tgz 或 tar.gz 格式文件');
                          return Upload.LIST_IGNORE;
                        }
                        confirmReplaceZip(file);
                        return false;
                      }}
                    >
                      <Button icon={<UploadOutlined />} loading={replacingZip}>
                        {replacingZip ? '上传中...' : '上传替换'}
                      </Button>
                    </Upload>
                  </div>
                  <Text strong style={{ whiteSpace: 'nowrap' }}>替换来源2：</Text>
                  <div>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        showSearch
                        loading={nnrtcBuildLoading}
                        value={detailJenkinsBuildNumber || undefined}
                        placeholder="选择构建号"
                        optionFilterProp="label"
                        style={{ flex: 1 }}
                        options={detailNNRtcBuilds.map((build) => ({
                          value: String(build.number),
                          label: formatNNRtcBuildLabel(build),
                        }))}
                        onChange={setDetailJenkinsBuildNumber}
                        onDropdownVisibleChange={(open) => {
                          if (open && nnrtcBuilds.length === 0) loadNNRtcBuilds();
                        }}
                      />
                      <Button loading={replacingZip} disabled={detailNNRtcBuilds.length === 0} onClick={confirmReplaceNNRtcFromJenkins}>
                        构建替换
                      </Button>
                    </Space.Compact>
                  </div>
                </div>
              ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text strong>替换二进制文件</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {selectedComponent.name === 'NNRtc'
                      ? '从 Jenkins 构建提取 NNRtc.framework 替换，并同步 NNRtc.dSYM'
                      : '上传新的 zip 文件替换 Nexus 上的二进制，自动更新 sha256 和 podspec'}
                  </Text>
                </div>
                {selectedComponent.name === 'NNRtc' ? (
                  <div style={{ minWidth: 360 }}>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        showSearch
                        loading={nnrtcBuildLoading}
                        value={detailJenkinsBuildNumber || undefined}
                        placeholder="选择构建号"
                        optionFilterProp="label"
                        style={{ flex: 1 }}
                        options={detailNNRtcBuilds.map((build) => ({
                          value: String(build.number),
                          label: formatNNRtcBuildLabel(build),
                        }))}
                        onChange={setDetailJenkinsBuildNumber}
                        onDropdownVisibleChange={(open) => {
                          if (open && nnrtcBuilds.length === 0) loadNNRtcBuilds();
                        }}
                      />
                      <Button loading={replacingZip} disabled={detailNNRtcBuilds.length === 0} onClick={confirmReplaceNNRtcFromJenkins}>
                        构建替换
                      </Button>
                    </Space.Compact>
                  </div>
                ) : (
                  <Upload
                    accept=".zip"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(file) => {
                      if (!file.name.toLowerCase().endsWith('.zip')) {
                        message.error('请上传 zip 格式文件');
                        return Upload.LIST_IGNORE;
                      }
                      confirmReplaceZip(file);
                      return false;
                    }}
                  >
                    <Button icon={<UploadOutlined />} loading={replacingZip}>
                      {replacingZip ? '上传中...' : '选择新 zip'}
                    </Button>
                  </Upload>
                )}
              </div>
              )}
            </Card>
            )}

            {isAdmin && (
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text strong>同步 Spec 仓库</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>将当前 podspec 重新推送到 NNSpec 仓库</Text>
                </div>
                <Popconfirm
                  title="确认重试同步？"
                  description={`将当前 podspec 重新推送到 NNSpec 仓库，并同步到 nnios/${detailTargetBranch}`}
                  onConfirm={() => selectedComponent && handleRetry(selectedComponent, detailTargetBranch)}
                  okText="确认"
                  cancelText="取消"
                >
                  <Button icon={<ReloadOutlined />}>
                    重试同步
                  </Button>
                </Popconfirm>
              </div>
            </Card>
            )}

            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text strong>Podspec 内容</Text>
              <Space>
                <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopyPodspec(editingPodspec ? podspecDraft : selectedComponent.podspec_content)}>
                  复制
                </Button>
                {isAdmin && (editingPodspec ? (
                  <>
                    <Button size="small" onClick={() => { setEditingPodspec(false); setPodspecDraft(selectedComponent.podspec_content); }}>
                      取消
                    </Button>
                    <Button size="small" type="primary" icon={<SaveOutlined />} loading={savingPodspec} onClick={handleSavePodspec}>
                      保存并同步
                    </Button>
                  </>
                ) : (
                  <Button size="small" icon={<EditOutlined />} onClick={() => { setPodspecDraft(selectedComponent.podspec_content); setEditingPodspec(true); }}>
                    编辑
                  </Button>
                ))}
              </Space>
            </div>
            {editingPodspec ? (
              <Input.TextArea
                value={podspecDraft}
                onChange={(e) => setPodspecDraft(e.target.value)}
                autoSize={{ minRows: 12, maxRows: 24 }}
                style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}
              />
            ) : (
              <pre style={{
                background: '#f5f5f5', padding: 16, borderRadius: 8,
                fontSize: 13, lineHeight: 1.6, overflow: 'auto', maxHeight: 400,
              }}>
                {selectedComponent.podspec_content}
              </pre>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
