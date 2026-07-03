---
name: douyin-money-flow-project
description: 理解和继续维护本项目的 A 股板块资金流向竖屏动画页面。用于新会话快速接手 douying-time-money-flow 项目、解释项目目标、区分 sample 假数据与真实资金流数据、处理同花顺热榜和东方财富分钟资金流、修改 ECharts/DOM 标签动画、数据落盘、本地快照校验、午盘/收盘默认逻辑、红色失败标记、水印和抖音竖屏视觉细节。
---

# 抖音资金流项目

## 快速接手

先读取 `references/project-context.md`。这份参考包含项目目标、文件职责、真实/假数据边界、东方财富接口现状、常见修改点和验证步骤。

项目根目录通常是：

```text
D:\stock_share\douying_time_money_flow
```

本项目是一个本地网页工具：在浏览器中预览 A 股板块资金流向竖屏动画，目标效果接近用户给的“7月02日收盘资金流向”短视频截图。

当前默认界面：

- 左侧是 9:16 竖屏 poster，右侧是控制面板。
- 默认水印/品牌名是“牛熊研社”。
- 进入页面会自动获取一次同花顺热榜名单填入编辑区，但不会绘制曲线。
- 只有点击刷新按钮，才会拉取东方财富真实分钟资金流并绘图。
- ECharts 通过 CDN 加载，项目本身没有前端构建步骤。

## 工作原则

- 明确区分“样片预览”和“真实数据”：默认打开页面只显示空状态与提示文案；点击刷新才尝试获取真实分钟资金流。
- “同花顺热榜”只负责给出热门板块名单和排序；可画曲线的数据必须来自东方财富板块分钟资金流。
- 真实分时失败时不要画假曲线。失败板块应该保留 `error: true`，编辑区显示红色 `×`，图里不画这条线。
- 历史日期的东方财富分钟资金流无法按日期回拉；当前逻辑会把对应板块全部标为失败并落盘，不要偷偷改成今天或假数据。
- 不要擅自生成最终视频。当前阶段重点是浏览器可打开的预览页面。
- 保持 9:16 竖屏海报视觉，优先在 `public/styles.css` 和 `public/app.js` 中小步调整。
- 修改真实数据逻辑前，先读 `server.js` 的 `resolveDataContext`、`getTodayFlow`、`getCustomFlow`、`getHotSectors`、`readSavedFlow`、`persistDailyFlow`，再读 `public/app.js` 的 `loadData`、`fetchHotSectorNames`、`fetchEastmoneyFlow`、`hydrateRealMinuteFlows`、`renderInitialState`。

## 常用命令

启动本地服务：

```powershell
node server.js
```

语法检查：

```powershell
node --check server.js
node --check public\app.js
```

查看端口：

```powershell
netstat -ano | Select-String ':4173'
```

检查页面：

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:4173/ | Select-Object -ExpandProperty StatusCode
```

检查候选热榜：

```powershell
Invoke-RestMethod 'http://localhost:4173/api/today-flow?clientFlow=1&mode=hot&hotType=concept&session=close&limit=3'
```

## 修改前检查

读取这些文件：

- `server.js`
- `public/app.js`
- `public/styles.css`
- `public/index.html`
- `data/` 下对应日期的 `morning.json`、`close.json`、`hot-sectors.json`

真实接口、同花顺热榜匹配、数据落盘、本地快照校验、默认日期、错误标记、动画平滑、标签避让、水印、右侧控制面板，都已经在多轮对话中被细调过；改动时尽量保持现有意图。
