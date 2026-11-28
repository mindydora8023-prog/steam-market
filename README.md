# Steam 市场价格助手

[English](README.en.md)

**v0.6.0** · [![CI](https://github.com/mindydora8023-prog/steam-market/actions/workflows/ci.yml/badge.svg)](https://github.com/mindydora8023-prog/steam-market/actions/workflows/ci.yml) · [MIT](LICENSE)

在同一个暗色交易终端查 Steam 社区市场的最低挂单、近期中位成交和成交量。对比四种定价策略，反推目标到手价，也可以把多种饰品放进批量清单，估算清仓时各币种的买家支付、手续费与到手金额。

应用使用公开行情，运行只需 Node.js **18.17+**，零第三方运行时依赖。查价无需登录或提供 Steam 凭据，挂单和交易由你在 Steam 手动完成。界面适配桌面与手机。

## 快速启动

```sh
git clone https://github.com/mindydora8023-prog/steam-market.git
cd steam-market
npm start
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。Windows 也可以双击 `start.cmd`。在服务终端按 Ctrl+C 停止，修改后端代码后重启服务。

```sh
node app/server.mjs --port 8787 --proxy http://127.0.0.1:7890
node app/server.mjs --proxy none
```

Windows 上，`scripts/open-app.ps1` 可以检查服务并打开页面。`-BaseUrl` 支持带路径前缀的部署地址，`-CheckOnly` 只检查服务。

```powershell
pwsh -File .\scripts\open-app.ps1 -CheckOnly
pwsh -File .\scripts\open-app.ps1 -BaseUrl https://example.org/steam/
```

## 查价与批量估价

1. 选择游戏和币种，再输入物品名或粘贴 Steam 市场链接。链接会自动识别游戏和完整市场名，也支持自定义 App ID。
2. 输入至少两个字符可查看候选。用 ↑ / ↓ 选择，Enter 确认，Escape 收起。中文输入法组合期间，按 Enter 可正常选字。焦点在输入控件外时，按 `/` 可跳到查询框。
3. 查看金色的**买家支付价**、绿色的**预计到手**，以及报价币种、获取时间和缓存状态。四个策略共用一份行情，可直接切换。自定义试算支持按买家价正算、按目标到手反推，也可用滑块微调。
4. 复制买家价或到手价会得到 `3.60` 这样的纯数字。打开 Steam 市场后，在上架页核对价格与手续费，再手动确认。

### 批量清单

1. 查价后点击**加入清单**，沿用当前数量。也可以点收藏物品旁的 **+**，按收藏币种获取报价并加入 1 件。页头的**批量清单**随时可打开。
2. 设置统一挂单策略，或为单行输入自定义买家价。清空该行价格即可恢复跟随策略。每行保留加入时的行情、降价幅度和费率。相同物品、游戏和币种再次加入时会累加数量、更新行情和费率，并保留手填价格。清单最多 100 行，每行最多 10000 件。
3. 查看总件数和各币种的买家支付、Steam 手续费、发行商手续费、手续费合计与预计到手。先算每件费用，再乘数量。切换策略或修改数量会立即更新汇总。遇到无效输入或无法估价的物品，界面会标出原因。
4. 选择**复制 Markdown 清单**或**导出 CSV 定价表**。两种格式都包含物品、游戏 App ID、币种、数量、单件挂单价、单件到手、到手小计、两项手续费及方案。Markdown 还附带按币种分组的汇总。CSV 使用 UTF-8 BOM，金额用小数点，币种单列。
5. 可移除单行，或清空后立即撤销。清单、收藏、历史与设置保存在浏览器的 `localStorage`。浏览器限制存储时，清单会给出提示，并可在当前页面继续编辑和导出。

**单件数量合计**适合按同价出售同一饰品。收藏可置顶、按游戏筛选，最多 30 条。最近计算按币种记录，最多 20 条，支持恢复费率和策略、移除单条及撤销清空。复制查询链接可分享物品、游戏、币种、策略、降价幅度、费率、数量和历史区间。

查询可以取消。切换输入或刷新失败时，页面会标记上次结果，并暂停复制和加入清单。Steam 限流时会显示倒计时，冷却期间暂停查价和刷新。

## 定价与费用

| 策略 | 计算依据 |
| --- | --- |
| 智能推荐 | 通常用最低挂单减去降价幅度。最低价低于中位成交一半时，改用中位成交减去降价幅度 |
| 压最低价 | 按最低挂单减去降价幅度 |
| 持平最低价 | 反算不高于最低挂单的可实现价格 |
| 参考中位价 | 以近期成交中位价为目标 |

降价幅度默认为一个最小货币单位，例如 CNY 的 ¥0.01 或 JPY 的 ¥1。默认 Steam 费率为 5%，发行商费率为 10%，可在**费率与降价**中调节。最低挂单比中位成交高出 15% 以上时，智能推荐会提示价差，并继续参考最低挂单。

手续费以卖家到手金额为基数，在最小货币单位上用十进制整数计算并向下取整，再应用最低手续费。手续费档位会让一些目标价无法恰好实现。工具会给出可实现的买家价，并显示取整提示。

默认费率下，人民币模型的两项最低手续费各为 ¥0.07，最低买家价为 ¥0.21。买家支付 ¥0.29 时，预计到手 ¥0.15。日元模型每项正费率的最低手续费为 ¥2，其他币种按一个最小货币单位起算。实际费用和价格请以 Steam 上架页为准。

## 历史走势

报价后异步加载走势，提供 30 / 90 / 180 / 365 天区间、MA7 均线、成交量、价格范围和分位参考。悬停或触摸可查看十字游标，键盘支持左右键和 Home / End。可查看等价数据表或导出 CSV。

- 使用 Steam 公开的成交中位样本，按 UTC 日和成交量加权聚合。分位基于日样本，缺失日期保留为空，区间起点缺少样本时省略区间涨跌幅。
- 同币种保留历史原价。跨币种时，以当前所选币种报价和历史末值做比例锚定，页面和 CSV 都会标注估算。结果表示价格走势参考。
- 历史查询失败时可独立重试，当前报价仍可用。

## 自部署

### Docker Compose

在仓库根目录运行一条命令。

```sh
docker compose up -d --build
```

镜像基于 `node:22-alpine`，以非 root 用户运行。默认发布到宿主机的 `127.0.0.1:8787`，健康检查访问容器内的 `/api/health`。可通过环境变量或仓库根目录的 `.env` 配置。

| 变量 | 默认 | 用法 |
| --- | --- | --- |
| `PORT` | `8787` | 同时设置宿主机发布端口和容器内监听端口 |
| `PUBLISH_HOST` | `127.0.0.1` | Compose 在宿主机上绑定的地址 |
| `STEAM_PROXY` | 空 | 设为 `http://代理地址:端口` 使用 HTTP CONNECT 代理，或设为 `none` 直连 |

若代理在宿主机运行，容器必须能访问该地址。Docker Desktop 可使用 `http://host.docker.internal:7890`，代理也需要监听容器可访问的接口。

```sh
docker compose ps
docker compose logs -f steam-market
docker compose down
```

### Linux systemd

在已安装 Node.js 的 Linux 上，从仓库根目录执行安装。服务默认监听 `127.0.0.1:8787`，可参照 [Caddy 配置](deploy/Caddyfile) 配置 HTTPS 反向代理。

```sh
sudo env PAYLOAD_DIR="$PWD" bash deploy/install.sh
systemctl status steam-market
journalctl -u steam-market -n 80 --no-pager
```

服务配置保存在 `/etc/steam-market.env`。可修改 `PORT`、`BIND` 和 `STEAM_PROXY`，再运行 `sudo systemctl restart steam-market`。

## 网络与缓存

常规 Node 启动按顺序使用显式上游代理、`HTTPS_PROXY` / `HTTP_PROXY`，然后探测本机 7890 / 7897 / 10809 端口。使用 Clash 时选 HTTP 或 mixed 端口。`--proxy none` 强制直连。页头的连接状态显示本地服务和代理配置，实际 Steam 连通性在查询时验证。

| 数据 | 内存缓存 |
| --- | --- |
| 搜索候选 | 5 分钟，按游戏、关键词、数量隔离 |
| 当前报价 | 60 秒 |
| 历史页面 | 10 分钟 |
| 无报价结果 | 2 分钟 |

同键并发请求合并，刷新绕过对应缓存。搜索、报价和历史共享 Steam 429 冷却。请求队列、连接、响应大小、解压和浏览器等待时间均有边界，迟到的响应不会覆盖新输入。

## 开发与验证

```sh
npm test
npm run check
```

两项命令可离线运行。GitHub Actions 在 Ubuntu 和 Windows 上使用 Node.js 20、22、24 执行这两项检查。Windows 启动脚本测试需要 PowerShell 7（`pwsh`）。

浏览器回归使用离线行情和 Playwright Core，覆盖查价、收藏、清单、剪贴板与下载、图表、失败恢复和窄屏布局。可指定现有 Playwright Core 的 `index.mjs`（`PLAYWRIGHT_MODULE`），或临时安装测试工具。

```sh
npm install --no-save --package-lock=false playwright-core
npm run test:ui
```

Windows 默认使用 Edge，可用 `BROWSER_EXECUTABLE` 指定 Chromium 或 Edge 路径。其他平台可指定浏览器路径，或运行 `npx playwright-core install chromium` 后使用 Playwright 的 Chromium。测试截图和报告默认写入 `.ui-evidence/`，可用 `UI_EVIDENCE_DIR` 修改。

单件报价和手续费分别在 [lib/quote.js](lib/quote.js) 与 [lib/fees.js](lib/fees.js)。浏览器和单元测试共用 [lib/batch.js](lib/batch.js) 的清单计算与序列化。界面规范见 [DESIGN.md](DESIGN.md)。

## 许可证

[MIT](LICENSE)。本项目是独立开发的 Steam 社区市场工具。
