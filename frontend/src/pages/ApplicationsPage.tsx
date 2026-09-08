import { applicationServiceCatalog, defaultApplicationServices, selectedServices, ApplicationServiceId } from '../../../backend/src/services/ApplicationServiceCatalog';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { authUtils, type MobileApplication } from '../utils/auth';
import { mobileApplicationApi, componentLibraryApi, type ComponentLibrary } from '../services/api';

const fields = [
  ['repositoryUrl', 'Git 仓库 URL（HTTPS / SSH，无密码）'], ['buildJob', 'Jenkins APK 构建 Job'],
  ['qualityJob', 'Jenkins Smoke Job'], ['buildVariant', 'Gradle 构建变体'],
  ['apkPath', 'APK 相对路径'], ['deviceSerial', 'Android 测试设备序列号'],
];
export default function ApplicationsPage() {
  const [libraries, setLibraries] = useState<ComponentLibrary[]>([]);
  const [apps, setApps] = useState<MobileApplication[]>([]);
  const [editing, setEditing] = useState<MobileApplication | null | undefined>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const product = authUtils.getActiveProductLine();
  const enabled: ApplicationServiceId[] = Form.useWatch('services', form) || [];
  const platform = editing?.platform || 'android';
  const load = async () => { if (product) { const [applications, available] = await Promise.all([mobileApplicationApi.list(product.id), componentLibraryApi.list()]); setApps(applications); setLibraries(available); } };
  useEffect(() => { void load().catch((e) => message.error(e.error || e.message || '加载应用失败')); }, [product?.id]);
  if (!authUtils.isAdmin()) return <Alert type="warning" message="应用接入需要管理员权限" />;
  const open = (app: MobileApplication | null) => { setEditing(app); form.resetFields(); form.setFieldsValue(app ? { ...app, componentLibraryId: app.componentLibraryId || (app.platform === 'ios' ? `ios:${app.productLineId}` : undefined), services: selectedServices(app) } : { platform: 'android', config: { buildVariant: 'debug' }, services: defaultApplicationServices('android', product!.id), serviceOptions: {} }); };
  const save = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    setSaving(true);
    try {
      await mobileApplicationApi.save(product!.id, editing ? { name: values.name, ...(editing.platform === 'android' ? { config: values.config } : {}), services: values.services, serviceOptions: values.serviceOptions, ...(editing.platform === 'ios' ? { componentLibraryId: values.componentLibraryId } : {}) } : { ...values, platform: 'android' }, editing?.id);
      setEditing(undefined); await authUtils.refreshUser(); await load(); message.success('应用配置已保存');
    } catch (e: any) { message.error(e.error || e.response?.data?.error || e.message); }
    finally { setSaving(false); }
  };
  return <Space direction="vertical" size={20} style={{ width: '100%' }}>
    <div><Typography.Title level={3}>应用接入 · {product?.name}</Typography.Title><Typography.Text type="secondary">同一产品线管理 iOS 与 Android，构建、产物和 AI 执行按应用隔离。</Typography.Text></div>
    <Alert type="info" showIcon message="服务按产品线下的每个应用独立选配" description="例如 NN iOS 使用 Sentry、NN Android 使用 Bugly；同一系统的应用可选择共用组件库，Podx 目前仅支持 iOS。启用服务后还需配置对应资源，控制台入口不代表数据同步已接通。" />
    <Card extra={<Button type="primary" disabled={apps.some((app) => app.platform === 'android')} onClick={() => open(null)}>接入 Android 应用</Button>}>
      <Table rowKey="id" dataSource={apps} pagination={false} columns={[
        { title: '应用', dataIndex: 'name' }, { title: '平台', dataIndex: 'platform', render: (value) => <Tag color={value === 'android' ? 'green' : 'blue'}>{value}</Tag> },
        { title: '应用标识', dataIndex: 'packageId' }, { title: '已选服务', render: (_, app) => <Space wrap>{selectedServices(app).map((id) => <Tag key={id}>{applicationServiceCatalog.find((service) => service.id === id)?.name}</Tag>)}</Space> },
        { title: '操作', render: (_, app) => <Space><Button onClick={() => { authUtils.setActiveApplication(app.id); window.location.assign(app.platform === 'android' ? '/android' : '/'); }}>进入应用</Button><Button onClick={() => open(app)}>选配服务</Button></Space> },
      ]} />
    </Card>
    <Modal okText="保存" cancelText="取消" title={editing ? `选配服务 · ${editing.name}` : '接入 Android 应用'} open={editing !== undefined} onCancel={() => setEditing(undefined)} onOk={() => void save()} confirmLoading={saving} width={760} styles={{ body: { maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 } }}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="应用名称" rules={[{ required: true }, { max: 80 }]}><Input /></Form.Item>
        <Form.Item name="packageId" label={platform === 'ios' ? 'Bundle ID（沿用产品线配置）' : 'applicationId（创建后不可修改）'} rules={editing ? [] : [{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/, message: '请输入有效的 applicationId' }]}><Input disabled={Boolean(editing)} placeholder="com.example.app" /></Form.Item>
        <Form.Item name="services" label="启用的服务" getValueFromEvent={(values: ApplicationServiceId[]) => {
          const previous: ApplicationServiceId[] = form.getFieldValue('services') || [];
          let next = [...values];
          const added = next.filter((id) => !previous.includes(id));
          const provider = added.find((id) => id === 'bugly' || id === 'sentry');
          if (provider) next = next.filter((id) => !['bugly', 'sentry'].includes(id) || id === provider);
          for (const id of added) next = [...new Set([...next, ...(applicationServiceCatalog.find((item) => item.id === id)?.requires || [])])];
          if (previous.includes('quality') && ['jenkins', 'devices'].some((id) => !next.includes(id as ApplicationServiceId))) next = next.filter((id) => id !== 'quality');
          return next;
        }}>
          <Checkbox.Group style={{ width: '100%' }}>
            <Space direction="vertical">{applicationServiceCatalog.map((service) => <Checkbox key={service.id} value={service.id} disabled={!service.platforms.includes(platform)}>
              {service.name} {!service.platforms.includes(platform) ? '（当前系统不支持）' : service.nativePlatforms.includes(platform) ? '' : '（仅控制台入口，数据适配待接入）'}
            </Checkbox>)}</Space>
          </Checkbox.Group>
        </Form.Item>
        {platform === 'ios' && enabled.includes('podx') && <>
          <Form.Item name="componentLibraryId" label="共用组件库" rules={[{ required: true, message: '请选择组件库' }]}>
            <Select options={libraries.filter((library) => library.platform === platform).map((library) => ({ value: library.id, label: library.name }))} />
          </Form.Item>
          <Typography.Paragraph type="secondary">多个产品线选择同一个库即可共用组件版本、Nexus 和 Specs 资源。库资源由来源产品线维护，主工程和构建仍使用当前产品线配置；切换保留原库数据。</Typography.Paragraph>
        </>}
        {(['bugly', 'sentry'] as const).filter((id) => enabled.includes(id)).map((id) => <div key={id}>
          <Form.Item name={['serviceOptions', id, 'appId']} label={`${id === 'bugly' ? 'Bugly App ID' : 'Sentry 应用备注标识'}`}><Input /></Form.Item>
          <Form.Item name={['serviceOptions', id, 'consoleUrl']} label={`${id === 'bugly' ? 'Bugly' : 'Sentry'} 控制台 URL（不得包含密钥）`}><Input placeholder="填写该应用实际的控制台地址" /></Form.Item>
          <Typography.Paragraph type="secondary">{id === 'sentry' && platform === 'ios' ? 'Sentry 数据接入沿用此产品线已有的 Sentry 服务地址、组织、项目和凭据；控制台 URL 仅用于页面跳转。' : '当前仅提供控制台跳转；问题查询、同步与 AI 数据诊断仍需后续适配。'}</Typography.Paragraph>
        </div>)}
        {platform === 'android' && enabled.includes('jenkins') && fields.map(([name, label]) => <Form.Item key={name} name={['config', name]} label={label}><Input /></Form.Item>)}
      </Form>
    </Modal>
  </Space>;
}
