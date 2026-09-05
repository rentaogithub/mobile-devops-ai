import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Table, Button, message, Popconfirm, Typography, Space, Input, Tag, Card, Alert, Collapse, Badge, Tabs, List, Modal, Select, Spin, Upload } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined, DownloadOutlined, AppstoreOutlined, UnorderedListOutlined, PlusOutlined, SettingOutlined, EditOutlined, CheckOutlined, CloseOutlined, UploadOutlined, SyncOutlined, LinkOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { authApi, dsymApi, moduleApi, PlatformConfigStatus, PlatformProductLine, PlatformRegistrationRequest, PlatformRole, PlatformUser, ProductLineServiceConfig, ProductLineServiceUpdate } from '../services/api';
import { DSYMInfo } from '../types';
import { formatFileSize, formatDateTime } from '../utils/helpers';
import { authUtils } from '../utils/auth';

const { Title, Paragraph, Text } = Typography;

type ProductLineSecretKey = 'JENKINS_TOKEN' | 'PGYER_API_KEY' | 'PGYER_APP_KEY' | 'APP_STORE_CONNECT_API_PRIVATE_KEY' | 'WECHAT_WEBHOOK_URL';
type ProductLineTextConfigKey = Exclude<keyof ProductLineServiceConfig, `${string}Configured`>;
type ProductLineEditorMode = 'create' | 'edit';

const emptyProductLineServices = (): ProductLineServiceConfig => ({
  JENKINS_USER: '',
  JENKINS_TOKENConfigured: false,
  JENKINS_NN_JOB: '',
  JENKINS_NN_QA_JOB: '',
  JENKINS_NN_REPO_URL: '',
  PODX_TARGET_NAME: '',
  PODX_PRIVATE_SOURCE: '',
  PODX_GIT_BASE_URL: '',
  PODX_PUBLISH_REPOS: '',
  PODX_PUBLISH_MAIN_REPO: '',
  PODX_PUBLISH_WORK_DIR: '',
  PODX_PUBLISH_BASE_BRANCH: '',
  PGYER_API_KEYConfigured: false,
  PGYER_APP_KEYConfigured: false,
  PGYER_SHORTCUT_URL: '',
  APP_STORE_CONNECT_API_KEY_ID: '',
  APP_STORE_CONNECT_API_ISSUER_ID: '',
  APP_STORE_CONNECT_API_PRIVATE_KEYConfigured: false,
  APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE: '',
  APP_STORE_CONNECT_APP_ID: '',
  APP_STORE_CONNECT_TESTFLIGHT_GROUPS: '',
  WECHAT_WEBHOOK_URLConfigured: false,
  WECHAT_WEBHOOK_URL: '',
  WECHAT_WEBHOOK_URL_SOURCE: '',
});

const emptyProductLineSecrets = (): Record<ProductLineSecretKey, string> => ({
  JENKINS_TOKEN: '',
  PGYER_API_KEY: '',
  PGYER_APP_KEY: '',
  APP_STORE_CONNECT_API_PRIVATE_KEY: '',
  WECHAT_WEBHOOK_URL: '',
});

