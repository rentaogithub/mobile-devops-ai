import { useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Input, List, message, Row, Space, Table, Tag, Typography } from 'antd';
import {
  BranchesOutlined,
  CodeOutlined,
  CopyOutlined,
  SearchOutlined,
  ToolOutlined,
} from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;
const INSTALL_SCRIPT_PATH = '/install-cocoapods-podx.sh';

interface CommandItem {
  title: string;
  command: string;
  description: string;
  category: string;
}

interface ToolSection {
  key: string;
  name: string;
  icon: React.ReactNode;
  tags: string[];
  description: string;
  commands: CommandItem[];
  allCommands: CommandItem[];
}

const toolSections: ToolSection[] = [
  {
    key: 'podx',
    name: 'podx 工具链',
    icon: <ToolOutlined />,
    tags: ['CocoaPods', '多产品线', '组件发布'],
    description: '读取当前主工程的 podx.config.yml，用于对应产品线的组件依赖、发布、校验和本地工具链维护。',
    commands: [
      {
        title: '查看 podx 帮助',
        command: 'podx help',
        description: '查看 podx 支持的全部子命令和参数。',
        category: '帮助',
      },
      {
        title: '查看 podx 版本',
        command: 'podx version',
        description: '确认当前 podx 工具版本，排查本地工具链是否过旧。',
        category: '安装',
      },
      {
        title: '安装项目依赖',
        command: 'podx install',
        description: '按项目 Podfile 和 podx 配置安装 CocoaPods 依赖。',
        category: '依赖',
      },
      {
        title: '清理本地缓存',
        command: 'podx clean',
        description: '清理 podx 相关缓存和临时文件，处理依赖状态异常。',
        category: '清理',
      },
      {
        title: '检查 CocoaPods / overlay 状态',
        command: 'podx doctor',
        description: '检查 CocoaPods、overlay、本地组件源等项目依赖环境。',
        category: '检查',
      },
      {
        title: '发布前校验',
        command: 'podx dry-run publish',
        description: '发布组件前先做本地校验，提前发现 podspec 或依赖问题。',
        category: '发布',
      },
      {
        title: '发布组件',
        command: 'podx publish',
        description: '将当前组件版本发布到内部组件源。',
        category: '发布',
      },
    ],
    allCommands: [
      {
        title: '帮助',
        command: 'podx help',
        description: '查看命令帮助。',
        category: '帮助',
      },
      {
        title: '初始化工程',
        command: 'podx init',
        description: '一键初始化工程配置、规则、技能、流程、AI 上下文和 hooks。',
        category: '初始化',
      },
      {
        title: '同步工程配置',
        command: 'podx sync',
        description: '同步团队规则、技能、流程、AI 上下文和 hooks。',
        category: '同步',
      },
      {
        title: '版本',
        command: 'podx version',
        description: '查看当前 podx 版本。',
        category: '安装',
      },
      {
        title: '升级',
        command: 'podx upgrade',
        description: '升级 podx 工具链。',
        category: '安装',
      },
      {
        title: '环境检查',
        command: 'podx doctor',
        description: '检查 CocoaPods、overlay 和本地依赖环境。',
        category: '检查',
      },
      {
        title: '查看主 Podfile',
        command: 'podx main',
        description: '查看主 Podfile 中的内部组件 pod 配置。',
        category: '依赖',
      },
      {
        title: '首次创建 overlay',
        command: 'podx --create-overlay-file',
        description: '在主工程根目录创建 Podfile.overlay 模板，并自动加入 Xcode 工程引用。',
        category: 'Overlay',
      },
      {
        title: '查看依赖关系',
        command: 'podx deps',
        description: '查看主工程依赖组件分支、版本和组件依赖关系。',
        category: '依赖',
      },
      {
        title: '切本地源码',
        command: 'podx <PodName>',
        description: '将指定组件切换到本地源码依赖。',
        category: '依赖',
      },
      {
        title: '安装依赖',
        command: 'podx install',
        description: '安装当前项目 Pods 依赖。',
        category: '依赖',
      },
      {
        title: '更新 Specs',
        command: 'podx repo update',
        description: '更新 Specs 仓库，等同 pod repo update。',
        category: '依赖',
      },
      {
        title: '更新 Pod',
        command: 'podx update <PodName>',
        description: '更新 Pod；命中本地组件时先更新本地仓库。',
        category: '依赖',
      },
      {
        title: '清理缓存',
        command: 'podx clean <PodName>',
        description: '清理指定组件 pod cache，并删除 Pods/PodName。',
        category: '清理',
      },
      {
        title: '规则检查',
        command: 'podx rules check',
        description: '检查 .gitignore 是否符合规则器治理。',
        category: '规则',
      },
      {
        title: '规则同步',
        command: 'podx rules sync',
        description: '补齐 .gitignore 中缺失的本地产物规则。',
        category: '规则',
      },
      {
        title: '规则快照',
        command: 'podx rules snapshot',
        description: '生成 .podx/rules_snapshot.json 规则快照。',
        category: '规则',
      },
      {
        title: '规则 CI',
        command: 'podx rules ci',
        description: 'CI 门禁：生成规则快照，失败时返回非 0。',
        category: '规则',
      },
      {
        title: 'Pipeline 能力地图',
        command: 'podx pipeline',
        description: '查看团队 CI/CD 能力地图。',
        category: 'CI/CD',
      },
      {
        title: 'Pipeline 主流程',
        command: 'podx pipeline flow',
        description: '查看开发和发布主流程。',
        category: 'CI/CD',
      },
      {
        title: 'Pipeline 脚本',
        command: 'podx pipeline script',
        description: '生成 .podx/pipeline_ci.sh，内置快照、报告和总门禁。',
        category: 'CI/CD',
      },
      {
        title: 'Pipeline 检查',
        command: 'podx pipeline doctor',
        description: '检查团队 CI 脚本是否存在、可执行且与模板一致。',
        category: 'CI/CD',
      },
      {
        title: 'Pipeline 总门禁',
        command: 'podx pipeline gate',
        description: '汇总产物状态，失败时返回非 0。',
        category: 'CI/CD',
      },
      {
        title: 'Skill 列表',
        command: 'podx skill list',
        description: '查看团队 iOS DevOps skill library。',
        category: 'Skill',
      },
      {
        title: 'Skill 详情',
        command: 'podx skill show <Name>',
        description: '查看指定 skill 详情和执行步骤。',
        category: 'Skill',
      },
      {
        title: 'Skill 执行计划',
        command: 'podx skill plan <Name>',
        description: '展开 skill 执行计划，不执行任务。',
        category: 'Skill',
      },
      {
        title: 'Skill 执行',
        command: 'podx skill run <Name>',
        description: '执行已验证的浅层 skill。',
        category: 'Skill',
      },
      {
        title: 'AI 初始化',
        command: 'podx ai init',
        description: '生成 Claude Code/Codex CodeGraph MCP 接入模板。',
        category: 'AI',
      },
      {
        title: 'AI 更新',
        command: 'podx ai update',
        description: '更新 Codex CodeGraph MCP，并检查改动影响。',
        category: 'AI',
      },
      {
        title: 'AI 检查',
        command: 'podx ai doctor',
        description: '检查 AI 辅助工具状态。',
        category: 'AI',
      },
      {
        title: 'AI MCP',
        command: 'podx ai mcp',
        description: '输出 Hermes MCP 注册说明。',
        category: 'AI',
      },
      {
        title: 'Hooks 安装',
        command: 'podx hooks install',
        description: '安装版本化提交保护 hook。',
        category: 'Hooks',
      },
      {
        title: '打开工程',
        command: 'podx open',
        description: '打开当前工程 .xcworkspace。',
        category: '工程',
      },
      {
        title: '打开 overlay',
        command: 'podx open --overlay',
        description: '打开 Podfile.overlay。',
        category: '工程',
      },
      {
        title: '发布前校验',
        command: 'podx dry-run publish',
        description: '发布前执行校验流程。',
        category: '发布',
      },
      {
        title: '发布组件',
        command: 'podx publish',
        description: '通过 Jenkins 发布组件。',
        category: '发布',
      },
      {
        title: '发布历史',
        command: 'podx publish history',
        description: '查看 Jenkins 最近构建列表。',
        category: '发布',
      },
      {
        title: '发布日志',
        command: 'podx publish log',
        description: '查看 Jenkins 构建日志。',
        category: '发布',
      },
      {
        title: '发布诊断',
        command: 'podx publish doctor',
        description: '分析 Jenkins 打包失败原因。',
        category: '发布',
      },
      {
        title: '发布修复',
        command: 'podx publish fix',
        description: '半自动修复低风险 Jenkins 打包失败。',
        category: '发布',
      },
    ],
  },
  {
    key: 'mgit',
    name: 'mgit 工具链',
    icon: <BranchesOutlined />,
    tags: ['多产品线', '组件仓库', '批量操作'],
    description: '读取与 podx 相同的产品线配置，对当前产品线的主仓库和组件仓库执行批量拉取、分支切换与差异检查。',
    commands: [
      {
        title: '查看 mgit 帮助',
        command: 'mgit help',
        description: '查看 mgit 支持的批量仓库操作命令。',
        category: '帮助',
      },
      {
        title: '批量查看状态',
        command: 'mgit status',
        description: '查看工作区内多个仓库的变更状态。',
        category: '状态',
      },
      {
        title: '批量拉取',
        command: 'mgit pull',
        description: '同步工作区内多个仓库的远端更新。',
        category: '同步',
      },
      {
        title: '查看分支',
        command: 'mgit branch',
        description: '查看各仓库当前分支，确认是否处在预期开发线。',
        category: '分支',
      },
      {
        title: '切换分支',
        command: 'mgit checkout <branch>',
        description: '将工作区内仓库切换到指定分支，适合统一开发线或发布线。',
        category: '分支',
      },
      {
        title: '批量推送',
        command: 'mgit push',
        description: '将工作区内仓库的本地提交推送到远端。',
        category: '同步',
      },
      {
        title: '批量发布',
        command: 'mgit publish',
        description: '按项目发布流程批量处理多仓库发布任务。',
        category: '发布',
      },
    ],
    allCommands: [
      {
        title: '帮助',
        command: 'mgit help',
        description: '查看 mgit 命令帮助。',
        category: '帮助',
      },
      {
        title: '状态',
        command: 'mgit status',
        description: '批量查看仓库状态。',
        category: '状态',
      },
      {
        title: '拉取',
        command: 'mgit pull',
        description: '批量拉取远端更新。',
        category: '同步',
      },
      {
        title: '推送',
        command: 'mgit push',
        description: '批量推送本地提交。',
        category: '同步',
      },
      {
        title: '分支',
        command: 'mgit branch',
        description: '批量查看当前分支。',
        category: '分支',
      },
      {
        title: '切换分支',
        command: 'mgit checkout <branch>',
        description: '批量切换到指定分支。',
        category: '分支',
      },
      {
        title: '创建并切换分支',
        command: 'mgit checkout -b <branch>',
        description: '组合创建并切换本地新分支。',
        category: '分支',
      },
      {
        title: '合并分支',
        command: 'mgit merge <branch>',
        description: '合并来源分支到当前同名分支组件仓库。',
        category: '分支',
      },
      {
        title: '指定仓库合并',
        command: 'mgit merge <PodName> <branch>',
        description: '只合并指定组件仓库的来源分支。',
        category: '分支',
      },
      {
        title: '保存工作区',
        command: 'mgit stash',
        description: '组合执行 git stash push -u。',
        category: '暂存',
      },
      {
        title: '查看 stash',
        command: 'mgit stash list',
        description: '查看各仓库 stash 列表。',
        category: '暂存',
      },
      {
        title: '恢复 stash',
        command: 'mgit stash apply <PodName>',
        description: '只恢复指定仓库 stash，不提供全量 apply/pop。',
        category: '暂存',
      },
      {
        title: '查看差异',
        command: 'mgit diff',
        description: '组合查看 git diff。',
        category: '差异',
      },
      {
        title: '查看日志',
        command: 'mgit log',
        description: '组合查看最近 5 条 git log。',
        category: '历史',
      },
      {
        title: '暂存变更',
        command: 'mgit add .',
        description: '组合执行 git add -A。',
        category: '提交',
      },
      {
        title: '发布',
        command: 'mgit publish',
        description: '批量执行发布相关流程。',
        category: '发布',
      },
      {
        title: '提交',
        command: 'mgit commit -m "msg"',
        description: '组合提交主工程和本地组件仓库。',
        category: '提交',
      },
      {
        title: '提交受保护文件',
        command: 'mgit commit -m "msg" -edit Podfile',
        description: '显式允许提交受保护文件，例如 Podfile。',
        category: '提交',
      },
      {
        title: '继续 rebase',
        command: 'mgit rebase --continue',
        description: '继续当前冲突修复后的 rebase。',
        category: '同步',
      },
      {
        title: '放弃 rebase',
        command: 'mgit rebase --abort',
        description: '放弃当前 rebase。',
        category: '同步',
      },
    ],
  },
];

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 局域网 HTTP 页面不属于安全上下文，回退到兼容复制方案。
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.top = '0';
  textArea.style.left = '-9999px';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}

