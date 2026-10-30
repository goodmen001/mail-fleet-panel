Mail Fleet Panel — Windows 版使用说明
=====================================

【启动】双击「启动面板.vbs」
  不会出现任何黑色命令行窗口，3 秒后浏览器自动打开 http://127.0.0.1:3300
  停止：双击「停止面板.vbs」

【注意】请勿直接双击 mail-fleet-panel.exe —— 它是 Node 运行时，直接双击
  会弹出一个黑色控制台窗口且不会加载面板。请始终通过 vbs 启动。

默认账号 admin / admin123 （登录后请立即在「用户管理」修改密码）

【目录】
  mail-fleet-panel.exe   Node.js 运行时（官方版改名）
  panel.cjs              面板程序（必须保留）
  web\dist\              前端页面（必须保留）
  data\                  数据库与数据（自动生成；备份此目录 = 备份一切）
  data\bundles\worker.zip  批量部署用的 worker 包（放入后部署中心可用）

【可选环境变量】（可设为系统环境变量）
  PORT=3300           监听端口
  PANEL_SECRET=...    JWT/加密密钥，务必改成随机长字符串！
                      注意：更换后旧登录失效，已保存的凭证需重新录入
  GITHUB_TOKEN=...    可选，避免 GitHub 版本检查限流
  DATA_DIR=...        可选，自定义数据目录

数据全部在本地 data 目录；删除程序不影响已部署的邮箱站点。