const emptySecretChanges = (): Record<ProductLineSecretKey, boolean> => ({
  JENKINS_TOKEN: false,
  PGYER_API_KEY: false,
  PGYER_APP_KEY: false,
  APP_STORE_CONNECT_API_PRIVATE_KEY: false,
  WECHAT_WEBHOOK_URL: false,
});

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
  const [productLines, setProductLines] = useState<PlatformProductLine[]>([]);
  const [editingProductLine, setEditingProductLine] = useState<PlatformProductLine | null>(null);
  const [productLineEditorMode, setProductLineEditorMode] = useState<ProductLineEditorMode | null>(null);
  const [productLineConfigTab, setProductLineConfigTab] = useState('basic');
  const [productLineSaving, setProductLineSaving] = useState(false);
  const [productLineServicesLoading, setProductLineServicesLoading] = useState(false);
  const [productLineConfigSyncing, setProductLineConfigSyncing] = useState(false);
  const [productLineForm, setProductLineForm] = useState({ key: '', name: '', projectId: '', bundleId: '', jenkinsBaseUrl: '' });
  const [productLineServices, setProductLineServices] = useState<ProductLineServiceConfig>(emptyProductLineServices);
  const [productLineSecrets, setProductLineSecrets] = useState<Record<ProductLineSecretKey, string>>(emptyProductLineSecrets);
  const [productLineSecretChanges, setProductLineSecretChanges] = useState<Record<ProductLineSecretKey, boolean>>(emptySecretChanges);
  const [appStorePrivateKeyFileName, setAppStorePrivateKeyFileName] = useState('');
  const [appStorePrivateKeySyncing, setAppStorePrivateKeySyncing] = useState(false);
  const [weChatWebhookSyncing, setWeChatWebhookSyncing] = useState(false);
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
    productLines: [{ productLineId: 'nn', role: 'guest' as PlatformRole }],
  });
  const [platformConfig, setPlatformConfig] = useState<PlatformConfigStatus | null>(null);
  const [platformConfigLoading, setPlatformConfigLoading] = useState(false);
  const [platformConfigSaving, setPlatformConfigSaving] = useState(false);
  const [platformConfigForm, setPlatformConfigForm] = useState({
    currentPassword: '',
    newAdminPassword: '',
    releaseVerificationPassword: '',
    aiApiKey: '',
  });
  const [platformConfigChanged, setPlatformConfigChanged] = useState({ release: false, ai: false });
  
  // 检查是否是管理员
  const isAdmin = authUtils.isAdmin();
  const canManageDsym = authUtils.hasAnyRole(['developer', 'admin']);
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

  const loadProductLines = async () => {
    if (!isAdmin) return;
    try {
      const response = await authApi.listProductLines();
      setProductLines(response.data || []);
    } catch (error: any) {
      message.error(error?.error || error?.message || '获取产品线失败');
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

  const loadPlatformConfig = async () => {
    if (!isAdmin) return;
    setPlatformConfigLoading(true);
    try {
      const response = await authApi.getPlatformConfig();
      setPlatformConfig(response.data || null);
      if (response.data) {
        setPlatformConfigForm((current) => ({
          ...current,
          currentPassword: response.data?.adminPassword || current.currentPassword,
          releaseVerificationPassword: response.data?.releaseVerificationPassword || '',
          aiApiKey: response.data?.aiApiKey || '',
        }));
      }
    } catch (error: any) {
      message.error(error?.error || error?.message || '获取平台配置失败');
    } finally {
      setPlatformConfigLoading(false);
    }
  };

  const savePlatformConfig = async () => {
    const { currentPassword, newAdminPassword, releaseVerificationPassword, aiApiKey } = platformConfigForm;
    if (newAdminPassword && !currentPassword) {
      message.warning('修改管理员密码需要先输入当前密码');
      return;
    }
    if (newAdminPassword && newAdminPassword.length < 8) {
      message.warning('管理员新密码至少 8 位');
      return;
    }
    if (!newAdminPassword && !platformConfigChanged.release && !platformConfigChanged.ai) {
      message.info('没有需要保存的配置');
      return;
    }
    setPlatformConfigSaving(true);
    try {
      const response = await authApi.updatePlatformConfig({
        ...(newAdminPassword ? { currentPassword, newAdminPassword } : {}),
        ...(platformConfigChanged.release ? { releaseVerificationPassword } : {}),
        ...(platformConfigChanged.ai ? { aiApiKey } : {}),
      });
      setPlatformConfig(response.data || null);
      setPlatformConfigForm((current) => ({
        currentPassword: newAdminPassword || current.currentPassword,
        newAdminPassword: '',
        releaseVerificationPassword: platformConfigChanged.release ? releaseVerificationPassword : current.releaseVerificationPassword,
        aiApiKey: platformConfigChanged.ai ? aiApiKey : current.aiApiKey,
      }));
      setPlatformConfigChanged({ release: false, ai: false });
      message.success('平台配置已保存');
    } catch (error: any) {
      message.error(error?.error || error?.message || '保存平台配置失败');
    } finally {
      setPlatformConfigSaving(false);
    }
  };

  const openCreateUserModal = () => {
    setEditingUser(null);
    setUserForm({ username: '', password: '', role: 'guest', active: true, productLines: [{ productLineId: 'nn', role: 'guest' }] });
    setUserModalOpen(true);
  };

  const openEditUserModal = (user: PlatformUser) => {
    setEditingUser(user);
    setUserForm({
      username: user.username,
      password: '',
      role: user.role,
      active: user.active,
      productLines: user.productLines.map((item) => ({ productLineId: item.id, role: item.role })),
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
          productLines: userForm.role === 'admin' ? [] : userForm.productLines,
          ...(userForm.password ? { password: userForm.password } : {}),
        });
        message.success('用户角色已更新');
      } else {
        await authApi.createUser({
          username,
          displayName: username,
          password: userForm.password,
          role: userForm.role,
          productLines: userForm.role === 'admin' ? [] : userForm.productLines,
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

  const fillProductLineForm = (productLine: PlatformProductLine) => {
    setProductLineForm({
      key: productLine.key,
      name: productLine.name,
      projectId: productLine.projectId,
      bundleId: productLine.bundleId || '',
      jenkinsBaseUrl: productLine.jenkinsBaseUrl || '',
    });
  };

  const openCreateProductLine = () => {
    setEditingProductLine(null);
    setProductLineForm({ key: '', name: '', projectId: '', bundleId: '', jenkinsBaseUrl: '' });
    setProductLineServices(emptyProductLineServices());
    setProductLineSecrets(emptyProductLineSecrets());
    setProductLineSecretChanges(emptySecretChanges());
    setAppStorePrivateKeyFileName('');
    setProductLineEditorMode('create');
    setProductLineConfigTab('basic');
  };

  const openEditProductLine = async (productLine: PlatformProductLine) => {
    if (productLineEditorMode === 'edit' && editingProductLine?.id === productLine.id) {
      return;
    }
    setEditingProductLine(productLine);
    fillProductLineForm(productLine);
    setProductLineServices(emptyProductLineServices());
    setProductLineSecrets(emptyProductLineSecrets());
    setProductLineSecretChanges(emptySecretChanges());
    setAppStorePrivateKeyFileName('');
    setProductLineEditorMode('edit');
    setProductLineConfigTab('basic');
    setProductLineServicesLoading(true);
    try {
      const response = await authApi.getProductLineServices(productLine.id);
      if (response.data) setProductLineServices(response.data);
    } catch (error: any) {
      message.error(error?.error || error?.message || '获取产品线服务配置失败');
    } finally {
      setProductLineServicesLoading(false);
    }
  };

  const updateProductLineService = (key: ProductLineTextConfigKey, value: string) => {
    setProductLineServices((current) => ({ ...current, [key]: value }));
  };

  const updateProductLineSecret = (key: ProductLineSecretKey, value: string) => {
    setProductLineSecrets((current) => ({ ...current, [key]: value }));
    setProductLineSecretChanges((current) => ({ ...current, [key]: true }));
  };

  const loadAppStorePrivateKeyFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.p8')) {
      message.warning('请选择 .p8 私钥文件');
      return;
    }
    if (file.size > 64 * 1024) {
      message.warning('.p8 私钥文件不能超过 64 KB');
      return;
    }
    try {
      const content = (await file.text()).trim();
      if (!content.includes('-----BEGIN PRIVATE KEY-----') || !content.includes('-----END PRIVATE KEY-----')) {
        message.error('所选文件不是有效的 App Store Connect .p8 私钥');
        return;
      }
      updateProductLineSecret('APP_STORE_CONNECT_API_PRIVATE_KEY', content);
      setAppStorePrivateKeyFileName(file.name);
      message.success(`已读取 ${file.name}，保存产品线后生效`);
    } catch {
      message.error('读取 .p8 私钥文件失败');
    }
  };

  const syncAppStorePrivateKey = async () => {
    if (!editingProductLine) return;
    setAppStorePrivateKeySyncing(true);
    try {
      const response = await authApi.getProductLineServices(editingProductLine.id);
      const latest = response.data;
      if (!latest) throw new Error('未读取到私钥配置状态');
      setProductLineServices((current) => ({
        ...current,
        APP_STORE_CONNECT_API_PRIVATE_KEYConfigured: latest.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured,
        APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE: latest.APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE,
      }));
      setProductLineSecrets((current) => ({ ...current, APP_STORE_CONNECT_API_PRIVATE_KEY: '' }));
      setProductLineSecretChanges((current) => ({ ...current, APP_STORE_CONNECT_API_PRIVATE_KEY: false }));
      setAppStorePrivateKeyFileName('');
      message.success(latest.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured
        ? `已同步当前私钥配置：${latest.APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE || '已安全配置'}`
        : '同步完成，当前未配置 App Store Connect 私钥');
    } catch (error: any) {
      message.error(error?.error || error?.message || '同步 App Store Connect 私钥失败');
    } finally {
      setAppStorePrivateKeySyncing(false);
    }
  };

  const syncWeChatWebhook = async () => {
    if (!editingProductLine) return;
    setWeChatWebhookSyncing(true);
    try {
      const response = await authApi.getProductLineServices(editingProductLine.id);
      const latest = response.data;
      if (!latest) throw new Error('未读取到 Webhook 配置状态');
      setProductLineServices((current) => ({
        ...current,
        WECHAT_WEBHOOK_URLConfigured: latest.WECHAT_WEBHOOK_URLConfigured,
        WECHAT_WEBHOOK_URL: latest.WECHAT_WEBHOOK_URL,
        WECHAT_WEBHOOK_URL_SOURCE: latest.WECHAT_WEBHOOK_URL_SOURCE,
      }));
      setProductLineSecrets((current) => ({ ...current, WECHAT_WEBHOOK_URL: '' }));
      setProductLineSecretChanges((current) => ({ ...current, WECHAT_WEBHOOK_URL: false }));
      message.success(latest.WECHAT_WEBHOOK_URLConfigured
        ? '已刷新企业微信机器人 Webhook 状态'
        : '刷新完成，当前未配置企业微信机器人 Webhook');
    } catch (error: any) {
      message.error(error?.error || error?.message || '刷新企业微信机器人 Webhook 失败');
    } finally {
      setWeChatWebhookSyncing(false);
    }
  };

  const syncSavedProductLinePodxConfig = async (productLineId: string) => {
    const response = await authApi.syncProductLinePodxConfig(productLineId);
    return response.data;
  };

  const syncProductLinePodxConfig = async () => {
    if (!editingProductLine) {
      message.warning('请先保存产品线后再同步 podx.config.yml');
      return;
    }
    setProductLineConfigSyncing(true);
    try {
      const result = await syncSavedProductLinePodxConfig(editingProductLine.id);
      const configPath = result?.configPath;
      message.success(configPath ? `已同步到 ${configPath}` : 'podx.config.yml 已同步到主工程');
    } catch (error: any) {
      message.error(error?.error || error?.message || '同步 podx.config.yml 失败');
    } finally {
      setProductLineConfigSyncing(false);
    }
  };

  const productLineServicePayload = (): ProductLineServiceUpdate => ({
    JENKINS_USER: productLineServices.JENKINS_USER,
    JENKINS_NN_JOB: productLineServices.JENKINS_NN_JOB,
    JENKINS_NN_QA_JOB: productLineServices.JENKINS_NN_QA_JOB,
    JENKINS_NN_REPO_URL: productLineServices.JENKINS_NN_REPO_URL,
    PODX_TARGET_NAME: productLineServices.PODX_TARGET_NAME,
    PODX_PRIVATE_SOURCE: productLineServices.PODX_PRIVATE_SOURCE,
    PODX_GIT_BASE_URL: productLineServices.PODX_GIT_BASE_URL,
    PODX_PUBLISH_REPOS: productLineServices.PODX_PUBLISH_REPOS,
    PODX_PUBLISH_MAIN_REPO: productLineServices.PODX_PUBLISH_MAIN_REPO,
    PODX_PUBLISH_WORK_DIR: productLineServices.PODX_PUBLISH_WORK_DIR,
    PODX_PUBLISH_BASE_BRANCH: productLineServices.PODX_PUBLISH_BASE_BRANCH,
    PGYER_SHORTCUT_URL: productLineServices.PGYER_SHORTCUT_URL,
    APP_STORE_CONNECT_API_KEY_ID: productLineServices.APP_STORE_CONNECT_API_KEY_ID,
    APP_STORE_CONNECT_API_ISSUER_ID: productLineServices.APP_STORE_CONNECT_API_ISSUER_ID,
    APP_STORE_CONNECT_APP_ID: productLineServices.APP_STORE_CONNECT_APP_ID,
    APP_STORE_CONNECT_TESTFLIGHT_GROUPS: productLineServices.APP_STORE_CONNECT_TESTFLIGHT_GROUPS,
    ...Object.fromEntries((Object.keys(productLineSecretChanges) as ProductLineSecretKey[])
      .filter((key) => productLineSecretChanges[key])
      .map((key) => [key, productLineSecrets[key]])),
  });

  const renderServiceSecret = (
    key: ProductLineSecretKey,
    label: string,
    configured: boolean,
    placeholder: string
  ) => {
    const changed = productLineSecretChanges[key];
    const pendingValue = productLineSecrets[key];
    return (
      <div>
        <Space size={6} style={{ marginBottom: 6 }}>
          <Text strong>{label}</Text>
          {changed
            ? <Tag color={pendingValue ? 'blue' : 'red'}>{pendingValue ? '待更新' : '待清除'}</Tag>
            : configured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}
        </Space>
        <Space.Compact style={{ width: '100%' }}>
          <Input.Password
            value={pendingValue}
            onChange={(event) => updateProductLineSecret(key, event.target.value)}
            placeholder={configured ? `${placeholder}；不填写则保留现有值` : placeholder}
          />
          <Button onClick={() => updateProductLineSecret(key, '')} disabled={!configured && !pendingValue}>清除</Button>
        </Space.Compact>
      </div>
    );
  };

  const renderServiceInput = (
    key: ProductLineTextConfigKey,
    label: string,
    placeholder: string
  ) => (
    <div>
      <Text strong>{label}</Text>
      <Input
        style={{ marginTop: 6 }}
        value={String(productLineServices[key] || '')}
        onChange={(event) => updateProductLineService(key, event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  const renderServiceTextArea = (
    key: ProductLineTextConfigKey,
    label: string,
    placeholder: string,
    rows = 5
  ) => (
    <div>
      <Text strong>{label}</Text>
      <Input.TextArea
        style={{ marginTop: 6 }}
        rows={rows}
        value={String(productLineServices[key] || '')}
        onChange={(event) => updateProductLineService(key, event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  const saveProductLine = async () => {
    if (!productLineForm.name.trim()) {
      message.warning('请输入产品线名称');
      return;
    }
    if (!editingProductLine && !productLineForm.key.trim()) {
      message.warning('请输入产品线标识');
      setProductLineConfigTab('basic');
      return;
    }
    if (!productLineForm.projectId.trim()) {
      message.warning('请输入 Workflow 项目标识');
      setProductLineConfigTab('basic');
      return;
    }
    setProductLineSaving(true);
    try {
      let targetProductLineId = editingProductLine?.id || '';
      let savedProductLine: PlatformProductLine | null = editingProductLine;
      if (editingProductLine) {
        const updated = await authApi.updateProductLine(editingProductLine.id, {
          name: productLineForm.name,
          projectId: productLineForm.projectId,
          bundleId: productLineForm.bundleId,
          jenkinsBaseUrl: productLineForm.jenkinsBaseUrl,
        });
        savedProductLine = updated.data || { ...editingProductLine, ...productLineForm };
      } else {
        const created = await authApi.createProductLine(productLineForm);
        targetProductLineId = created.data?.id || '';
        if (!targetProductLineId) throw new Error('产品线已创建，但未返回产品线 ID');
        savedProductLine = created.data || null;
      }
      const services = await authApi.updateProductLineServices(targetProductLineId, productLineServicePayload());
      try {
        const syncResult = await syncSavedProductLinePodxConfig(targetProductLineId);
        const action = editingProductLine ? '产品线配置已保存' : '产品线已创建';
        message.success(syncResult?.configPath ? `${action}，已同步到 ${syncResult.configPath}` : `${action}，已同步 podx.config.yml`);
      } catch (syncError: any) {
        const action = editingProductLine ? '产品线配置已保存' : '产品线已创建';
        message.warning(`${action}，但同步 podx.config.yml 失败：${syncError?.error || syncError?.message || '请检查主工程仓库配置'}`);
      }
      setProductLineEditorMode('edit');
      if (savedProductLine) {
        setEditingProductLine(savedProductLine);
        fillProductLineForm(savedProductLine);
      }
      if (services.data) setProductLineServices(services.data);
      setProductLineSecrets(emptyProductLineSecrets());
      setProductLineSecretChanges(emptySecretChanges());
      setAppStorePrivateKeyFileName('');
      await Promise.all([loadProductLines(), loadPlatformUsers(), authUtils.refreshUser()]);
    } catch (error: any) {
      message.error(error?.error || error?.message || '创建产品线失败');
    } finally {
      setProductLineSaving(false);
    }
  };

  const closeProductLineEditor = () => {
    setProductLineEditorMode(null);
    setEditingProductLine(null);
    setProductLineForm({ key: '', name: '', projectId: '', bundleId: '', jenkinsBaseUrl: '' });
    setProductLineServices(emptyProductLineServices());
    setProductLineSecrets(emptyProductLineSecrets());
    setProductLineSecretChanges(emptySecretChanges());
    setAppStorePrivateKeyFileName('');
    setProductLineConfigTab('basic');
  };

  const productLineFormGridStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 12,
  };

  const renderProductLineConfigPanel = () => {
    if (!productLineEditorMode) {
      return (
        <Alert
          type="info"
          showIcon
          message="选择一个产品线后在这里配置"
          description="从左侧产品列表选择产品线，右侧会按基础信息、Jenkins、podx、mgit、分发、App Store 和通知服务拆分成独立 tab。"
        />
      );
    }

    const isCreating = productLineEditorMode === 'create';
    const panelTitle = isCreating
      ? '新增产品线配置'
      : `配置产品线：${editingProductLine?.name || productLineForm.name}`;
    const renderTabActions = (label: string) => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={closeProductLineEditor}>取消</Button>
        <Button type="primary" loading={productLineSaving} onClick={saveProductLine}>
          {isCreating ? '创建产品线' : `保存${label}`}
        </Button>
      </div>
    );

    return (
      <Card title={panelTitle}>
        <Spin spinning={productLineServicesLoading} tip="正在读取服务配置...">
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Tabs
              activeKey={productLineConfigTab}
              onChange={setProductLineConfigTab}
              items={[
                {
                  key: 'basic',
                  label: '基础信息',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="用于：权限隔离、Workflow 数据隔离、全局产品线选择"
                        description="产品线标识创建后不再修改；Workflow 项目标识用于隔离任务、问题与质量门禁数据。"
                      />
                      <div style={productLineFormGridStyle}>
                        {isCreating && (
                          <div>
                            <Text strong>产品线标识</Text>
                            <Input
                              style={{ marginTop: 6 }}
                              value={productLineForm.key}
                              onChange={(event) => setProductLineForm((current) => ({ ...current, key: event.target.value.trim() }))}
                              placeholder="如：nn、nnrtc"
                            />
                          </div>
                        )}
                        <div>
                          <Text strong>产品线名称</Text>
                          <Input
                            style={{ marginTop: 6 }}
                            value={productLineForm.name}
                            onChange={(event) => setProductLineForm((current) => ({ ...current, name: event.target.value }))}
                            placeholder="如：雷神加速器"
                          />
                        </div>
                        <div>
                          <Text strong>Workflow 项目</Text>
                          <Input
                            style={{ marginTop: 6 }}
                            value={productLineForm.projectId}
                            onChange={(event) => setProductLineForm((current) => ({ ...current, projectId: event.target.value.trim() }))}
                            placeholder="如：nn-ios、nnrtc-ios"
                          />
                        </div>
                        <div>
                          <Text strong>Bundle ID</Text>
                          <Input
                            style={{ marginTop: 6 }}
                            value={productLineForm.bundleId}
                            onChange={(event) => setProductLineForm((current) => ({ ...current, bundleId: event.target.value }))}
                            placeholder="如：com.example.app（可选）"
                          />
                        </div>
                      </div>
                      {renderTabActions('基础信息')}
                    </Space>
                  ),
                },
                {
                  key: 'jenkins',
                  label: 'Jenkins',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="用于：Jenkins 构建、自动质检、发布状态、失败诊断"
                        description="Jenkins 服务地址保存在产品线基础信息中；账号和 Job 信息保存在产品线服务配置中。"
                      />
                      <div style={productLineFormGridStyle}>
                        <div>
                          <Text strong>Jenkins 服务地址</Text>
                          <Input
                            style={{ marginTop: 6 }}
                            value={productLineForm.jenkinsBaseUrl}
                            onChange={(event) => setProductLineForm((current) => ({ ...current, jenkinsBaseUrl: event.target.value }))}
                            placeholder="如：https://jenkins.example.com:8080"
                          />
                        </div>
                        <div><Text strong>Jenkins 用户名</Text><Input style={{ marginTop: 6 }} value={productLineServices.JENKINS_USER} onChange={(event) => updateProductLineService('JENKINS_USER', event.target.value)} placeholder="用于调用 Jenkins API" /></div>
                        <div><Text strong>构建 Job</Text><Input style={{ marginTop: 6 }} value={productLineServices.JENKINS_NN_JOB} onChange={(event) => updateProductLineService('JENKINS_NN_JOB', event.target.value)} placeholder="如：app-ios-build，也支持 folder/job" /></div>
                        <div><Text strong>自动质检 Job</Text><Input style={{ marginTop: 6 }} value={productLineServices.JENKINS_NN_QA_JOB} onChange={(event) => updateProductLineService('JENKINS_NN_QA_JOB', event.target.value)} placeholder="如：app-ios-quality" /></div>
                        <div><Text strong>iOS Git 仓库地址</Text><Input style={{ marginTop: 6 }} value={productLineServices.JENKINS_NN_REPO_URL} onChange={(event) => updateProductLineService('JENKINS_NN_REPO_URL', event.target.value)} placeholder="如：https://git.example.com/mobile/app-ios.git" /></div>
                      </div>
                      {productLineServices.JENKINS_USER === 'anonymous' && !productLineServices.JENKINS_TOKENConfigured ? (
                        <div>
                          <Space size={6} style={{ marginBottom: 6 }}>
                            <Text strong>Jenkins API Token</Text>
                            <Tag color="green">匿名访问，无需配置</Tag>
                          </Space>
                          <Input.Password
                            value={productLineSecrets.JENKINS_TOKEN}
                            onChange={(event) => updateProductLineSecret('JENKINS_TOKEN', event.target.value)}
                            placeholder="当前 Jenkins 允许匿名访问；启用账号认证后再填写 Token"
                          />
                        </div>
                      ) : renderServiceSecret('JENKINS_TOKEN', 'Jenkins API Token', productLineServices.JENKINS_TOKENConfigured, '输入 API Token')}
                      {renderTabActions(' Jenkins')}
                    </Space>
                  ),
                },
                {
                  key: 'podx',
                  label: 'podx',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="用于：podx install、podx update、podx main、podx doctor、本地组件切换"
                        description="这些配置决定当前产品线的 CocoaPods 私有源和默认 group/target；本地组件切换统一使用主工程根目录的 Podfile.overlay。"
                      />
                      <div style={productLineFormGridStyle}>
                        {renderServiceInput('PODX_TARGET_NAME', 'Target Name', '如：nn_ios、nnrtc_ios')}
                        {renderServiceInput('PODX_PRIVATE_SOURCE', '私有 Specs 源', '如：https://git.example.com/nnrtc_ios/nnspec.git')}
                        {renderServiceInput('PODX_GIT_BASE_URL', 'Git 基础地址', '如：https://git.example.com')}
                      </div>
                      {!isCreating && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <Button icon={<SyncOutlined />} loading={productLineConfigSyncing} onClick={syncProductLinePodxConfig}>
                            重新同步到主工程
                          </Button>
                        </div>
                      )}
                      {renderTabActions(' podx')}
                    </Space>
                  ),
                },
                {
                  key: 'mgit',
                  label: 'mgit',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="用于：Git 分支页面默认仓库、mgit publish、Jenkins 发布分支"
                        description="仓库列表可填仓库名或完整 Git URL。填仓库名时平台会按 Git 基础地址、Target Name 和仓库名拼出远端 URL。"
                      />
                      <div style={productLineFormGridStyle}>
                        {renderServiceInput('PODX_PUBLISH_MAIN_REPO', '发布主仓库', '如：nnios、nnrtc-ios')}
                        {renderServiceInput('PODX_PUBLISH_WORK_DIR', '发布工作目录', '如：.mgit-publish/nnrtc')}
                        {renderServiceInput('PODX_PUBLISH_BASE_BRANCH', '发布基准分支', '默认 develop')}
                      </div>
                      {renderServiceTextArea('PODX_PUBLISH_REPOS', '发布仓库列表', '每行一个仓库名或 Git URL，例如：\nnnrtc-ios\nnnrtc-core', 5)}
                      {renderTabActions(' mgit')}
                    </Space>
                  ),
                },
                {
                  key: 'pgyer',
                  label: '蒲公英',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="用于：蒲公英发布、短链查询、发布结果归档"
                        description="如果当前产品线只通过短链查询包信息，可以不填 App Key。"
                      />
                      {renderServiceSecret('PGYER_API_KEY', '蒲公英 API Key', productLineServices.PGYER_API_KEYConfigured, '输入蒲公英 API Key')}
                      {!productLineServices.PGYER_APP_KEYConfigured && productLineServices.PGYER_API_KEYConfigured && productLineServices.PGYER_SHORTCUT_URL ? (
                        <div>
                          <Space size={6} style={{ marginBottom: 6 }}>
                            <Text strong>蒲公英 App Key</Text>
                            <Tag color="green">短链模式，无需配置</Tag>
                          </Space>
                          <Input.Password
                            value={productLineSecrets.PGYER_APP_KEY}
                            onChange={(event) => updateProductLineSecret('PGYER_APP_KEY', event.target.value)}
                            placeholder="当前通过蒲公英短链查询；如需改用 App Key 可在此填写"
                          />
                        </div>
                      ) : renderServiceSecret('PGYER_APP_KEY', '蒲公英 App Key', productLineServices.PGYER_APP_KEYConfigured, '输入蒲公英 App Key')}
                      <div><Text strong>蒲公英短链</Text><Input style={{ marginTop: 6 }} value={productLineServices.PGYER_SHORTCUT_URL} onChange={(event) => updateProductLineService('PGYER_SHORTCUT_URL', event.target.value)} placeholder="如：https://www.pgyer.com/xxxx" /></div>
                      {renderTabActions('蒲公英')}
                    </Space>
                  ),
                },
                {
                  key: 'appstore',
                  label: 'App Store',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="用于：TestFlight 发布、App Store 发布、发布前置校验"
                        description="私钥只保存加密状态，不会从后端明文返回。"
                      />
                      <div style={productLineFormGridStyle}>
                        {renderServiceInput('APP_STORE_CONNECT_API_KEY_ID', 'App Store Connect Key ID', 'API Key ID')}
                        {renderServiceInput('APP_STORE_CONNECT_API_ISSUER_ID', 'Issuer ID', 'Issuer ID')}
                        {renderServiceInput('APP_STORE_CONNECT_APP_ID', 'App ID', 'App Store Connect 数字 App ID')}
                        {renderServiceInput('APP_STORE_CONNECT_TESTFLIGHT_GROUPS', 'TestFlight 测试组', '多个组用逗号分隔')}
                      </div>
                      <div>
                        {productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured && !productLineSecretChanges.APP_STORE_CONNECT_API_PRIVATE_KEY && (
                          <Alert
                            type="success"
                            showIcon
                            style={{ marginBottom: 10 }}
                            message={`已加载 App Store Connect 私钥：${productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEY_SOURCE || '已安全配置'}`}
                            description="私钥内容属于敏感信息，不会通过管理接口返回或在页面明文显示；直接保存会继续使用当前私钥。"
                          />
                        )}
                        <Space size={6} style={{ marginBottom: 6 }}>
                          <Text strong>{productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured ? '更新私钥（可选）' : 'App Store Connect 私钥'}</Text>
                          {productLineSecretChanges.APP_STORE_CONNECT_API_PRIVATE_KEY
                            ? <Tag color={productLineSecrets.APP_STORE_CONNECT_API_PRIVATE_KEY ? 'blue' : 'red'}>{productLineSecrets.APP_STORE_CONNECT_API_PRIVATE_KEY ? '待更新' : '待清除'}</Tag>
                            : productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}
                        </Space>
                        <Input.TextArea
                          value={productLineSecrets.APP_STORE_CONNECT_API_PRIVATE_KEY}
                          onChange={(event) => {
                            updateProductLineSecret('APP_STORE_CONNECT_API_PRIVATE_KEY', event.target.value);
                            setAppStorePrivateKeyFileName('');
                          }}
                          placeholder={productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured ? '当前私钥已加载；仅在需要替换时粘贴新的 .p8 完整内容' : '粘贴 .p8 私钥完整内容'}
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          style={{ fontFamily: 'monospace' }}
                        />
                        {appStorePrivateKeyFileName && (
                          <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                            待更新文件：{appStorePrivateKeyFileName}
                          </Text>
                        )}
                        <Space size={8} wrap style={{ marginTop: 8 }}>
                          <Upload
                            accept=".p8"
                            maxCount={1}
                            showUploadList={false}
                            beforeUpload={(file) => {
                              void loadAppStorePrivateKeyFile(file);
                              return false;
                            }}
                          >
                            <Button size="small" type="primary" icon={<UploadOutlined />}>选择 .p8 更新</Button>
                          </Upload>
                          {editingProductLine && (
                            <Button size="small" icon={<SyncOutlined />} loading={appStorePrivateKeySyncing} onClick={syncAppStorePrivateKey}>
                              刷新私钥状态
                            </Button>
                          )}
                          <Button
                            size="small"
                            icon={<LinkOutlined />}
                            href="https://appstoreconnect.apple.com/access/integrations/api"
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开 App Store Connect API 密钥
                          </Button>
                          <Popconfirm
                            title="确定清除当前产品线的 App Store Connect 私钥吗？"
                            description="保存产品线后生效。"
                            okText="清除"
                            cancelText="取消"
                            onConfirm={() => {
                              updateProductLineSecret('APP_STORE_CONNECT_API_PRIVATE_KEY', '');
                              setAppStorePrivateKeyFileName('');
                            }}
                            disabled={!productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured && !productLineSecrets.APP_STORE_CONNECT_API_PRIVATE_KEY}
                          >
                            <Button size="small" danger disabled={!productLineServices.APP_STORE_CONNECT_API_PRIVATE_KEYConfigured && !productLineSecrets.APP_STORE_CONNECT_API_PRIVATE_KEY}>清除私钥</Button>
                          </Popconfirm>
                        </Space>
                      </div>
                      {renderTabActions(' App Store')}
                    </Space>
                  ),
                },
                {
                  key: 'notification',
                  label: '通知',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="info"
                        showIcon
                        message="企业微信机器人用于当前产品线的构建、发布和审核结果通知"
                        description="在目标企业微信群中添加群机器人后复制完整 Webhook 地址。当前完整地址仅在管理员产品线配置页显示。"
                      />
                      {productLineServices.WECHAT_WEBHOOK_URLConfigured && !productLineSecretChanges.WECHAT_WEBHOOK_URL && (
                        <div>
                          <Space size={6} style={{ marginBottom: 6 }}>
                            <Text strong>当前 Webhook</Text>
                            <Tag color="green">已配置</Tag>
                          </Space>
                          <Input
                            readOnly
                            value={productLineServices.WECHAT_WEBHOOK_URL || ''}
                            addonAfter={`来源：${productLineServices.WECHAT_WEBHOOK_URL_SOURCE || '已安全加载'}`}
                          />
                        </div>
                      )}
                      {renderServiceSecret(
                        'WECHAT_WEBHOOK_URL',
                        productLineServices.WECHAT_WEBHOOK_URLConfigured ? '更新 Webhook（可选）' : '企业微信机器人 Webhook',
                        productLineServices.WECHAT_WEBHOOK_URLConfigured,
                        '输入完整 Webhook URL，如：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
                      )}
                      <Space size={8} wrap>
                        {editingProductLine && (
                          <Button size="small" icon={<SyncOutlined />} loading={weChatWebhookSyncing} onClick={syncWeChatWebhook}>
                            刷新 Webhook 状态
                          </Button>
                        )}
                        <Button
                          size="small"
                          icon={<LinkOutlined />}
                          href="https://developer.work.weixin.qq.com/document/path/91770"
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看企业微信机器人配置说明
                        </Button>
                      </Space>
                      {renderTabActions('通知')}
                    </Space>
                  ),
                },
              ]}
            />
          </Space>
        </Spin>
      </Card>
    );
  };

  const deletePlatformUser = async (user: PlatformUser) => {
    if (authUtils.getUser()?.id === user.id) {
      message.warning('不能删除当前登录账号');
      return;
    }
    setUserSaving(true);
    try {
      await authApi.deleteUser(user.id);
      message.success('用户已删除');
      await loadPlatformUsers();
    } catch (error: any) {
      message.error(error?.error || error?.message || '删除用户失败');
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
    loadProductLines();
    loadRegistrationRequests();
    loadPlatformConfig();
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
            title: '产品线',
            dataIndex: 'productLineName',
            key: 'productLineName',
            width: 140,
            render: (value: string | undefined, record) => value || record.productLineId,
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
            title: '产品线权限',
            dataIndex: 'productLines',
            key: 'productLines',
            render: (_: PlatformUser['productLines'], record) => record.role === 'admin'
              ? <Tag color="gold">全平台管理员</Tag>
              : <Space size={[4, 4]} wrap>{record.productLines.map((item) => <Tag key={item.id}>{item.name} · {{ guest: '游客', tester: '测试', developer: '研发', product: '产品运营', admin: '管理员' }[item.role]}</Tag>)}</Space>,
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
            width: 180,
            render: (_, record) => (
              <Space size="small">
                <Button size="small" icon={<EditOutlined />} onClick={() => openEditUserModal(record)}>
                  编辑
                </Button>
                <Popconfirm
                  title={`确定删除用户“${record.username}”吗？`}
                  description="删除后账号及其登录会话将被永久移除。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true, loading: userSaving }}
                  onConfirm={() => deletePlatformUser(record)}
                  disabled={authUtils.getUser()?.id === record.id}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={authUtils.getUser()?.id === record.id}
                  >
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );

  const renderProductLines = () => (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'clamp(280px, 28%, 360px) minmax(0, 1fr)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <Card
          title="产品列表"
          extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateProductLine}>新增</Button>}
          styles={{ body: { padding: 0 } }}
        >
          <List
            dataSource={productLines}
            locale={{ emptyText: '暂无产品线' }}
            renderItem={(productLine) => {
              const selected = productLineEditorMode === 'edit' && editingProductLine?.id === productLine.id;
              return (
                <List.Item
                  onClick={() => openEditProductLine(productLine)}
                  style={{
                    cursor: 'pointer',
                    padding: '14px 16px',
                    background: selected ? '#e6f4ff' : undefined,
                    borderLeft: selected ? '3px solid #1677ff' : '3px solid transparent',
                  }}
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                      <Text strong>{productLine.name}</Text>
                      {productLine.active ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
                    </Space>
                    <Space size={[4, 4]} wrap>
                      <Text code>{productLine.key}</Text>
                      <Text code>{productLine.projectId}</Text>
                    </Space>
                    <Text type="secondary" ellipsis>
                      {productLine.bundleId || '未配置 Bundle ID'}
                    </Text>
                    <Text type="secondary" ellipsis>
                      {productLine.jenkinsBaseUrl || '未配置 Jenkins 服务'}
                    </Text>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
        {renderProductLineConfigPanel()}
      </div>
    </Space>
  );

  const renderPlatformUsers = () => (
    <Tabs
      defaultActiveKey="users"
      items={[
        {
          key: 'product-lines',
          label: '产品线',
          children: renderProductLines(),
        },
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
        {
          key: 'config',
          label: '平台统一配置',
          children: renderPlatformConfig(),
        },
      ]}
    />
  );

  const renderPlatformConfig = () => (
    <Card
      title="平台统一配置"
      extra={<Button icon={<ReloadOutlined />} onClick={loadPlatformConfig} loading={platformConfigLoading}>刷新</Button>}
    >
      <Alert
        type="warning"
        showIcon
        message="敏感配置仅管理员可管理"
        description="配置保存于平台后端，AI API Key 和发布确认密码不会显示明文，也不会进入 AI 对话或操作审计。"
        style={{ marginBottom: 16 }}
      />
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div>
          <Text strong>修改当前管理员密码</Text>
          <Alert
            type="info"
            showIcon
            message={platformConfig?.adminPassword ? '当前管理员密码已加载，可点击右侧眼睛查看' : '当前管理员密码尚未建立可显示副本'}
            description={platformConfig?.adminPassword
              ? '密码以加密形式保存，仅管理员可查看。'
              : '已有密码此前仅以不可逆哈希保存，无法还原；成功修改一次后即可显示。'}
            style={{ marginTop: 6, marginBottom: 6 }}
          />
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>当前密码</Text>
          <Input.Password
            value={platformConfigForm.currentPassword}
            onChange={(event) => setPlatformConfigForm((current) => ({ ...current, currentPassword: event.target.value }))}
            placeholder="当前密码"
            style={{ marginTop: 6 }}
          />
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8, marginBottom: 4 }}>新密码</Text>
          <Input.Password
            value={platformConfigForm.newAdminPassword}
            onChange={(event) => setPlatformConfigForm((current) => ({ ...current, newAdminPassword: event.target.value }))}
            placeholder="新密码（至少 8 位）"
            style={{ marginTop: 6 }}
          />
        </div>
        <div>
          <Space>
            <Text strong>TestFlight / 苹果商店发布确认密码</Text>
            {platformConfig?.releaseVerificationPasswordConfigured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}
          </Space>
          <Input.Password
            value={platformConfigForm.releaseVerificationPassword}
            onChange={(event) => {
              setPlatformConfigChanged((current) => ({ ...current, release: true }));
              setPlatformConfigForm((current) => ({ ...current, releaseVerificationPassword: event.target.value }));
            }}
            placeholder="输入新密码；留空并保存可清除"
            style={{ marginTop: 6 }}
          />
        </div>
        <div>
          <Space>
            <Text strong>AI OpenAI API Key</Text>
            {platformConfig?.aiApiKeyConfigured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}
          </Space>
          <Input.Password
            value={platformConfigForm.aiApiKey}
            onChange={(event) => {
              setPlatformConfigChanged((current) => ({ ...current, ai: true }));
              setPlatformConfigForm((current) => ({ ...current, aiApiKey: event.target.value }));
            }}
            placeholder="输入新的 API Key；留空并保存可清除"
            style={{ marginTop: 6 }}
          />
        </div>
        <Button type="primary" onClick={savePlatformConfig} loading={platformConfigSaving}>保存统一配置</Button>
      </Space>
    </Card>
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
                          canManageDsym={canManageDsym}
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
            <Text strong>账号默认角色</Text>
            <Select
              value={userForm.role}
              onChange={(role: PlatformRole) => setUserForm((current) => ({
                ...current,
                role,
                productLines: role === 'admin'
                  ? current.productLines
                  : current.productLines.map((item, index) => index === 0 ? { ...item, role } : item),
              }))}
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
          {userForm.role !== 'admin' && (
            <div>
              <Text strong>产品线归属与角色</Text>
              <Select
                mode="multiple"
                value={userForm.productLines.map((item) => item.productLineId)}
                onChange={(ids: string[]) => setUserForm((current) => ({
                  ...current,
                  productLines: ids.map((id) => current.productLines.find((item) => item.productLineId === id) || {
                    productLineId: id,
                    role: 'guest' as PlatformRole,
                  }),
                }))}
                options={productLines.filter((item) => item.active).map((item) => ({ label: item.name, value: item.id }))}
                placeholder="选择该用户可访问的产品线"
                style={{ width: '100%', marginTop: 6 }}
              />
              <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 10 }}>
                {userForm.productLines.map((membership) => (
                  <Space key={membership.productLineId} style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Text>{productLines.find((item) => item.id === membership.productLineId)?.name || membership.productLineId}</Text>
                    <Select
                      value={membership.role}
                      onChange={(role: PlatformRole) => setUserForm((current) => ({
                        ...current,
                        role: current.productLines[0]?.productLineId === membership.productLineId ? role : current.role,
                        productLines: current.productLines.map((item) => item.productLineId === membership.productLineId ? { ...item, role } : item),
                      }))}
                      style={{ width: 150 }}
                      options={[
                        { label: '游客', value: 'guest' },
                        { label: '测试', value: 'tester' },
                        { label: '研发', value: 'developer' },
                        { label: '产品运营', value: 'product' },
                      ]}
                    />
                  </Space>
                ))}
              </Space>
            </div>
          )}
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
  canManageDsym: boolean;
  onDownload: (dsym: DSYMInfo) => void;
  onEditRelations: (dsym: DSYMInfo) => void;
}

function GroupedView({ dsyms, loading, canManageDsym, onDownload, onEditRelations }: GroupedViewProps) {
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
                {canManageDsym && (
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