export default function DevOpsPage() {
  const [searchKeyword, setSearchKeyword] = useState('');
  const installScriptUrl = `${window.location.origin}${INSTALL_SCRIPT_PATH}`;
  const installCommand = `/bin/bash -c "$(curl -fsSL ${installScriptUrl})"`;
  const upgradeCommand = 'podx upgrade';
  const normalizedKeyword = searchKeyword.trim().toLocaleLowerCase();

  const filteredSections = useMemo(() => toolSections.map((section) => {
    if (!normalizedKeyword) {
      return { ...section, visibleCommands: section.commands };
    }

    const sectionMatched = [section.key, section.name, section.description, ...section.tags]
      .some((value) => value.toLocaleLowerCase().includes(normalizedKeyword));
    const visibleCommands = section.allCommands.filter((command) => (
      sectionMatched || [command.title, command.command, command.description, command.category]
        .some((value) => value.toLocaleLowerCase().includes(normalizedKeyword))
    ));

    return { ...section, visibleCommands };
  }).filter((section) => !normalizedKeyword || section.visibleCommands.length > 0), [normalizedKeyword]);

  const filteredAllToolCommands = useMemo(() => toolSections.flatMap((section) => {
    const sectionMatched = !normalizedKeyword || [section.key, section.name, section.description, ...section.tags]
      .some((value) => value.toLocaleLowerCase().includes(normalizedKeyword));
    const commands = section.allCommands.filter((command) => (
      sectionMatched || [command.title, command.command, command.description, command.category]
        .some((value) => value.toLocaleLowerCase().includes(normalizedKeyword))
    ));

    return commands.map((command, index) => ({
      ...command,
      tool: section.key,
      toolRowSpan: index === 0 ? commands.length : 0,
    }));
  }), [normalizedKeyword]);

  const copyCommand = async (command: string) => {
    const copied = await copyTextToClipboard(command);
    if (copied) message.success('命令已复制');
    else message.error('复制失败，请手动选中命令复制');
  };

  const renderCommandList = (items: CommandItem[]) => (
    <List
      itemLayout="vertical"
      dataSource={items}
      renderItem={(item) => (
        <List.Item
          actions={[
            <Button
              key="copy"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copyCommand(item.command)}
            >
              复制
            </Button>,
          ]}
        >
          <List.Item.Meta
            title={
              <Space wrap>
                <span>{item.title}</span>
                <Tag>{item.category}</Tag>
              </Space>
            }
            description={item.description}
          />
          <Text code style={{ fontSize: 13 }}>
            {item.command}
          </Text>
        </List.Item>
      )}
    />
  );

  return (
    <div>
      <Space align="center" style={{ marginBottom: 8 }}>
        <CodeOutlined style={{ color: '#1677ff', fontSize: 22 }} />
        <Title level={2} style={{ margin: 0 }}>
          DevOps 技能库
        </Title>
      </Space>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        面向多产品线汇总日常 DevOps 工具链用法；podx 与 mgit 共用各主工程根目录的 podx.config.yml。
      </Paragraph>

      <Card
        title={
          <Space>
            <ToolOutlined style={{ color: '#1677ff' }} />
            <span>安装 cocoapods-podx 插件</span>
          </Space>
        }
        style={{ marginBottom: 16, borderRadius: 8 }}
      >
        <Paragraph type="secondary">
          使用服务内置的安装脚本安装 cocoapods-podx，并生成 podx、mgit 命令入口。
        </Paragraph>
        <Text strong>安装</Text>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 8,
            background: '#141414',
            overflowX: 'auto',
            marginTop: 8,
          }}
        >
          <Text style={{ color: '#52c41a', fontFamily: 'Menlo, Monaco, Consolas, monospace' }}>$</Text>
          <Text
            copyable={false}
            style={{
              color: '#f5f5f5',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {installCommand}
          </Text>
          <Button size="small" icon={<CopyOutlined />} onClick={() => copyCommand(installCommand)}>
            复制
          </Button>
        </div>
        <Text strong style={{ display: 'block', marginTop: 16 }}>升级</Text>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 8,
            background: '#141414',
            overflowX: 'auto',
            marginTop: 8,
          }}
        >
          <Text style={{ color: '#52c41a', fontFamily: 'Menlo, Monaco, Consolas, monospace' }}>$</Text>
          <Text
            copyable={false}
            style={{
              color: '#f5f5f5',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {upgradeCommand}
          </Text>
          <Button size="small" icon={<CopyOutlined />} onClick={() => copyCommand(upgradeCommand)}>
            复制
          </Button>
        </div>
      </Card>

      <Card
        title={(
          <Space>
            <BranchesOutlined style={{ color: '#1677ff' }} />
            <span>新产品线接入步骤</span>
          </Space>
        )}
        style={{ marginBottom: 16, borderRadius: 8 }}
        extra={<Button type="link" href="/roles">打开产品线配置</Button>}
      >
        <Alert
          type="info"
          showIcon
          message="每条产品线独立配置、独立授权、独立发布"
          description="同一套 podx / mgit 工具支持所有产品线，无需重复安装；平台会将每条产品线的 podx.config.yml 同步到各自的主工程根目录。"
          style={{ marginBottom: 16 }}
        />
        <ol style={{ margin: 0, paddingLeft: 22, lineHeight: 1.9 }}>
          <li><Text strong>准备接入资料：</Text>产品线标识、名称、Workflow 项目标识、Bundle ID，以及主仓库、私有 Specs 源、组件仓库和 Jenkins 信息。</li>
          <li><Text strong>创建产品线：</Text>管理员进入“配置管理 → 产品线 → 新增”，填写基础信息。产品线标识创建后不可修改。</li>
          <li><Text strong>配置 Jenkins：</Text>填写服务地址、API 用户与 Token、构建 Job、自动质检 Job 和 iOS 主仓库地址。</li>
          <li><Text strong>配置 podx / mgit：</Text>填写私有 Specs 源、主仓库地址和发布基准分支，并添加该产品线的全部组件仓库。</li>
          <li><Text strong>同步工程配置：</Text>保存后平台自动将扁平结构的 podx.config.yml 写入主工程根目录；失败时点击“重新同步 podx.config.yml”。</li>
          <li><Text strong>首次创建 overlay：</Text>进入主工程根目录执行 podx --create-overlay-file，生成与 Podfile 同级的 Podfile.overlay；空 overlay 表示全部组件使用远端依赖。</li>
          <li><Text strong>配置发布渠道（可选）：</Text>按需填写蒲公英 API Key/短链，或 App Store Issuer ID、原始 .p8 私钥和数字 App ID，再从 Apple 获取 TestFlight 测试组。</li>
          <li><Text strong>配置通知（可选）：</Text>填写该产品线使用的企业微信机器人 Webhook。</li>
          <li><Text strong>分配成员权限：</Text>进入“用户角色”，为用户添加该产品线并设置游客、测试、研发或产品运营角色。</li>
          <li><Text strong>验证接入：</Text>顶部切换到新产品线确认数据与菜单隔离；进入主工程执行 podx doctor、podx install 和 mgit status。</li>
        </ol>
        <Alert
          type="success"
          showIcon
          message="Podfile.overlay 如何使用"
          description={(
            <div style={{ lineHeight: 1.9 }}>
              <div><Text code>podx --create-overlay-file</Text> 首次创建模板；只需执行一次。</div>
              <div><Text code>podx list</Text> 查看本地/远端状态，切换后执行 <Text code>podx install</Text> 更新工程依赖。</div>
              <div>overlay 中只保留 <Text code>pod 'PodName'</Text>，不要填写 localWork、branch 或本地路径；它是开发者本地切换文件，应纳入 .gitignore。</div>
            </div>
          )}
          style={{ marginTop: 16 }}
        />
        <Space wrap style={{ marginTop: 14 }}>
          <Tag color="blue">配置隔离</Tag>
          <Tag color="purple">仓库隔离</Tag>
          <Tag color="green">发布流程隔离</Tag>
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 14, marginBottom: 0 }}>
          必填项取决于启用能力：基础信息必须配置；使用 CI/CD 时配置 Jenkins；使用组件工具链时配置 podx / mgit；蒲公英、App Store 和通知均可按产品线选择启用。
        </Paragraph>
      </Card>

      <Card
        size="small"
        title={(
          <Space>
            <SearchOutlined style={{ color: '#1677ff' }} />
            <span>快速查询</span>
          </Space>
        )}
        style={{ marginBottom: 16, borderRadius: 8 }}
      >
        <Input
          allowClear
          size="large"
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="输入工具、命令、功能或分类，如 overlay、发布、mgit status"
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
        />
        <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>
          {normalizedKeyword
            ? `已找到 ${filteredAllToolCommands.length} 个匹配功能，工具卡片与全部功能表已同步筛选。`
            : '支持按 podx / mgit、命令、功能名、分类和说明快速查询。'}
        </Paragraph>
      </Card>

      <Row gutter={[16, 16]}>
        {filteredSections.map((section) => (
          <Col xs={24} lg={12} key={section.key}>
            <Card
              title={
                <Space>
                  <span style={{ color: '#1677ff' }}>{section.icon}</span>
                  <span>{section.name}</span>
                </Space>
              }
              style={{ height: '100%', borderRadius: 8 }}
            >
              <Paragraph type="secondary">{section.description}</Paragraph>
              <Space wrap style={{ marginBottom: 16 }}>
                {section.tags.map((tag) => (
                  <Tag color="blue" key={tag}>
                    {tag}
                  </Tag>
                ))}
              </Space>

              <Title level={5} style={{ marginTop: 0 }}>
                {normalizedKeyword ? `查询结果（${section.visibleCommands.length}）` : '常用功能'}
              </Title>
              {renderCommandList(section.visibleCommands)}
            </Card>
          </Col>
        ))}
        {filteredSections.length === 0 && (
          <Col span={24}>
            <Card style={{ borderRadius: 8 }}>
              <Empty description={`未找到与“${searchKeyword.trim()}”相关的功能`} />
            </Card>
          </Col>
        )}
      </Row>

      <Card
        title="全部功能表"
        style={{ marginTop: 16, borderRadius: 8 }}
      >
        <Table
          size="small"
          pagination={false}
          scroll={{ x: 1120 }}
          rowKey={(item) => `${item.tool}-${item.command}`}
          dataSource={filteredAllToolCommands}
          locale={{ emptyText: normalizedKeyword ? `未找到与“${searchKeyword.trim()}”相关的功能` : '暂无功能' }}
          columns={[
            {
              title: '工具',
              dataIndex: 'tool',
              key: 'tool',
              width: 100,
              render: (tool: string, item) => ({
                children: <Tag color={tool === 'podx' ? 'blue' : 'purple'}>{tool}</Tag>,
                props: {
                  rowSpan: item.toolRowSpan,
                },
              }),
            },
            {
              title: '功能',
              dataIndex: 'title',
              key: 'title',
              width: 140,
            },
            {
              title: '分类',
              dataIndex: 'category',
              key: 'category',
              width: 100,
              render: (category: string) => <Tag>{category}</Tag>,
            },
            {
              title: '命令',
              dataIndex: 'command',
              key: 'command',
              width: 260,
              render: (command: string) => (
                <Text code style={{ whiteSpace: 'nowrap' }}>
                  {command}
                </Text>
              ),
            },
            {
              title: '说明',
              dataIndex: 'description',
              key: 'description',
              width: 430,
            },
            {
              title: '操作',
              key: 'action',
              width: 90,
              render: (_, item) => (
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyCommand(item.command)}
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
