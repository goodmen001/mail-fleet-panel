# Mail Fleet Panel

cloud-mail 多站点部署与管理面板。围绕 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 构建。

## 功能模块

| 模块 | 说明 |
|------|------|
| 🔐 用户中心 | 面板自身的用户注册/登录/角色（admin/user），只有面板用户可操作全部功能 |
| 🚀 部署中心 | Cloudflare 凭证库（AES-256 加密存储）→ 批量部署 cloud-mail：D1/KV/Worker/域名/Email Routing 一条龙 |
| 🖥 站点管理 | 接入多个 cloud-mail 站点（地址+管理员账号），健康检查，内嵌原版控制台 + 站点切换 |
| 🔄 版本中心 | 检查上游更新，与「定制文件清单」diff；无冲突可安全升级，有冲突列出冲突文件并阻止升级 |

## 快速开始

### Docker Compose（推荐）

```bash
cd docker
PANEL_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

或直接拉取预构建镜像（免本地构建）：

```bash
mkdir -p data && curl -LO https://raw.githubusercontent.com/goodmen001/mail-fleet-panel/master/docker/docker-compose.standalone.yml
docker compose -f docker-compose.standalone.yml up -d
```

访问 `http://localhost:3300`，默认账号 `admin / admin123`，**登录后立即改密**。

#### 数据持久化与升级

站点、凭证、用户、配置、部署包全部存在宿主机 `./data`（容器内 `/app/data`）。
凭证加密密钥保存在 `./data/panel_secret`（首次启动自动生成）。

升级镜像版本（数据不丢）：

```bash
docker compose pull && docker compose up -d
```

⚠️ `PANEL_SECRET` 一旦设置就不要更换：更换后已保存的凭证将无法解密（面板会报错），
必须重新录入凭证。不设置该变量也可，面板会自动生成并固定。

### 本地开发

```bash
# 后端
cd server && npm install && npm run dev

# 前端（另开终端）
cd web && npm install && npm run dev
```

## 使用流程

1. **部署中心** → 添加 Cloudflare API Token（推荐）或 Global Key + Account ID
2. 填写管理员邮箱 + 域名列表（每行一个）→ 开始批量部署
3. **站点管理** → 接入刚部署的站点（地址 + 管理员账号密码）→ 进入控制台（内嵌原版界面）
4. **版本中心** → 登记我们定制过的文件清单；检查上游更新；有冲突时面板会阻止升级并列出冲突文件

## Windows 可执行文件

面板后端为标准 Node.js，可用 `pkg` 或 `node --experimental-sea` 打包单文件 exe：

```bash
cd server
npx pkg src/index.js --targets node20-win-x64 --output MailFleetPanel.exe
```

## 升级冲突机制

- 面板记录本地定制的文件路径（如 `mail-worker/src/service/account-service.js`）
- 检查更新时拉取上游 `compare`，上游改动 ∩ 定制清单 = 冲突
- 冲突 > 0 → 提示清单、不升级；由人工（AI 辅助）重新编译合并后手动「登记新基线」
