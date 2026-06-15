# Scripts

## Sonic

日常只使用统一入口：

```bash
sh scripts/sonic/sonic.sh start
sh scripts/sonic/sonic.sh check
sh scripts/sonic/sonic.sh stop
```

`scripts/sonic/sonic.sh` 会调度下面这些内部子脚本：

| 脚本 | 用途 |
| --- | --- |
| `scripts/sonic/bootstrap.sh` | 一键启动 Sonic Server/Web + Agent，并输出诊断 |
| `scripts/sonic/init-stack-env.sh` | 初始化 `deploy/sonic/.env` |
| `scripts/sonic/start-stack.sh` | 启动 Sonic Server/Web Docker 服务 |
| `scripts/sonic/prepare-agent.sh` | 下载/解压 Sonic Agent，生成 `start.sh` |
| `scripts/sonic/start-agent.sh` | 启动 Sonic Agent |
| `scripts/sonic/check.sh` | 诊断 Sonic Server/Web、平台代理和 Agent 线索 |
| `scripts/sonic/ios-quality.sh` | Jenkins 自动质检执行脚本 |

除非要单独排查某一层，平时不要直接调用内部子脚本。
