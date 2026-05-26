import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Typography, Card, Table, Tag, Space, Button, Input, Modal, Form,
  Upload, message, Drawer, Descriptions, Tooltip, Badge, List, Empty, Select, Tabs, Checkbox, Popconfirm,
} from 'antd';
import {
  AppstoreOutlined, SearchOutlined, PlusOutlined, SyncOutlined,
  UploadOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined,
  CopyOutlined, CheckCircleOutlined, CloseCircleOutlined, CloudUploadOutlined,
  RightOutlined, EditOutlined, SaveOutlined, DownloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { podsApi, PodComponent } from '../services/api';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

interface ComponentGroup {
  name: string;
  versions: PodComponent[];
  latestVersion: string;
  totalVersions: number;
  latestStatus: string;
  latestTime: string;
  isInternal: boolean;
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
  const [publishTabKey, setPublishTabKey] = useState<string>('local');

  // 检查是否是管理员
  const isAdmin = authUtils.isAdmin();

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
          isInternal: !latest.homepage,
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

  const handlePublish = async () => {
    try {
      const values = await form.validateFields();
      if (!uploadFile) {
        message.error('请选择 zip 文件');
        return;
      }
      setPublishing(true);

      const res = await podsApi.publish(uploadFile, {
        name: values.name,
        version: values.version,
        lib_type: values.lib_type,
        lib_name: values.lib_name,
        sys_frameworks: values.sys_frameworks,
        sys_libraries: values.sys_libraries,
      });
      if (res.success) {
        if (res.data?.status === 'published') {
          message.success(`${values.name}@${values.version} 发布成功`);
        } else {
          message.warning('Nexus 上传成功，但 spec 仓库同步失败，可稍后重试');
        }
        setPublishModalOpen(false);
        form.resetFields();
        setUploadFile(null);
        setSelectedName(values.name);
        fetchComponents();
      }
    } catch (error: any) {
      message.error(error?.error || error?.message || '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const handleRetry = async (record: PodComponent) => {
    try {
      await podsApi.retry(record.name, record.version);
      message.success('同步成功');
      fetchComponents();
    } catch (error: any) {
      message.error(error?.error || '重试失败');
    }
  };

  const handleDelete = (record: PodComponent) => {
    let confirmText = '';
    Modal.confirm({
      title: `删除版本 ${record.name}@${record.version}`,
      content: (
        <div>
          <p>将同时删除 Nexus 上的 zip 文件，此操作不可恢复。</p>
          <p>请输入版本号 <Text strong code>{record.version}</Text> 确认删除：</p>
          <Input
            placeholder={record.version}
            onChange={(e) => { confirmText = e.target.value; }}
          />
        </div>
      ),
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (confirmText !== record.version) {
          message.error('版本号输入不匹配，取消删除');
          return Promise.reject();
        }
        try {
          await podsApi.delete(record.name, record.version);
          message.success('删除成功');
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
      const res = await podsApi.updatePodspec(selectedComponent.name, selectedComponent.version, podspecDraft);
      if (res.success) {
        message.success('Podspec 更新成功，已同步到远程仓库');
        setSelectedComponent({ ...selectedComponent, podspec_content: podspecDraft, status: 'published' });
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
      const res = await podsApi.replaceZip(selectedComponent.name, selectedComponent.version, file);
      if (res.success && res.data) {
        message.success('zip 替换成功，podspec 已更新');
        setSelectedComponent(res.data);
        setPodspecDraft(res.data.podspec_content);
        fetchComponents();
      }
    } catch (error: any) {
      message.error(error?.error || '替换失败');
    } finally {
      setReplacingZip(false);
    }
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
      const res = await podsApi.importOfficial(officialName.trim(), officialVersion, buildBinary, buildOutputType, depSelectedVersions, selectedSubspecs.length > 0 ? selectedSubspecs : undefined, internalVersion.trim() || undefined, prepareCommand.trim() || undefined);
      if (res.success) {
        const status = res.data?.status;
        const publishedVer = internalVersion.trim() || officialVersion;
        if (status === 'published') {
          message.success(`${officialName}@${publishedVer} 导入成功`);
        } else {
          message.warning('Nexus 上传成功，但 spec 仓库同步失败');
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
        setSelectedName(officialName.trim());
        fetchComponents();
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
      width: isAdmin ? 180 : 80,
      render: (_, record) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => showDetail(record)}>
            详情
          </Button>
          {isAdmin && (
            <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)}>
              删除
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
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

      <div style={{ display: 'flex', gap: 16, minHeight: 500 }}>
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
          style={{ flex: 1 }}
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
                    <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请输入版本号' }]}>
                      <Input placeholder="例如: 2.7.0" />
                    </Form.Item>
                    <Form.Item label="二进制库 zip 文件" required extra="将 .framework 或 .a 压缩为 zip，系统自动识别库类型">
                      <Upload
                        accept=".zip"
                        maxCount={1}
                        beforeUpload={(file) => {
                          if (!file.name.toLowerCase().endsWith('.zip')) {
                            message.error('请上传 zip 格式文件');
                            return Upload.LIST_IGNORE;
                          }
                          setUploadFile(file);
                          return false;
                        }}
                        onRemove={() => setUploadFile(null)}
                        fileList={uploadFile ? [{ uid: '-1', name: uploadFile.name, status: 'done' as const }] : []}
                      >
                        <Button icon={<UploadOutlined />}>选择 zip 文件</Button>
                      </Upload>
                    </Form.Item>
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
                                        const res = await podsApi.importOfficial(dep.name, depVersion, true, 'framework');
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

            {isAdmin && (
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text strong>替换二进制文件</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>上传新的 zip 文件替换 Nexus 上的二进制，自动更新 sha256 和 podspec</Text>
                </div>
                <Upload
                  accept=".zip"
                  maxCount={1}
                  showUploadList={false}
                  beforeUpload={(file) => {
                    if (!file.name.toLowerCase().endsWith('.zip')) {
                      message.error('请上传 zip 格式文件');
                      return Upload.LIST_IGNORE;
                    }
                    handleReplaceZip(file);
                    return false;
                  }}
                >
                  <Button icon={<UploadOutlined />} loading={replacingZip}>
                    {replacingZip ? '上传中...' : '选择新 zip'}
                  </Button>
                </Upload>
              </div>
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
                  description="将当前 podspec 重新推送到 NNSpec 仓库，会覆盖远程已有的文件"
                  onConfirm={() => selectedComponent && handleRetry(selectedComponent)}
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
