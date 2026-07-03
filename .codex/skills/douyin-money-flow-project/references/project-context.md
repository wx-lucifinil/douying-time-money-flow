# 项目上下文

## 项目目标

本项目 `douying-time-money-flow` 是一个本地 Node + 静态前端页面，用于生成/预览抖音竖屏风格的 A 股板块资金流向动画页面。

用户想做的效果：

- 展示约 30 个热门板块的资金流向曲线。
- 竖屏 9:16 海报视觉，接近参考截图中的“7月02日收盘资金流向”。
- 曲线颜色从红、橙、黄、青、蓝、绿多色渐变，最终最大正值偏深红，最大负值偏深绿。
- 右侧标签跟随曲线端点移动，最后阶段逐渐铺开，避免 15:00 标签重叠。
- 默认浏览器可打开页面，不先生成最终视频。
- 真实数据失败时不再造假线。

## 文件职责

`server.js`

- 提供本地 HTTP 服务，默认端口 `4173`。
- 静态托管 `public/`。
- 调用东方财富接口获取板块列表、板块快照、指数行情、候选热门板块。
- 写入 `data/YYYY-MM-DD/morning.json`、`data/YYYY-MM-DD/close.json`、`data/YYYY-MM-DD/hot-sectors.json`。
- `sampleSectorSpecs` 是样片参考板块和终值，不代表真实分钟分时。
- `resolveDataContext()` 控制午盘/收盘和日期回退逻辑。
- `getTodayFlow()` / `getCustomFlow()` 在 `clientFlow=1` 时只返回候选板块，由浏览器端获取真实分钟分时。
- `/api/save-client-flow` 接收浏览器端成功/失败后的结果并落盘。

`public/app.js`

- 核心 ECharts 和 DOM 标签动画逻辑。
- `renderInitialState()` 默认打开页面时显示空状态和提示文案，不调用真实接口（早期版本曾用样片假数据预览，已移除）。
- `loadData()` 只有点击刷新按钮才执行真实刷新。
- `fetchEastmoneyFlow()` 通过本地 `/api/flow` 接口请求东方财富真实分钟资金流（服务端代理，不再是浏览器 JSONP）。
- `hydrateRealMinuteFlows()` 并发补齐真实分钟分时；失败板块设置 `error: true`，`points: []`，不画线。
- `applySectorErrors()` 在板块编辑区右侧显示红色 `×`。
- `normalizeRows()` 过滤无 points 的失败板块，平滑曲线，计算最终颜色。
- `renderLabels()` 控制端点、标签跟随和最终铺开。

`public/styles.css`

- 9:16 海报、右侧控制面板、坐标文字、标签块、水印、标题、顶部横线、底部声明等视觉样式。
- 小心修改 `.chart-shell`、`GRID`、`.flow-label`、`.sector-list`、`.meta-row`，这些影响布局稳定性。

`public/index.html`

- 页面结构：左侧竖屏 poster，右侧控制面板。
- 标题和品牌之间有 `.title-divider` 浅灰横线。
- 控制面板包含热门判定、板块范围、数据时段、水印名称、板块名单、刷新按钮。

`data/`

- 用日期分目录保存结果。
- 如果某板块真实分时失败，保存的该板块应保留 `error: true`，方便全局搜索失败项。

## 真实数据与假数据边界

默认打开页面：

- 显示空状态和提示文案，不绘制任何曲线。
- 不再使用前端的 sample 样片假数据（早期版本的 `SAMPLE_SECTOR_SPECS` 已移除，样片参考板块仅在 `server.js` 的 `sampleSectorSpecs` 中保留，用于 `mode=sample` 时）。
- 状态文案应明确提示：需要点击刷新按钮才会拉取真实数据。

点击刷新按钮：

- 服务端先返回候选板块和代码。
- 前端通过本地 `/api/flow` 接口请求东方财富真实分钟资金流（服务端代理 `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get`，不再是浏览器 JSONP）：

```text
https://push2.eastmoney.com/api/qt/stock/fflow/kline/get
```

主要参数（服务端组装，浏览器无需关心 cb/callback）：

```text
secid=90.BK0478
klt=1
lmt=0
fields1=f1,f2,f3,f7
fields2=f51,f52,f53,f54,f55
ut=b2884a393a59ad64002292a3e90d46a5
```

注意：

- Node/curl 直连该分钟接口时，曾出现 `UND_ERR_SOCKET other side closed` 或 schannel abrupt close。
- 东方财富官方页面源码确认它自己也用这个接口（早期页面走 JSONP）。
- 当前实现由本地服务端 `server.js` 的 `getFlow()` 直接请求东方财富分钟资金流接口，浏览器再走 `/api/flow` 拿服务端代理后的数据（早期版本曾让浏览器直接 JSONP，已替换）。
- 如果拉取失败，不要回退到假线；只标红失败。

