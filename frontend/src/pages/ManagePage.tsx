import { useState, useEffect } from 'react';
import { Table, Button, message, Popconfirm, Typography, Space, Input, Tag, Card, Alert, Collapse, Badge, Tabs, List, Modal, Select } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined, DownloadOutlined, AppstoreOutlined, UnorderedListOutlined, PlusOutlined, SettingOutlined, EditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { dsymApi, moduleApi } from '../services/api';
import { DSYMInfo } from '../types';
import { formatFileSize, formatDateTime } from '../utils/helpers';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

export default function ManagePage() {
  const [dsyms, setDsyms] = useState<DSYMInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [relationModalOpen, setRelationModalOpen] = useState(false);
  const [relationTarget, setRelationTarget] = useState<DSYMInfo | null>(null);
  const [selectedUnsupportedVersions, setSelectedUnsupportedVersions] = useState<string[]>([]);
  const [relationSaving, setRelationSaving] = useState(false);
  
  // 模块配置相关状态
  const [customModules, setCustomModules] = useState<string[]>([]);
  const [moduleLoading, setModuleLoading] = useState(false);
  const [newModuleName, setNewModuleName] = useState('');
  
  // 检查是否是管理员
  const isAdmin = authUtils.isAdmin();

  const loadDsyms = async () => {
    try {
      setLoading(true);
      const response = await dsymApi.list();

      if (response.success && response.data) {
        setDsyms(response.data);
      } else {
        throw new Error(response.error || '获取列表失败');
      }
    } catch (error: any) {
      const errorMsg = error.error || error.message || '获取列表失败';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const loadModules = async () => {
    try {
      setModuleLoading(true);
      const modules = await moduleApi.getModules();
      setCustomModules(modules);
    } catch (error: any) {
      message.error('获取模块列表失败');
    } finally {
      setModuleLoading(false);
    }
  };

  const handleAddModule = async () => {
    if (!newModuleName.trim()) {
      message.warning('请输入模块名称');
      return;
    }

    if (customModules.includes(newModuleName.trim())) {
      message.warning('模块已存在');
      return;
    }

    try {
      const updatedModules = [...customModules, newModuleName.trim()];
      await moduleApi.updateModules(updatedModules);
      setCustomModules(updatedModules);
      setNewModuleName('');
      message.success('添加成功');
    } catch (error: any) {
      message.error('添加失败');
    }
  };

  const handleRemoveModule = async (moduleName: string) => {
    try {
      const updatedModules = customModules.filter(m => m !== moduleName);
      await moduleApi.updateModules(updatedModules);
      setCustomModules(updatedModules);
      message.success('删除成功');
    } catch (error: any) {
      message.error('删除失败');
    }
  };

  const handleDownload = (dsym: DSYMInfo) => {
    try {
      message.loading({ content: '正在准备下载...', key: 'download', duration: 0 });
      dsymApi.download(dsym.uuid, dsym.appName, dsym.version);
      setTimeout(() => {
        message.success({ content: '下载已开始', key: 'download', duration: 2 });
      }, 1000);
    } catch (error: any) {
      message.error({ content: '下载失败', key: 'download', duration: 2 });
    }
  };

  const openRelationEditor = (componentDsym: DSYMInfo) => {
    setRelationTarget(componentDsym);
    setSelectedUnsupportedVersions([]);
    setRelationModalOpen(true);
  };

  const handleSaveRelations = async () => {
    if (!relationTarget) {
      return;
    }

    try {
      setRelationSaving(true);
      const nextVersions = Array.from(new Set([
        ...(relationTarget.relatedAppVersions || []),
        ...selectedUnsupportedVersions,
      ]));
      await dsymApi.update(relationTarget.uuid, {
        relatedAppVersions: nextVersions,
      });
      message.success('关联主应用版本已更新');
      setRelationModalOpen(false);
      await loadDsyms();
    } catch (error: any) {
      message.error(error?.error || error?.message || '更新关联主应用版本失败');
    } finally {
      setRelationSaving(false);
    }
  };

  useEffect(() => {
    loadDsyms();
    loadModules();
  }, []);

  const filteredDsyms = dsyms.filter(
    (dsym) =>
      dsym.appName.toLowerCase().includes(searchText.toLowerCase()) ||
      dsym.version.toLowerCase().includes(searchText.toLowerCase()) ||
      dsym.uuid.toLowerCase().includes(searchText.toLowerCase())
  );

  const columns: ColumnsType<DSYMInfo> = [
    {
      title: '应用名称',
      dataIndex: 'appName',
      key: 'appName',
      width: 200,
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 120,
      render: (text) => <Text>{text}</Text>,
    },
    {
      title: '关联组件库',
      key: 'relatedComponents',
      width: 200,
      render: (_, record) => {
        // 查找关联到这个主应用版本的组件库
        const relatedComponents = dsyms.filter(
          d => d.appName.toUpperCase() !== 'NNIM' && 
          d.relatedAppVersions && 
          d.relatedAppVersions.includes(record.version)
        );
        
        if (relatedComponents.length === 0) {
          return <Text type="secondary">无</Text>;
        }
        
        return (
          <Space direction="vertical" size={0}>
            {relatedComponents.map(comp => (
              <Tag key={comp.uuid} color="purple" style={{ margin: '2px 0' }}>
                {comp.appName} {comp.version}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '文件大小',
      dataIndex: 'fileSize',
      key: 'fileSize',
      width: 120,
      render: (size) => formatFileSize(size),
    },
    {
      title: '上传时间',
      dataIndex: 'uploadTime',
      key: 'uploadTime',
      width: 180,
      render: (time) => formatDateTime(time),
      sorter: (a, b) => new Date(a.uploadTime).getTime() - new Date(b.uploadTime).getTime(),
      defaultSortOrder: 'descend',
    },
    {
      title: '备注',
      key: 'notes',
      width: 300,
      render: (_, record) => (
        <Space direction="vertical" size={0} style={{ width: '100%' }}>
          {record.notes && <Text>{record.notes}</Text>}
          <Text code copyable style={{ fontSize: 12 }}>{record.uuid}</Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button 
            type="link" 
            icon={<DownloadOutlined />} 
            onClick={() => handleDownload(record)}
          >
            下载
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <Title level={2}>dSYM 文件管理</Title>
          <Paragraph type="secondary">
            查看和管理 dSYM 文件，用于 Crash 符号化。主工程 NNIM 通过 CICD 上传，NNRtc 和 leigod_im_cross_sdk 通过组件发布入口上传。
          </Paragraph>
        </div>
      </div>

      <Tabs
        defaultActiveKey="list"
        items={[
          {
            key: 'list',
            label: '已上传的 dSYM 文件',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Input
                    placeholder="搜索应用名称、版本或 UUID"
                    prefix={<SearchOutlined />}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    style={{ width: 300 }}
                    allowClear
                  />
                  <Button icon={<ReloadOutlined />} onClick={loadDsyms} loading={loading}>
                    刷新
                  </Button>
                </Space>

                <Tabs
                  defaultActiveKey="nnim"
                  items={[
                    {
                      key: 'nnim',
                      label: (
                        <span>
                          <AppstoreOutlined />
                          主应用 (NNIM)
                          <Badge 
                            count={filteredDsyms.filter(d => d.appName.toUpperCase() === 'NNIM').length} 
                            style={{ marginLeft: 8, backgroundColor: '#1890ff' }} 
                          />
                        </span>
                      ),
                      children: (
                        <Table
                          columns={columns}
                          dataSource={filteredDsyms.filter(d => d.appName.toUpperCase() === 'NNIM')}
                          rowKey="id"
                          loading={loading}
                          pagination={{
                            pageSize: 10,
                            showSizeChanger: true,
                            showTotal: (total) => `共 ${total} 条记录`,
                          }}
                          scroll={{ x: 1400 }}
                        />
                      ),
                    },
                    {
                      key: 'components',
                      label: (
                        <span>
                          <UnorderedListOutlined />
                          组件库
                          <Badge 
                            count={filteredDsyms.filter(d => d.appName.toUpperCase() !== 'NNIM').length} 
                            style={{ marginLeft: 8, backgroundColor: '#52c41a' }} 
                          />
                        </span>
                      ),
                      children: (
                        <GroupedView 
                          dsyms={filteredDsyms.filter(d => d.appName.toUpperCase() !== 'NNIM')} 
                          loading={loading}
                          isAdmin={isAdmin}
                          onDownload={handleDownload}
                          onEditRelations={openRelationEditor}
                        />
                      ),
                    },
                  ]}
                />
              </div>
            ),
          },
          ...(isAdmin ? [{
            key: 'modules',
            label: (
              <span>
                <SettingOutlined />
                模块配置
              </span>
            ),
            children: (
              <Card title="自定义模块列表">
                <Alert
                  message="配置说明"
                  description="在这里配置你的自定义模块名称（如 NNIM、NNRtc 等）。AI 分析时会优先选择这些模块中最后一次调用的位置作为崩溃位置。"
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                />

                <Space style={{ marginBottom: 16, width: '100%' }}>
                  <Input
                    placeholder="输入模块名称"
                    value={newModuleName}
                    onChange={(e) => setNewModuleName(e.target.value)}
                    onPressEnter={handleAddModule}
                    style={{ width: 300 }}
                  />
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={handleAddModule}
                    loading={moduleLoading}
                  >
                    添加模块
                  </Button>
                </Space>

                <List
                  loading={moduleLoading}
                  bordered
                  dataSource={customModules}
                  renderItem={(module) => (
                    <List.Item
                      actions={[
                        <Popconfirm
                          title="确定要删除这个模块吗？"
                          onConfirm={() => handleRemoveModule(module)}
                          okText="确定"
                          cancelText="取消"
                        >
                          <Button type="link" danger icon={<DeleteOutlined />}>
                            删除
                          </Button>
                        </Popconfirm>,
                      ]}
                    >
                      <Tag color="blue" style={{ fontSize: 14, padding: '4px 12px' }}>
                        {module}
                      </Tag>
                    </List.Item>
                  )}
                  locale={{ emptyText: '暂无自定义模块' }}
                />
              </Card>
            ),
          }] : []),
        ]}
      />

      <Modal
        title={`编辑关联主应用版本 - ${relationTarget?.appName || ''} ${relationTarget?.version || ''}`}
        open={relationModalOpen}
        onCancel={() => setRelationModalOpen(false)}
        onOk={handleSaveRelations}
        confirmLoading={relationSaving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="info"
            showIcon
            message="选择该组件库 dSYM 还未支持的主工程版本"
            description="只展示尚未关联的版本，保存后会追加到当前组件库的支持版本中。"
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="选择未支持版本"
            value={selectedUnsupportedVersions}
            onChange={setSelectedUnsupportedVersions}
            style={{ width: '100%' }}
            options={dsyms
              .filter((dsym) => dsym.appName.toUpperCase() === 'NNIM')
              .filter((dsym) => !relationTarget?.relatedAppVersions?.includes(dsym.version))
              .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
              .map((dsym) => ({
                label: dsym.version,
                value: dsym.version,
              }))}
            optionFilterProp="label"
            notFoundContent="暂无未支持版本"
          />
        </Space>
      </Modal>

    </div>
  );
}

// 分组视图组件
interface GroupedViewProps {
  dsyms: DSYMInfo[];
  loading: boolean;
  isAdmin: boolean;
  onDownload: (dsym: DSYMInfo) => void;
  onEditRelations: (dsym: DSYMInfo) => void;
}

function GroupedView({ dsyms, loading, isAdmin, onDownload, onEditRelations }: GroupedViewProps) {
  // 按应用名称分组
  const groupedDsyms = dsyms.reduce((acc, dsym) => {
    const appName = dsym.appName;
    if (!acc[appName]) {
      acc[appName] = [];
    }
    acc[appName].push(dsym);
    return acc;
  }, {} as Record<string, DSYMInfo[]>);

  // 对每个分组内的数据按上传时间排序
  Object.keys(groupedDsyms).forEach(appName => {
    groupedDsyms[appName].sort((a, b) => 
      new Date(b.uploadTime).getTime() - new Date(a.uploadTime).getTime()
    );
  });

  const items = Object.keys(groupedDsyms).sort().map(appName => ({
    key: appName,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space>
          <AppstoreOutlined />
          <Text strong>{appName}</Text>
        </Space>
        <Badge count={groupedDsyms[appName].length} style={{ backgroundColor: '#1890ff' }} />
      </div>
    ),
    children: (
      <Table
        columns={[
          {
            title: '版本',
            dataIndex: 'version',
            key: 'version',
            width: 120,
            render: (text) => <Text>{text}</Text>,
          },
          {
            title: '关联主应用版本',
            dataIndex: 'relatedAppVersions',
            key: 'relatedAppVersions',
            width: 200,
            render: (versions: string[] | undefined) => {
              if (!versions || versions.length === 0) {
                return <Text type="secondary">未设置</Text>;
              }
              return (
                <Space size={[0, 4]} wrap>
                  {versions.map((version, index) => (
                    <Tag key={index} color="green">{version}</Tag>
                  ))}
                </Space>
              );
            },
          },
          {
            title: '文件大小',
            dataIndex: 'fileSize',
            key: 'fileSize',
            width: 120,
            render: (size) => formatFileSize(size),
          },
          {
            title: '上传时间',
            dataIndex: 'uploadTime',
            key: 'uploadTime',
            width: 180,
            render: (time) => formatDateTime(time),
          },
          {
            title: '备注',
            key: 'notes',
            width: 300,
            render: (_, record) => (
              <Space direction="vertical" size={0} style={{ width: '100%' }}>
                {record.notes && <Text>{record.notes}</Text>}
                <Text code copyable style={{ fontSize: 12 }}>{record.uuid}</Text>
              </Space>
            ),
          },
          {
            title: '操作',
            key: 'action',
            width: 180,
            fixed: 'right' as const,
            render: (_, record) => (
              <Space>
                {isAdmin && (
                  <Button
                    type="link"
                    icon={<EditOutlined />}
                    onClick={() => onEditRelations(record)}
                  >
                    编辑关联
                  </Button>
                )}
                <Button 
                  type="link" 
                  icon={<DownloadOutlined />} 
                  onClick={() => onDownload(record)}
                >
                  下载
                </Button>
              </Space>
            ),
          },
        ]}
        dataSource={groupedDsyms[appName]}
        rowKey="id"
        pagination={false}
        size="small"
      />
    ),
  }));

  if (loading) {
    return <Card loading={loading} />;
  }

  if (items.length === 0) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Text type="secondary">暂无数据</Text>
        </div>
      </Card>
    );
  }

  return (
    <Collapse 
      items={items} 
      defaultActiveKey={items.map(item => item.key)}
      style={{ background: '#fff' }}
    />
  );
}
