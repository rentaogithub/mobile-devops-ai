import { useState, useEffect } from 'react';
import { Table, Button, message, Popconfirm, Typography, Space, Input, Tag, Modal, Form, Upload, Card, Alert, Progress, Collapse, Badge, Tabs, Select, List } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined, EditOutlined, InboxOutlined, CheckCircleOutlined, LoadingOutlined, DownloadOutlined, AppstoreOutlined, UnorderedListOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { UploadProps } from 'antd';
import { dsymApi, moduleApi, ExternalServicesConfig } from '../services/api';
import { DSYMInfo } from '../types';
import { formatFileSize, formatDateTime } from '../utils/helpers';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

const defaultExternalServices: ExternalServicesConfig = {
  nnrtcJenkins: {
    baseUrl: '',
    jobName: '',
    jobUrl: '',
  },
  dsymSources: {
    nnRtcArchiveSmbUrl: '',
    screenShareUrl: '',
  },
};

export default function ManagePage() {
  const [dsyms, setDsyms] = useState<DSYMInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingDsym, setEditingDsym] = useState<DSYMInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedInfo, setUploadedInfo] = useState<DSYMInfo | null>(null);
  const [activeTab, setActiveTab] = useState('list');
  const [form] = Form.useForm();
  
  // 模块配置相关状态
  const [customModules, setCustomModules] = useState<string[]>([]);
  const [moduleLoading, setModuleLoading] = useState(false);
  const [newModuleName, setNewModuleName] = useState('');
  const [externalServices, setExternalServices] = useState<ExternalServicesConfig>(defaultExternalServices);
  
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

  const loadExternalServices = async () => {
    try {
      const response = await moduleApi.getExternalServices();
      if (response.success && response.data) {
        setExternalServices(response.data);
      }
    } catch (error) {
      console.warn('获取外部服务配置失败，使用默认地址', error);
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

  const handleEdit = (dsym: DSYMInfo) => {
    setEditingDsym(dsym);
    form.setFieldsValue({
      version: dsym.version,
      notes: dsym.notes || '',
      relatedAppVersions: dsym.relatedAppVersions || [],
    });
    setEditModalVisible(true);
  };

  const handleEditSubmit = async () => {
    if (!editingDsym) return;

    try {
      const values = await form.validateFields();
      const response = await dsymApi.update(editingDsym.uuid, values);

      if (response.success) {
        message.success('更新成功');
        setEditModalVisible(false);
        setEditingDsym(null);
        form.resetFields();
        loadDsyms();
      } else {
        throw new Error(response.error || '更新失败');
      }
    } catch (error: any) {
      const errorMsg = error.error || error.message || '更新失败';
      message.error(errorMsg);
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

  const handleDelete = async (uuid: string) => {
    try {
      const response = await dsymApi.delete(uuid);

      if (response.success) {
        message.success('删除成功');
        loadDsyms();
      } else {
        throw new Error(response.error || '删除失败');
      }
    } catch (error: any) {
      const errorMsg = error.error || error.message || '删除失败';
      message.error(errorMsg);
    }
  };

  useEffect(() => {
    loadDsyms();
    loadModules();
    loadExternalServices();
  }, []);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.dSYM,.xcarchive,.zip,.tgz,.tar.gz',
    beforeUpload: (file) => {
      console.log('beforeUpload 被调用');
      console.log('上传文件信息:', {
        name: file.name,
        size: file.size,
        sizeMB: (file.size / 1024 / 1024).toFixed(2) + 'MB',
        type: file.type
      });

      const isValidType =
        file.name.endsWith('.dSYM') ||
        file.name.endsWith('.xcarchive') ||
        file.name.endsWith('.zip') ||
        file.name.endsWith('.tgz') ||
        file.name.endsWith('.tar.gz');

      if (!isValidType) {
        message.error('只支持 .xcarchive、.zip、.tgz 或 .tar.gz 文件');
        return false;
      }

      const fileSizeMB = file.size / 1024 / 1024;
      const isLt500M = fileSizeMB < 500;
      
      if (!isLt500M) {
        message.error(`文件大小 ${fileSizeMB.toFixed(2)}MB 超过 500MB 限制`);
        return false;
      }

      // 文件验证通过后，立即显示加载状态
      console.log('文件验证通过，开始上传');
      setUploading(true);
      setUploadProgress(0);
      setUploadedInfo(null);

      return true;
    },
    customRequest: async ({ file, onSuccess, onError }) => {
      try {
        // 模拟上传进度
        const progressInterval = setInterval(() => {
          setUploadProgress((prev) => {
            if (prev >= 90) {
              clearInterval(progressInterval);
              return 90;
            }
            return prev + 10;
          });
        }, 500);

        const response = await dsymApi.upload(file as File);

        clearInterval(progressInterval);
        setUploadProgress(100);

        if (response.success && response.data) {
          message.success('上传成功！');
          setUploadedInfo(response.data);
          onSuccess?.(response.data);
          // 刷新列表
          await loadDsyms();
          // 滚动到页面顶部
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          throw new Error(response.error || '上传失败');
        }
      } catch (error: any) {
        let errorMsg = '上传失败';
        
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
          errorMsg = '上传超时，文件可能太大。请尝试压缩文件或使用更快的网络连接';
        } else if (error.error) {
          errorMsg = error.error;
        } else if (error.message) {
          errorMsg = error.message;
        }
        
        message.error(errorMsg, 5);
        onError?.(error);
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
  };

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
      width: isAdmin ? 200 : 100,
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
          {isAdmin && (
            <>
              <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
                编辑
              </Button>
              <Popconfirm
                title="确认删除"
                description="删除后将无法恢复，确定要删除这个 dSYM 文件吗？"
                onConfirm={() => handleDelete(record.uuid)}
                okText="确定"
                cancelText="取消"
              >
                <Button type="link" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            </>
          )}
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
            上传、查看和管理 dSYM 文件，用于 Crash 符号化。
          </Paragraph>
        </div>
        <Button type="primary" icon={<InboxOutlined />} onClick={() => setActiveTab('upload')}>
          上传 dSYM 文件
        </Button>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
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
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onDownload={handleDownload}
                          isAdmin={isAdmin}
                        />
                      ),
                    },
                  ]}
                />
              </div>
            ),
          },
          {
            key: 'upload',
            label: '上传 dSYM 文件',
            children: (
              <Card title="上传 dSYM 文件" style={{ marginBottom: 24 }}>
        <Upload {...uploadProps} disabled={uploading} showUploadList={false}>
          <Button 
            type="primary" 
            icon={uploading ? <LoadingOutlined /> : <InboxOutlined />}
            disabled={uploading}
            size="large"
            block
            style={{ height: 120 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>
                {uploading ? '正在上传和处理文件...' : '点击选择文件上传'}
              </span>
              <span style={{ fontSize: 12, opacity: 0.8 }}>
                支持 .xcarchive、.zip、.tgz、.tar.gz 压缩包，文件大小不超过 500MB
              </span>
            </div>
          </Button>
        </Upload>

        {uploading && (
          <Card style={{ marginTop: 16 }} size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text>上传进度</Text>
                <Text type="secondary">{uploadProgress}%</Text>
              </div>
              <Progress 
                percent={uploadProgress} 
                status="active"
                strokeColor={{
                  '0%': '#108ee9',
                  '100%': '#87d068',
                }}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {uploadProgress < 90 
                  ? '正在上传文件...' 
                  : '正在解析和提取 dSYM 信息...'}
              </Text>
            </Space>
          </Card>
        )}

        {uploadedInfo && !uploading && (
          <Card
            style={{ marginTop: 16 }}
            size="small"
            title={
              <Space>
                <CheckCircleOutlined style={{ color: '#52c41a' }} />
                <span>上传成功 - 请设置版本信息</span>
              </Space>
            }
          >
            <Form
              layout="vertical"
              initialValues={{
                version: uploadedInfo.version,
                notes: '',
              }}
              onFinish={async (values) => {
                try {
                  const response = await dsymApi.update(uploadedInfo.uuid, values);
                  if (response.success) {
                    message.success('版本信息已保存');
                    setUploadedInfo(null);
                    loadDsyms();
                  }
                } catch (error: any) {
                  message.error('保存失败');
                }
              }}
            >
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div>
                  <Text strong>应用名称：</Text>
                  <Text>{uploadedInfo.appName}</Text>
                  <Text type="secondary" style={{ marginLeft: 8 }}>
                    {uploadedInfo.appName.toUpperCase() === 'NNIM' ? '(主应用)' : '(组件库)'}
                  </Text>
                </div>
                <div>
                  <Text strong>UUID：</Text>
                  <Text code>{uploadedInfo.uuid}</Text>
                </div>
                
                <Form.Item
                  label="版本号"
                  name="version"
                  rules={[{ required: true, message: '请输入版本号' }]}
                  style={{ marginBottom: 8 }}
                >
                  <Input placeholder="如：1.0.0" />
                </Form.Item>

                {uploadedInfo.appName.toUpperCase() !== 'NNIM' && (
                  <Form.Item
                    label="关联主应用版本"
                    name="relatedAppVersions"
                    style={{ marginBottom: 8 }}
                  >
                    <Select
                      mode="multiple"
                      placeholder="默认不关联主应用版本，可按需选择"
                      showSearch
                      filterOption={(input, option) =>
                        (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                      }
                      options={dsyms
                        .filter(d => d.appName.toUpperCase() === 'NNIM')
                        .map(d => ({
                          value: d.version,
                          label: `NNIM ${d.version}`,
                        }))
                        .filter((item, index, self) => 
                          index === self.findIndex(t => t.value === item.value)
                        )
                        .sort((a, b) => b.value.localeCompare(a.value))
                      }
                    />
                  </Form.Item>
                )}

                {uploadedInfo.appName.toUpperCase() !== 'NNIM' && (
                  <Form.Item
                    label="备注"
                    name="notes"
                    style={{ marginBottom: 8 }}
                  >
                    <Input.TextArea rows={2} placeholder="可选的备注信息" />
                  </Form.Item>
                )}

                {uploadedInfo.appName.toUpperCase() === 'NNIM' && (
                  <Form.Item
                    label="备注"
                    name="notes"
                    style={{ marginBottom: 8 }}
                  >
                    <Input.TextArea rows={2} placeholder="可选的备注信息" />
                  </Form.Item>
                )}

                <Form.Item style={{ marginBottom: 0 }}>
                  <Space>
                    <Button type="primary" htmlType="submit">
                      保存
                    </Button>
                    <Button onClick={() => {
                      setUploadedInfo(null);
                      loadDsyms();
                    }}>
                      跳过
                    </Button>
                  </Space>
                </Form.Item>
              </Space>
            </Form>
          </Card>
        )}

        <Alert
          style={{ marginTop: 16 }}
          message="使用说明"
          description={
            <div>
              <ul style={{ marginBottom: 12, paddingLeft: 20 }}>
                <li>dSYM 文件包含应用的调试符号信息，用于将崩溃日志中的内存地址转换为可读的函数名和行号</li>
                <li>
                  <strong>重要：</strong>
                  .dSYM 是目录，浏览器无法直接上传目录，请先压缩成 .zip 文件再上传
                </li>
                <li>可以从 Xcode Archive 中导出 dSYM 文件，或从 App Store Connect 下载</li>
                <li>支持上传 .xcarchive 文件（会自动提取其中的 dSYM）</li>
                <li>每个应用版本都有唯一的 UUID，系统会自动匹配对应的 dSYM 文件</li>
              </ul>
              <div style={{ 
                background: '#f0f5ff', 
                border: '1px solid #adc6ff', 
                borderRadius: 4, 
                padding: '8px 12px',
                marginTop: 8
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#1890ff' }}>
                  📁 dSYM 文件获取来源
                </div>
                <div style={{ fontSize: 13, lineHeight: '1.8' }}>
                  <div>
                    <strong>NN & RTC：</strong>
                    <a 
                      href={externalServices.dsymSources.nnRtcArchiveSmbUrl || undefined}
                      style={{ 
                        background: '#fff', 
                        padding: '2px 6px', 
                        borderRadius: 3,
                        margin: '0 4px',
                        fontSize: 12,
                        textDecoration: 'none',
                        color: '#1890ff',
                        border: '1px solid #d9d9d9',
                        display: 'inline-block',
                        fontFamily: 'monospace'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#e6f7ff';
                        e.currentTarget.style.borderColor = '#1890ff';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = '#fff';
                        e.currentTarget.style.borderColor = '#d9d9d9';
                      }}
                    >
                      {externalServices.dsymSources.nnRtcArchiveSmbUrl || '未配置'}
                    </a>
                    <span style={{ color: '#666' }}>（用户：1）</span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <strong>IM SDK：</strong>
                    <a 
                      href="smb://192.168.3.30/share"
                      style={{ 
                        background: '#fff', 
                        padding: '2px 6px', 
                        borderRadius: 3,
                        margin: '0 4px',
                        fontSize: 12,
                        textDecoration: 'none',
                        color: '#1890ff',
                        border: '1px solid #d9d9d9',
                        display: 'inline-block',
                        fontFamily: 'monospace'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#e6f7ff';
                        e.currentTarget.style.borderColor = '#1890ff';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = '#fff';
                        e.currentTarget.style.borderColor = '#d9d9d9';
                      }}
                    >
                      smb://192.168.3.30/share
                    </a>
                  </div>
                </div>
                
                <div style={{ 
                  borderTop: '1px dashed #adc6ff', 
                  marginTop: 8, 
                  paddingTop: 8 
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#1890ff' }}>
                    🖥️ 共享屏幕
                  </div>
                  <div style={{ fontSize: 13, lineHeight: '1.8' }}>
                    <div>
                      <strong>地址：</strong>
                      <a 
                        href={externalServices.dsymSources.screenShareUrl || undefined}
                        style={{ 
                          background: '#fff', 
                          padding: '2px 6px', 
                          borderRadius: 3,
                          margin: '0 4px',
                          fontSize: 12,
                          textDecoration: 'none',
                          color: '#1890ff',
                          border: '1px solid #d9d9d9',
                          display: 'inline-block',
                          fontFamily: 'monospace'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = '#e6f7ff';
                          e.currentTarget.style.borderColor = '#1890ff';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = '#fff';
                          e.currentTarget.style.borderColor = '#d9d9d9';
                        }}
                      >
                        {externalServices.dsymSources.screenShareUrl || '未配置'}
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          }
          type="info"
          showIcon
        />
              </Card>
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
        title="编辑 dSYM 信息"
        open={editModalVisible}
        onOk={handleEditSubmit}
        onCancel={() => {
          setEditModalVisible(false);
          setEditingDsym(null);
          form.resetFields();
        }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="版本号"
            name="version"
            rules={[{ required: true, message: '请输入版本号' }]}
          >
            <Input placeholder="如：1.0.0" />
          </Form.Item>
          
          {editingDsym && editingDsym.appName.toUpperCase() !== 'NNIM' && (
            <Form.Item
              label="关联主应用版本"
              name="relatedAppVersions"
            >
              <Select
                mode="multiple"
                placeholder="默认不关联主应用版本，可按需选择"
                showSearch
                filterOption={(input, option) =>
                  (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                }
                options={dsyms
                  .filter(d => d.appName.toUpperCase() === 'NNIM')
                  .map(d => ({
                    value: d.version,
                    label: `NNIM ${d.version}`,
                  }))
                  .filter((item, index, self) => 
                    index === self.findIndex(t => t.value === item.value)
                  )
                  .sort((a, b) => b.value.localeCompare(a.value))
                }
              />
            </Form.Item>
          )}
          
          <Form.Item label="备注" name="notes">
            <Input.TextArea rows={3} placeholder="可选的备注信息，如：测试版本、发布日期等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// 分组视图组件
interface GroupedViewProps {
  dsyms: DSYMInfo[];
  loading: boolean;
  onEdit: (dsym: DSYMInfo) => void;
  onDelete: (uuid: string) => void;
  onDownload: (dsym: DSYMInfo) => void;
  isAdmin: boolean;
}

function GroupedView({ dsyms, loading, onEdit, onDelete, onDownload, isAdmin }: GroupedViewProps) {
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
                    <Tag key={index} color="green">NNIM {version}</Tag>
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
            width: isAdmin ? 200 : 100,
            fixed: 'right' as const,
            render: (_, record) => (
              <Space>
                <Button 
                  type="link" 
                  icon={<DownloadOutlined />} 
                  onClick={() => onDownload(record)}
                >
                  下载
                </Button>
                {isAdmin && (
                  <>
                    <Button type="link" icon={<EditOutlined />} onClick={() => onEdit(record)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="确认删除"
                      description="删除后将无法恢复，确定要删除这个 dSYM 文件吗？"
                      onConfirm={() => onDelete(record.uuid)}
                      okText="确定"
                      cancelText="取消"
                    >
                      <Button type="link" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  </>
                )}
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
