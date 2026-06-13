# Sonic 子服务部署

`nn-ios-platform` 统一管理 Sonic 的部署入口，但 Sonic 仍然作为独立服务运行，便于后续升级、扩容 Agent 和维护设备池。

## 服务关系

```text
nn-ios-platform
  -> 统一对外暴露 http://10.1.3.177:5173/sonic-admin 和 /sonic-api
  -> 保存 Sonic API / Web 地址
  -> 管理设备池映射
  -> 触发 Jenkins 自动质检

Jenkins nn-auto-quality
  -> 下载 IPA
  -> 调用 Sonic API

Sonic
  -> 管理 iOS 真机、设备分组、测试计划和报告
```

## 初始化配置

```bash
cd deploy/sonic
cp .env.example .env
```

编辑 `.env`：

- `SONIC_WEB_IMAGE`：Sonic Web 后台镜像
- `SONIC_SERVER_IMAGE`：Sonic Server/API 镜像
- `SONIC_HOST`：部署主机 IP，例如 `10.1.3.177`
- `SONIC_WEB_PORT`：Sonic 后台端口，默认 `3002`
- `SONIC_API_PORT`：Sonic API 端口，默认 `8094`
- `SONIC_MYSQL_PASSWORD` / `SONIC_MYSQL_ROOT_PASSWORD`：数据库密码

> 镜像名故意放在 `.env`，不写死在平台代码里。Sonic 官方服务拆分或镜像命名变化时，只需要调整 `.env`。

## 启动

```bash
docker compose --env-file .env up -d
```

## 停止

```bash
docker compose --env-file .env down
```

## 平台环境变量

在 `backend/.env` 中配置：

```bash
SONIC_API_BASE=http://10.1.3.177:5173/sonic-api
SONIC_WEB_URL=http://10.1.3.177:5173/sonic-admin
SONIC_API_PROXY_TARGET=http://127.0.0.1:8094
SONIC_WEB_PROXY_TARGET=http://127.0.0.1:3002
SONIC_TOKEN=
SONIC_PROJECT_ID=
SONIC_TEST_PLAN_ID=
```

## 真机接入

iOS 真机通常接在 Mac mini 上，由 Sonic Agent 管理。Sonic Server 可以部署在 `10.1.3.177`，Agent 可以部署在接真机的 Mac 上。

推荐维护方式：

1. 在 Sonic 后台接入真机。
2. 在 Sonic 后台创建设备分组。
3. 把真机加入对应分组。
4. 在 `nn-ios-platform -> CI/CD -> 自动质检 -> 设备池管理` 中配置 Sonic 分组 ID。
5. 触发质检时平台把 `SONIC_DEVICE_GROUP_ID` 传给 Jenkins。
