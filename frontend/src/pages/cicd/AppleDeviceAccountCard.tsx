import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Space, Tag, Typography, message } from 'antd';
import { AppleDeviceConfigStatus, appleDeviceApi } from '../../services/api';

export function AppleDeviceAccountCard() {
  const [status, setStatus] = useState<AppleDeviceConfigStatus | null>(null);
  const [teamId, setTeamId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let active = true;
    void appleDeviceApi.status().then((response) => {
      if (!active) return;
      const data = response.data || null;
      setStatus(data);
      setTeamId(data?.requiredTeamId || data?.teamId || '');
      setIssuerId(data?.issuerId || '');
      setEditing(!data?.configured);
    }).catch((err) => {
      if (active) setError(err?.error || err?.message || '读取设备注册账号失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await appleDeviceApi.updateConfig({ teamId: teamId.trim(), issuerId: issuerId.trim(), keyFile });
      message.success('开发联调团队已验证并保存');
      // Reset all device lists, enrollment and in-flight lookup state for the new account.
      window.location.reload();
    } catch (err: any) {
      setError(err?.error || err?.message || '保存设备注册账号失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card loading={loading} title="开发联调设备注册账号" extra={status?.configured && <Button onClick={() => setEditing(!editing)}>更新凭据</Button>}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {status?.requiredTeamId
            ? `扫码采集、设备查询及注册仅使用武汉团队（Wuhan Qimiao Technology Co., Ltd. · ${status.requiredTeamId}），用于蒲公英开发联调包。`
            : '使用蒲公英安装包签名团队的 API Key 注册设备。设备注册账号与 App Store / TestFlight 发布账号分别配置。'}
        </Typography.Text>
        {status?.configured
          ? <Tag color="green">当前团队：{status.teamId}</Tag>
          : <Alert showIcon type="warning" message="尚未配置开发联调团队，设备注册暂不可用" />}
        {error && <Alert showIcon type="error" message={error} />}
        {status?.warnings?.map((warning) => <Alert key={warning} showIcon type="warning" message={warning} />)}
        {editing && <>
          {status?.requiredTeamId
            ? <Typography.Text strong>固定团队：武汉 · {status.requiredTeamId}</Typography.Text>
            : <label>Team ID<Input aria-label="设备注册 Team ID" value={teamId} onChange={(event) => setTeamId(event.target.value)} /></label>}
          <label>Issuer ID<Input aria-label="设备注册 Issuer ID" value={issuerId} onChange={(event) => setIssuerId(event.target.value)} placeholder="目标团队 App Store Connect → 用户和访问 → 集成 → Team Keys" /></label>
          <label>AuthKey 私钥<Input aria-label="设备注册 AuthKey 私钥" type="file" accept=".p8" onChange={(event) => setKeyFile(event.target.files?.[0] || null)} /></label>
          <Typography.Text type="secondary">请使用原始 AuthKey_*.p8 文件名。保存前会核对私钥所属团队，私钥加密存储。</Typography.Text>
          <Button type="primary" loading={saving} disabled={!teamId.trim() || !issuerId.trim() || (!keyFile && !status?.configured)} onClick={() => void save()}>验证团队并保存</Button>
        </>}
      </Space>
    </Card>
  );
}