可以成功的东方财富接口类型：

- 板块列表/快照：`api/qt/clist/get`
- 指数行情：`api/qt/ulist.np/get`
- 板块详情快照：`api/qt/stock/get`
- 个股日资金流：`push2his.../fflow/daykline/get` 曾成功返回，但它不是本项目需要的板块分钟分时。

## 日期和数据时段规则

当前逻辑目标：

- 11:30 到 15:00 之间默认午盘。
- 15:00 到 24:00 默认今日收盘。
- 其它时间不要使用今日收盘，而是上一交易日收盘。
- 当前交易日 11:30 前，午盘选项应显示上一交易日午盘。
- 周末回退到上一交易日。

相关函数：

- 前端：`resolveClientDataContext()`、`applyDefaultSession()`、`updateSessionOptionLabels()`、`updateReloadButtonText()`
- 后端：`resolveDataContext()`、`defaultSessionForNow()`、`previousTradingDate()`

## 视觉和动画要点

坐标/图区：

- 坐标文字应在主数据背景区域外，贴近边界但不越界。
- y 轴范围动态计算，不要强制以 0 对称。
- `0` 只显示 `0`，其它显示 `xx亿`。
- 只保留横向浅虚线，不要方格线。

曲线：

- 需要平滑线，不要明显折线/锯齿。
- 端点移动要尽量流畅。
- 失败真实分时不画线。

标签：

- 右侧标签文本和数字间距固定 7px。
- 15:00 前标签可以重叠，互相独立。
- 接近最终阶段时再平滑铺开，避免 15:00 标签重叠。
- 标签与端点之间不要画连接线。
- 每条可见线右侧有小端点。

标题/顶部：

- 标题不使用阴影。
- 标题颜色根据市场情绪偏红/绿。
- 标题与“雪球研习社/时间”之间有浅灰横线。
- 顶部区域应紧凑，给数据图区域更多高度。

水印：

- 默认文字“雪球研习社”。
- 控制面板有水印名称输入框，保存到 localStorage。
- 图区内有多个浅色倾斜水印，不要过深。

右侧控制面板：

- 不要太长，尽量宽一点。
- 板块名单三列显示。
- 板块真实分时失败时，在输入框右侧显示红色 `×`。
- 切换下拉筛选项不要立即重新渲染；只有点击刷新按钮才拉真实数据。
- “保存名单”只保存和提示刷新，不应偷偷调真实接口。

## 常见任务入口

调整默认真假数据：

- 看 `renderInitialState()` 和 `loadData()`。
- 确保默认打开不调用 `/api/custom-flow` 或 `/api/today-flow`。

调整真实接口：

- 看 `public/app.js` 的 `fetchEastmoneyFlow()` 和 `server.js` 的 `getFlow()`。
- 先用东方财富官方页面 `https://data.eastmoney.com/bkzj/BK0478.html` 对照。
- 失败时保留 `error: true`。

调整落盘：

- 看 `persistDailyFlow()`、`persistHotSectors()`、`writeJsonIfChanged()`。
- 文件应写入 `data/YYYY-MM-DD/`。
- 不要为同一内容重复生成新文件。

调整标题和默认日期：

- 前端和后端日期逻辑都要同步改。
- 修改后检查下拉 option 文案、刷新按钮文案、标题日期。

调整标签布局：

- 看 `GRID`、`renderLabels()`、`layoutLabelTargets()`、`.flow-label`。
- 修改后检查 09:30、11:30、15:00 三个阶段。

## 验证步骤

语法检查：

```powershell
node --check server.js
node --check public\app.js
```

启动/重启：

```powershell
node server.js
```

如果端口占用：

```powershell
netstat -ano | Select-String ':4173'
Stop-Process -Id <pid> -Force
Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'D:\stock_share\douying_time_money_flow' -WindowStyle Hidden
```

基本 HTTP 检查：

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:4173/ | Select-Object -ExpandProperty StatusCode
```

候选板块检查：

```powershell
Invoke-RestMethod 'http://localhost:4173/api/custom-flow?clientFlow=1&session=close&limit=1&names=%E6%9C%89%E8%89%B2%E9%87%91%E5%B1%9E'
```

预期：`clientFlow=1` 返回候选板块，`points` 应为空或不存在；真实分钟分时由浏览器端 JSONP 获取。

## 重要提醒

- 用户非常关注“真实数据 vs 假数据”的边界。回答时要诚实说明当前展示来源。
- 不要在真实刷新失败时用合成曲线填充。
- 不要批量删除文件或目录。
- 不要擅自生成最终视频；先保持浏览器预览。
- UI 调整应小步、验证、重启服务后让用户看。
