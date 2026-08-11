import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Table, Button, message, Popconfirm, Typography, Space, Input, Tag, Card, Alert, Collapse, Badge, Tabs, List, Modal, Select } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined, DownloadOutlined, AppstoreOutlined, UnorderedListOutlined, PlusOutlined, SettingOutlined, EditOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { authApi, dsymApi, moduleApi, PlatformRegistrationRequest, PlatformRole, PlatformUser } from '../services/api';
import { DSYMInfo } from '../types';
import { formatFileSize, formatDateTime } from '../utils/helpers';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

export default function ManagePage({ roleManagementOnly = false }: { roleManagementOnly?: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [platformUsers, setPlatformUsers] = useState<PlatformUser[]>([]);
  const [registrationRequests, setRegistrationRequests] = useState<PlatformRegistrationRequest[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [registrationLoading, setRegistrationLoading] = useState(false);
  const [userSaving, setUserSaving] = useState(false);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<PlatformUser | null>(null);
  const [userForm, setUserForm] = useState({
    username: '',
    password: '',
    role: 'guest' as PlatformRole,
    active: true,
  });
  
  // 检查是否是管理员
  const isAdmin = authUtils.isAdmin();
  const activeTabKey = searchParams.get('tab') === 'modules' && isAdmin ? 'modules' : 'list';
  const isUserRoleManagementView = roleManagementOnly;

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

  const loadPlatformUsers = async () => {
    if (!isAdmin) return;
    setUserLoading(true);
    try {
      const response = await authApi.listUsers();
      setPlatformUsers(response.data || []);
    } catch (error: any) {
      message.error(error?.error || error?.message || '获取平台用户失败');
    } finally {
      setUserLoading(false);
    }
  };

  const loadRegistrationRequests = async () => {
    if (!isAdmin) return;
    setRegistrationLoading(true);
    try {
      const response = await authApi.listRegistrationRequests();
      setRegistrationRequests(response.data || []);
      window.dispatchEvent(new Event('platform-registration-requests-changed'));
    } catch (error: any) {
      message.error(error?.error || error?.message || '获取注册申请失败');
    } finally {
      setRegistrationLoading(false);
    }
  };

  const openCreateUserModal = () => {
    setEditingUser(null);
    setUserForm({ username: '', password: '', role: 'guest', active: true });
    setUserModalOpen(true);
  };

  const openEditUserModal = (user: PlatformUser) => {
    setEditingUser(user);
    setUserForm({
      username: user.username,
      password: '',
      role: user.role,
      active: user.active,
    });
    setUserModalOpen(true);
  };

  const savePlatformUser = async () => {
    const username = userForm.username.trim();
    if (!editingUser && !username) {
      message.warning('请输入用户名');
      return;
    }
    if (!editingUser && userForm.password.length < 8) {
      message.warning('新用户密码至少 8 位');
      return;
    }
    if (editingUser && userForm.password && userForm.password.length < 8) {
      message.warning('重置密码至少 8 位');
      return;
    }

    setUserSaving(true);
    try {
      if (editingUser) {
        await authApi.updateUser(editingUser.id, {
          role: userForm.role,
          active: userForm.active,
          ...(userForm.password ? { password: userForm.password } : {}),
        });
        message.success('用户角色已更新');
      } else {
        await authApi.createUser({
          username,
          displayName: username,
          password: userForm.password,
          role: userForm.role,
        });
        message.success('用户已创建');
      }
      setUserModalOpen(false);
      await loadPlatformUsers();
    } catch (error: any) {
      message.error(error?.error || error?.message || '保存用户失败');
    } finally {
      setUserSaving(false);
    }
  };

  const approveRegistrationRequest = async (id: string) => {
    try {
      await authApi.approveRegistrationRequest(id);
      message.success('注册申请已通过');
      await Promise.all([loadRegistrationRequests(), loadPlatformUsers()]);
      window.dispatchEvent(new Event('platform-registration-requests-changed'));
    } catch (error: any) {
      message.error(error?.error || error?.message || '通过注册申请失败');
    }
  };

  const rejectRegistrationRequest = async (id: string) => {
    try {
      await authApi.rejectRegistrationRequest(id);
      message.success('注册申请已拒绝');
      await loadRegistrationRequests();
      window.dispatchEvent(new Event('platform-registration-requests-changed'));
    } catch (error: any) {
      message.error(error?.error || error?.message || '拒绝注册申请失败');
    }
  };

  const roleTag = (role: PlatformRole) => {
    if (role === 'admin') return <Tag color="gold">管理员</Tag>;
    if (role === 'product') return <Tag color="magenta">产品运营</Tag>;
    if (role === 'developer') return <Tag color="purple">研发</Tag>;
    if (role === 'tester') return <Tag color="blue">测试</Tag>;
    return <Tag>游客</Tag>;
  };

  const registrationStatusTag = (status: PlatformRegistrationRequest['status']) => {
    if (status === 'approved') return <Tag color="green">已通过</Tag>;
    if (status === 'rejected') return <Tag color="red">已拒绝</Tag>;
    return <Tag color="processing">待审核</Tag>;
  };

  const visibleRegistrationRequests = registrationRequests.filter((request) => request.requestedRole !== 'guest');
  const hasPendingVisibleRegistrationRequest = visibleRegistrationRequests.some((request) => request.status === 'pending');

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
    if (!roleManagementOnly) {
      loadDsyms();
      loadModules();
    }
    loadPlatformUsers();
    loadRegistrationRequests();
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

  const renderRegistrationRequests = () => (
    <Card
      title="注册申请审核"
      extra={(
        <Button icon={<ReloadOutlined />} onClick={loadRegistrationRequests} loading={registrationLoading}>
          刷新
        </Button>
      )}
    >
      <Table<PlatformRegistrationRequest>
        rowKey="id"
        loading={registrationLoading}
        dataSource={visibleRegistrationRequests}
        pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 条申请` }}
        locale={{ emptyText: '暂无注册申请' }}
        columns={[
          {
            title: '申请用户',
            dataIndex: 'username',
            key: 'username',
            render: (value: string) => <Text strong>{value}</Text>,
          },
          {
            title: '申请角色',
            dataIndex: 'requestedRole',
            key: 'requestedRole',
            width: 140,
            render: (role: PlatformRole) => roleTag(role),
          },
          {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 120,
            render: (status: PlatformRegistrationRequest['status']) => registrationStatusTag(status),
          },
          {
            title: '申请时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 180,
            render: (value: string) => formatDateTime(value),
          },
          {
            title: '审核人',
            dataIndex: 'reviewerUsername',
            key: 'reviewerUsername',
            width: 140,
            render: (value?: string) => value || <Text type="secondary">-</Text>,
          },
          {
            title: '操作',
            key: 'actions',
            width: 180,
            render: (_, record) => record.status === 'pending' ? (
              <Space>
                <Popconfirm
                  title="确定通过该注册申请吗？"
                  okText="通过"
                  cancelText="取消"
                  onConfirm={() => approveRegistrationRequest(record.id)}
                >
                  <Button size="small" type="primary" icon={<CheckOutlined />}>
                    通过
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="确定拒绝该注册申请吗？"
                  okText="拒绝"
                  cancelText="取消"
                  onConfirm={() => rejectRegistrationRequest(record.id)}
                >
                  <Button size="small" danger icon={<CloseOutlined />}>
                    拒绝
                  </Button>
                </Popconfirm>
              </Space>
            ) : <Text type="secondary">已处理</Text>,
          },
        ]}
      />
    </Card>
  );

  const renderUserRoles = () => (
    <Card
      title="用户角色"
      extra={(
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadPlatformUsers} loading={userLoading}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateUserModal}>
            新增用户
          </Button>
        </Space>
      )}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="角色权限说明"
        description="游客可查看常用服务；测试可发布蒲公英/TestFlight 并执行自动质检；研发在测试权限基础上可维护 Pods 组件；产品运营可发布苹果商店包；管理员支持所有功能和角色权限管理。"
      />
      <Table<PlatformUser>
        rowKey="id"
        loading={userLoading}
        dataSource={platformUsers}
        pagination={false}
        columns={[
          {
            title: '用户名',
            dataIndex: 'username',
            key: 'username',
            render: (value: string) => <Text strong>{value}</Text>,
          },
          {
            title: '角色',
            dataIndex: 'role',
            key: 'role',
            width: 120,
            render: (role: PlatformRole) => roleTag(role),
          },
          {
            title: '状态',
            dataIndex: 'active',
            key: 'active',
            width: 120,
            render: (active: boolean) => active ? <Tag color="green">启用</Tag> : <Tag color="red">停用</Tag>,
          },
          {
            title: '操作',
            key: 'actions',
            width: 140,
            render: (_, record) => (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEditUserModal(record)}>
                编辑
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );

  const renderPlatformUsers = () => (
    <Tabs
      defaultActiveKey="users"
      items={[
        {
          key: 'users',
          label: '用户角色',
          children: renderUserRoles(),
        },
        {
          key: 'registration',
          label: (
            <Badge dot={hasPendingVisibleRegistrationRequest} offset={[6, -1]}>
              <span>注册申请审核</span>
            </Badge>
          ),
          children: renderRegistrationRequests(),
        },
      ]}
    />
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <Title level={2}>{isUserRoleManagementView ? '角色权限管理' : 'dSYM 文件管理'}</Title>
          <Paragraph type="secondary">
            {isUserRoleManagementView
              ? '管理平台实名账号、角色和启停状态，控制 CI/CD、Pods、苹果商店发布等能力边界。'
              : '查看和管理 dSYM 文件，用于 Crash 符号化。主工程 NNIM 通过 CICD 上传，NNRtc 和 leigod_im_cross_sdk 通过组件发布入口上传。'}
          </Paragraph>
        </div>
      </div>

      {isUserRoleManagementView ? renderPlatformUsers() : (
      <Tabs
        activeKey={activeTabKey}
        onChange={(key) => {
          if (key === 'list') {
            setSearchParams({});
          } else {
            setSearchParams({ tab: key });
          }
        }}
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
      )}

      <Modal
        title={editingUser ? `编辑用户 - ${editingUser.username}` : '新增平台用户'}
        open={userModalOpen}
        onCancel={() => setUserModalOpen(false)}
        onOk={savePlatformUser}
        confirmLoading={userSaving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>
            <Text strong>用户名</Text>
            <Input
              value={userForm.username}
              disabled={Boolean(editingUser)}
              placeholder="3-64 位字母、数字、点、下划线或连字符"
              onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))}
              style={{ marginTop: 6 }}
            />
          </div>
          <div>
            <Text strong>角色</Text>
            <Select
              value={userForm.role}
              onChange={(role) => setUserForm((current) => ({ ...current, role }))}
              style={{ width: '100%', marginTop: 6 }}
              options={[
                { label: '游客：普通用户，常用服务查看', value: 'guest' },
                { label: '测试：蒲公英/TestFlight 发布、自动质检', value: 'tester' },
                { label: '研发：测试权限 + Pods 增加/删除', value: 'developer' },
                { label: '产品运营：苹果商店包发布', value: 'product' },
                { label: '管理员：全部功能 + 角色权限管理', value: 'admin' },
              ]}
            />
          </div>
          <div>
            <Text strong>{editingUser ? '重置密码' : '登录密码'}</Text>
            {editingUser && (
              <div style={{ marginTop: 6, marginBottom: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  当前密码不可查看，可重置为默认密码：{editingUser.username}123
                </Text>
              </div>
            )}
            <Input.Password
              value={userForm.password}
              placeholder={editingUser ? '不填写则不修改' : '至少 8 位'}
              onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
              style={{ marginTop: 6 }}
            />
            {editingUser && (
              <Button
                type="link"
                size="small"
                style={{ paddingLeft: 0, marginTop: 4 }}
                onClick={() => setUserForm((current) => ({ ...current, password: `${editingUser.username}123` }))}
              >
                填入默认密码
              </Button>
            )}
          </div>
          {editingUser && (
            <div>
              <Text strong>账号状态</Text>
              <Select
                value={userForm.active ? 'active' : 'inactive'}
                onChange={(value) => setUserForm((current) => ({ ...current, active: value === 'active' }))}
                style={{ width: '100%', marginTop: 6 }}
                options={[
                  { label: '启用', value: 'active' },
                  { label: '停用', value: 'inactive' },
                ]}
              />
            </div>
          )}
        </Space>
      </Modal>

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
