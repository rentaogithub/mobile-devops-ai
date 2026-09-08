import { Alert, Button, Card, Empty, Space, Tag, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { applicationServiceCatalog, selectedServices } from '../../../backend/src/services/ApplicationServiceCatalog';
import { authUtils } from '../utils/auth';
export default function ApplicationServicesPage() {
  const app = authUtils.getActiveApplication();
  const navigate = useNavigate();
  const location = useLocation();
  const selected = selectedServices(app);
  const services = applicationServiceCatalog.filter((service) => selected.includes(service.id) && (location.pathname !== '/bugly' || service.id === 'bugly'));
  return <Space direction="vertical" size={20} style={{ width: '100%' }}>
    <Typography.Title level={3}>应用服务 · {app?.name || '当前应用'}</Typography.Title>
    <Alert type="info" showIcon message="每个产品线的 iOS、Android 应用独立选配服务" description="服务启用、资源配置和数据接通是不同状态。服务停用后保留已有配置与历史记录，接口和 AI 调用会重新校验。" />
    {authUtils.isAdmin() && <Button onClick={() => navigate('/applications')}>配置当前应用的服务</Button>}
    {!services.length && <Empty description="当前应用尚未启用服务，可由管理员按需选配。" />}
    {services.map((service) => {
      const options = service.id === 'sentry' || service.id === 'bugly' ? app?.serviceOptions?.[service.id] : undefined;
      let consoleUrl = '';
      try { const url = new URL(options?.consoleUrl || ''); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) consoleUrl = url.href; } catch { /* No configured console. */ }
      const native = service.nativePlatforms.includes(app?.platform || 'ios');
      return <Card key={service.id} title={<Space>{service.name}<Tag color={native ? 'blue' : 'gold'}>{native ? '已启用，需对应资源配置' : '数据适配待接入'}</Tag></Space>}>
        <Typography.Paragraph>{service.description}</Typography.Paragraph>
        {options?.appId && <Typography.Paragraph>服务应用标识：{options.appId}</Typography.Paragraph>}
        {consoleUrl ? <Button href={consoleUrl} target="_blank" rel="noopener noreferrer">打开 {service.name} 控制台</Button> : !native && <Typography.Text type="secondary">尚未配置该应用的控制台地址。</Typography.Text>}
        {service.id === 'sentry' && native && authUtils.hasRole('developer') && <Button onClick={() => navigate('/sentry-service')}>进入 Sentry 服务</Button>}
      </Card>;
    })}
  </Space>;
}
