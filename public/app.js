const chartEl = document.querySelector("#chart");
const xAxisLabelsEl = document.querySelector("#xAxisLabels");
const yAxisLabelsEl = document.querySelector("#yAxisLabels");
const labelLayer = document.querySelector("#labelLayer");
const labelLines = document.querySelector("#labelLines");
const statusEl = document.querySelector("#status");
const titleEl = document.querySelector("#title");
const brandNameEl = document.querySelector("#brandName");
const posterEl = document.querySelector(".poster");
const currentTimeEl = document.querySelector("#currentTime");
const modeEl = document.querySelector("#mode");
const sessionEl = document.querySelector("#session");
const watermarkNameEl = document.querySelector("#watermarkName");
const watermarkLayerEl = document.querySelector("#watermarkLayer");
const reloadEl = document.querySelector("#reload");
const getHotEl = document.querySelector("#getHot");
const saveSectorsEl = document.querySelector("#saveSectors");
const resetSectorsEl = document.querySelector("#resetSectors");
const sectorListEl = document.querySelector("#sectorList");

let chart;
let latestRows = [];
let activeFrame = 0;
let animationTimer = null;
let labelNodes = new Map();
let dotNodes = new Map();
let lastLabelCommit = 0;
let isLoading = false;
let animationFrameId = null;

const STORAGE_KEY = "douyinMoneyFlow.sectorNames";
const WATERMARK_KEY = "douyinMoneyFlow.watermarkName";
const DEFAULT_WATERMARK_NAME = "高翔研习社";

const POSITIVE_EXTREME = [126, 22, 32];
const NEGATIVE_EXTREME = [15, 86, 48];
const RANK_PALETTE = [
  "#6b1f2a",
  "#8f2632",
  "#b3363b",
  "#c65a4f",
  "#b84f75",
  "#cf7865",
  "#bf6c37",
  "#d08a3b",
  "#c69b38",
  "#d8b946",
  "#b8b450",
  "#9faf68",
  "#8fa276",
  "#6f9a94",
  "#5a93a6",
  "#4d82a5",
  "#426f99",
  "#3f6785",
  "#53757a",
  "#497f70",
  "#438861",
  "#397d57",
  "#32734d",
  "#2f6c45",
  "#2c633f",
  "#285b3a",
  "#245437",
  "#214d33",
  "#1d462f",
  "#153f2a",
];

const GRID = {
  left: 58,
  right: 116,
  top: 16,
  bottom: 38,
};

let currentDataContext = null;

function moneyToYi(value) {
  return Number(value || 0) / 100000000;
}

function formatYi(value) {
  const yi = moneyToYi(value);
  const sign = yi > 0 ? "+" : "";
  return `${sign}${yi.toFixed(2)}`;
}

function parseMinute(time) {
  const match = String(time).match(/(\d{2}):(\d{2})/);
  if (!match) return "";
  return `${match[1]}:${match[2]}`;
}

function dateStringFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatClientQueryTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function apiRequest(url, options = {}) {
  const method = options.method || "GET";
  const requestUrl = new URL(url, window.location.origin);
  if (method === "GET") {
    requestUrl.searchParams.set("__networkTs", String(Date.now()));
  }

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, requestUrl.toString(), true);
    xhr.responseType = "text";
    for (const [key, value] of Object.entries(options.headers || {})) {
      xhr.setRequestHeader(key, value);
    }
    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: async () => JSON.parse(xhr.responseText || "{}"),
      });
    };
    xhr.onerror = () => {
      resolve({
        ok: false,
        status: 0,
        json: async () => ({ error: "XMLHttpRequest failed" }),
      });
    };
    xhr.send(options.body || null);
  });
}

function isTradingWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function previousTradingDateString(date) {
  const previous = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  do {
    previous.setDate(previous.getDate() - 1);
  } while (!isTradingWeekday(previous));
  return dateStringFromDate(previous);
}

function todayTitle(session, dataDate) {
  const fallbackDate = dateStringFromDate(new Date());
  const [, , month = "", date = ""] = String(dataDate || fallbackDate).match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return `${month}月${date}日${session === "morning" ? "午盘" : "收盘"}资金流向`;
}

function resolveClientDataContext(session = sessionEl.value, now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  let dataDate = dateStringFromDate(now);
  if (!isTradingWeekday(now)) {
    dataDate = previousTradingDateString(now);
  } else if (session === "morning" && minutes < 11 * 60 + 30) {
    dataDate = previousTradingDateString(now);
  } else if (session === "close" && minutes < 15 * 60) {
    dataDate = previousTradingDateString(now);
  }
  return { session, dataDate };
}

function dataDateLabel(dataDate) {
  const today = dateStringFromDate(new Date());
  const yesterday = previousTradingDateString(new Date());
  if (dataDate === today) return "今日";
  if (dataDate === yesterday) return "昨日";
  const [, , month = "", day = ""] = String(dataDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return month && day ? `${month}/${day}` : "";
}

function updateReloadButtonText(context = currentDataContext) {
  const fallback = resolveClientDataContext(sessionEl.value);
  const dataContext = context || fallback;
  const period = dataContext.session === "morning" ? "午盘" : "收盘";
  const prefix = dataDateLabel(dataContext.dataDate);
  reloadEl.textContent = `刷新${prefix}${period}数据`;
}

function updateSessionOptionLabels() {
  for (const option of sessionEl.options) {
    const context = resolveClientDataContext(option.value);
    const prefix = dataDateLabel(context.dataDate);
    option.textContent = option.value === "morning" ? `${prefix}午盘 11:30` : `${prefix}收盘 15:00`;
  }
}

function markFiltersPendingRefresh() {
  updateSessionOptionLabels();
  currentDataContext = resolveClientDataContext(sessionEl.value);
  updateReloadButtonText(currentDataContext);
  statusEl.textContent = `筛选已更新，点击“${reloadEl.textContent}”后重新拉取并绘图。`;
}

function readWatermarkName() {
  return localStorage.getItem(WATERMARK_KEY) || DEFAULT_WATERMARK_NAME;
}

function writeWatermarkName(name) {
  localStorage.setItem(WATERMARK_KEY, name || DEFAULT_WATERMARK_NAME);
}

function renderWatermarks(name = readWatermarkName()) {
  watermarkLayerEl.innerHTML = "";
  const items = [
    { left: "17%", top: "29%" },
    { left: "72%", top: "30%" },
    { left: "14%", top: "57%" },
    { left: "74%", top: "58%" },
    { left: "33%", top: "77%" },
    { left: "56%", top: "71%" },
  ];
  for (const item of items) {
    const mark = document.createElement("span");
    mark.className = "watermark";
    mark.textContent = name || DEFAULT_WATERMARK_NAME;
    mark.style.left = item.left;
    mark.style.top = item.top;
    watermarkLayerEl.appendChild(mark);
  }
}

function applyWatermarkName(name = readWatermarkName()) {
  const value = name.trim() || DEFAULT_WATERMARK_NAME;
  watermarkNameEl.value = value;
  brandNameEl.textContent = value;
  renderWatermarks(value);
}

function moodText(mood) {
  if (!mood) return "";
  const tone = mood.tone === "red" ? "红色" : "绿色";
  const indexAverage = Number(mood.indexAverage || 0).toFixed(2);
  const sectorAverage = Number(mood.sectorAverage || 0).toFixed(2);
  const upCount = Number(mood.upCount || 0);
  const downCount = Number(mood.downCount || 0);
  return `标题${tone}：指数均值 ${indexAverage}%，板块均值 ${sectorAverage}%，上涨 ${upCount} / 下跌 ${downCount}。`;
}

function applyMarketMood(mood) {
  const tone = mood?.tone === "green" ? "green" : "red";
  posterEl.dataset.marketTone = tone;
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function rgb(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function colorForRank(rank, count, value, maxPositive, minNegative) {
  if (maxPositive > 0 && value === maxPositive) return rgb(POSITIVE_EXTREME);
  if (minNegative < 0 && value === minNegative) return rgb(NEGATIVE_EXTREME);
  const index = Math.round((rank / Math.max(count - 1, 1)) * (RANK_PALETTE.length - 1));
  return RANK_PALETTE[index];
}

function niceStep(range) {
  if (range <= 80) return 10;
  if (range <= 240) return 20;
  if (range <= 420) return 30;
  if (range <= 760) return 40;
  return 50;
}

function niceLabelStep(range) {
  if (range <= 100) return 20;
  if (range <= 240) return 40;
  if (range <= 420) return 60;
  if (range <= 900) return 80;
  return 200;
}

function computeAxisExtent(rows) {
  const values = rows.flatMap((row) => row.points.map((point) => moneyToYi(point.mainNet)));
  const rawMin = Math.min(...values, 0);
  const rawMax = Math.max(...values, 0);
  const range = Math.max(rawMax - rawMin, 1);
  const padding = Math.max(range * 0.006, 0.8);
  const step = niceStep(range);
  return {
    min: Math.floor((rawMin - padding) / step) * step,
    max: Math.ceil((rawMax + padding) / step) * step,
    step,
  };
}

function pointInSession(point, session) {
  if (session !== "morning") return true;
  return point.time <= "11:30";
}

function withOpeningAnchor(points) {
  if (!points.length) return points;
  if (points[0].time === "09:30") return points;
  const rawDate = String(points[0].rawTime || "").split(" ")[0];
  return [
    {
      time: "09:30",
      rawTime: rawDate ? `${rawDate} 09:30` : "09:30",
      mainNet: 0,
      value: 0,
    },
    ...points,
  ];
}

function smoothVisualValues(points) {
  if (points.length < 6) return points.map((point) => point.value);
  const raw = points.map((point) => point.value);
  let values = [...raw];
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 1; index < values.length; index += 1) {
      values[index] = values[index - 1] * 0.54 + values[index] * 0.46;
    }
    for (let index = values.length - 2; index >= 0; index -= 1) {
      values[index] = values[index + 1] * 0.54 + values[index] * 0.46;
    }
  }
  return raw.map((value, index) => {
    if (index === 0 || index === raw.length - 1) return value;
    return values[index] * 0.78 + value * 0.22;
  });
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const value = 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
  // 钳制到相邻控制点区间内，防止曲线过冲超出真实数据范围
  const lower = Math.min(p1, p2);
  const upper = Math.max(p1, p2);
  return Math.min(Math.max(value, lower), upper);
}

function makeDisplayPoints(points) {
  if (points.length < 2) return points;
  const values = smoothVisualValues(points);
  const factor = 5;
  const dense = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    const v0 = values[Math.max(index - 1, 0)];
    const v1 = values[index];
    const v2 = values[index + 1];
    const v3 = values[Math.min(index + 2, values.length - 1)];
    for (let step = 0; step < factor; step += 1) {
      const t = step / factor;
      dense.push({
        ...left,
        time: t < 0.5 ? left.time : right.time,
        rawTime: t < 0.5 ? left.rawTime : right.rawTime,
        x: index + t,
        index: index + t,
        mainNet: lerp(left.mainNet, right.mainNet, t),
        value: catmullRom(v0, v1, v2, v3, t),
      });
    }
  }
  const last = points.at(-1);
  dense.push({ ...last, x: last.index, index: last.index, value: values.at(-1) });
  return dense;
}

function normalizeRows(sectors, session) {
  const rows = sectors
    .map((sector) => {
      const rawPoints = withOpeningAnchor(sector.points
        .filter((point) => Number.isFinite(point.mainNet))
        .map((point) => ({
          time: parseMinute(point.time),
          rawTime: point.time,
          mainNet: point.mainNet,
          value: moneyToYi(point.mainNet),
        }))
        .filter((point) => pointInSession(point, session)));
      const points = rawPoints.map((point, index) => ({ ...point, index }));
      const displayPoints = makeDisplayPoints(points);
      return {
        ...sector,
        points,
        displayPoints,
        finalValue: rawPoints.at(-1)?.mainNet || sector.mainNet || 0,
      };
    })
    .filter((sector) => sector.points.length > 0);

  const maxPositive = Math.max(...rows.map((row) => row.finalValue), 0);
  const minNegative = Math.min(...rows.map((row) => row.finalValue), 0);
  const sorted = rows.sort((a, b) => b.finalValue - a.finalValue);
  return sorted
    .map((row, rank) => ({
      ...row,
      color: colorForRank(rank, sorted.length, row.finalValue, maxPositive, minNegative),
    }));
}

function buildSeries(rows, frameCount) {
  const absMax = Math.max(...rows.map((item) => Math.abs(item.finalValue)), 1);
  return rows.map((row) => {
    const sliced = visiblePoints(row.displayPoints || row.points, frameCount).map((point) => [point.x, point.value]);
    return {
      name: row.name,
      type: "line",
      data: sliced,
      showSymbol: false,
      smooth: 0.62,
      smoothMonotone: "x",
      lineStyle: {
        width: Math.abs(row.finalValue) === absMax ? 2.9 : 2.25,
        color: row.color,
        opacity: 0.9,
        cap: "round",
        join: "round",
      },
      emphasis: {
        focus: "series",
        lineStyle: { width: 3.4 },
      },
      endLabel: { show: false },
      animation: false,
    };
  });
}

function interpolatePoint(points, framePosition) {
  if (!points.length) return null;
  const first = points[0];
  const last = points.at(-1);
  const x = Math.min(Math.max(framePosition, first.index), last.index);
  let rightIndex = points.findIndex((point) => point.index >= x);
  if (rightIndex < 0) rightIndex = points.length - 1;
  const leftIndex = Math.max(rightIndex - 1, 0);
  const left = points[leftIndex];
  const right = points[rightIndex];
  if (!left || !right || left.index === right.index) {
    return {
      ...right,
      x: right.index,
    };
  }
  const t = (x - left.index) / (right.index - left.index);
  return {
    ...left,
    x,
    value: lerp(left.value, right.value, t),
    mainNet: lerp(left.mainNet, right.mainNet, t),
  };
}

function visiblePoints(points, framePosition) {
  if (!points.length) return [];
  const last = points.at(-1);
  const x = Math.min(Math.max(framePosition, points[0].index), last.index);
  const base = points.filter((point) => point.index <= x).map((point) => ({
    ...point,
    x: point.index,
  }));
  if (x < last.index) {
    const interpolated = interpolatePoint(points, x);
    if (!base.length || interpolated.x > base.at(-1).x) {
      base.push(interpolated);
    } else {
      base[base.length - 1] = interpolated;
    }
  }
  return base;
}

function renderChart(rows, frameCount) {
  if (!chart) {
    chart = echarts.init(chartEl, null, { renderer: "svg" });
  }

  const axisExtent = computeAxisExtent(rows);
  const times = rows[0]?.points.map((point) => point.time) || [];
  const currentIndex = Math.max(0, Math.min(Math.round(frameCount), times.length - 1));
  const currentTime = times[currentIndex] || "--:--";
  const session = sessionEl.value;
  const xLabelTimes = session === "morning" ? ["09:30", "10:30", "11:30"] : ["09:30", "10:30", "11:30", "14:00", "15:00"];
  currentTimeEl.textContent = currentTime;

  chart.setOption(
    {
      backgroundColor: "transparent",
      animation: false,
      grid: {
        left: GRID.left,
        right: GRID.right,
        top: GRID.top,
        bottom: GRID.bottom,
      },
      xAxis: {
        type: "value",
        min: 0,
        max: Math.max(times.length - 1, 1),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#8f958f", width: 1 } },
        splitLine: { show: false },
        axisLabel: {
          show: false,
        },
      },
      yAxis: {
        type: "value",
        min: axisExtent.min,
        max: axisExtent.max,
        splitNumber: 5,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: {
          lineStyle: {
            color: "rgba(70, 80, 70, 0.075)",
            type: "dashed",
          },
        },
        axisLabel: {
          show: false,
        },
      },
      tooltip: {
        trigger: "axis",
        confine: true,
        valueFormatter(value) {
          return `${Number(value).toFixed(2)}亿`;
        },
      },
      series: buildSeries(rows, frameCount),
    },
    true,
  );

  renderXAxisLabels(times, xLabelTimes);
  renderYAxisLabels(axisExtent);
  renderLabels(rows, frameCount);
}

function renderXAxisLabels(times, xLabelTimes) {
  if (!chart || !xAxisLabelsEl) return;
  const height = chartEl.clientHeight;
  const plotRight = chartEl.clientWidth - GRID.right;
  xAxisLabelsEl.innerHTML = "";
  for (const value of xLabelTimes) {
    const index = value === "09:30" ? 0 : times.indexOf(value);
    if (index < 0) continue;
    const [x] = chart.convertToPixel({ gridIndex: 0 }, [index, 0]);
    const label = document.createElement("span");
    label.className = "x-axis-label";
    label.textContent = value;
    label.style.top = `${height - GRID.bottom + 8}px`;
    if (value === "09:30") {
      label.style.left = `${GRID.left}px`;
      label.style.transform = "none";
    } else if (value === "15:00" || (value === "11:30" && xLabelTimes.length === 3)) {
      label.style.left = `${plotRight}px`;
      label.style.transform = "translateX(-100%)";
    } else {
      label.style.left = `${x}px`;
      label.style.transform = "translateX(-50%)";
    }
    xAxisLabelsEl.appendChild(label);
  }
}

function renderYAxisLabels(axisExtent) {
  if (!chart || !yAxisLabelsEl) return;
  const plotBottom = chartEl.clientHeight - GRID.bottom;
  yAxisLabelsEl.innerHTML = "";
  const range = axisExtent.max - axisExtent.min;
  const labelStep = niceLabelStep(range);
  const values = [Math.round(axisExtent.max), 0];
  const start = Math.ceil(axisExtent.min / labelStep) * labelStep;
  const end = Math.floor(axisExtent.max / labelStep) * labelStep;
  for (let value = start; value <= end; value += labelStep) {
    values.push(Math.round(value));
  }
  const uniqueValues = [...new Set(values)]
    .filter((value) => value >= axisExtent.min && value <= axisExtent.max)
    .sort((a, b) => b - a);
  const lowestValue = Math.min(...uniqueValues);
  for (const value of uniqueValues) {
    const [, y] = chart.convertToPixel({ gridIndex: 0 }, [0, value]);
    const label = document.createElement("span");
    label.className = "y-axis-label";
    label.textContent = value === 0 ? "0" : `${value}亿`;
    label.style.left = `${GRID.left - 12}px`;
    if (value === lowestValue) {
      label.style.top = `${Math.min(y, plotBottom - 3)}px`;
      label.style.transform = "translate(-100%, -100%)";
    } else {
      label.style.top = `${y}px`;
      label.style.transform = "translate(-100%, -50%)";
    }
    yAxisLabelsEl.appendChild(label);
  }
}

function layoutLabelTargets(targets, minY, maxY) {
  const rowHeight = 20;
  const sorted = targets.toSorted((a, b) => a.desiredY - b.desiredY);
  for (let index = 0; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    sorted[index].y = Math.max(sorted[index].desiredY, previous ? previous.y + rowHeight : minY);
  }

  const overflow = sorted.at(-1)?.y - maxY || 0;
  if (overflow > 0) {
    for (const item of sorted) item.y -= overflow;
  }

  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    sorted[index].y = Math.min(sorted[index].y, sorted[index + 1].y - rowHeight);
  }

  for (const item of sorted) {
    item.y = Math.min(Math.max(item.y, minY), maxY);
  }
  return sorted;
}

function easeInOut(t) {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderLabels(rows, frameCount) {
  if (!chart) return;
  const totalPoints = Math.max(...rows.map((row) => row.points.length), 1);
  const isFinalFrame = frameCount >= totalPoints - 1;

  const width = chartEl.clientWidth;
  const height = chartEl.clientHeight;
  const plotRight = width - GRID.right;
  const plotBottom = height - GRID.bottom;
  const plotTop = GRID.top;
  labelLines.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const currentRows = rows
    .map((row) => {
      const point = interpolatePoint(row.points, frameCount);
      if (!point) return null;
      const pixel = chart.convertToPixel({ gridIndex: 0 }, [point.x, point.value]);
      return {
        row,
        point,
        x: pixel[0],
        desiredY: pixel[1],
      };
    })
    .filter(Boolean);

  const progress = totalPoints <= 1 ? 1 : (frameCount - 1) / (totalPoints - 1);
  const spreadProgress = easeInOut((progress - 0.82) / 0.18);
  const finalLayout = layoutLabelTargets(currentRows, plotTop + 8, plotBottom - 8);
  const finalByName = new Map(finalLayout.map((item) => [item.row.name, item.y]));
  const activeKeys = new Set(currentRows.map((item) => item.row.name));

  for (const key of labelNodes.keys()) {
    if (!activeKeys.has(key)) {
      labelNodes.get(key)?.remove();
      dotNodes.get(key)?.remove();
      labelNodes.delete(key);
      dotNodes.delete(key);
    }
  }

  for (const item of currentRows) {
    const rawLabelX = item.x + 8;
    const finalLabelX = plotRight + 4;
    const labelX = Math.min(Math.max(lerp(rawLabelX, finalLabelX, spreadProgress), GRID.left + 5), plotRight + 4);
    const finalY = finalByName.get(item.row.name) ?? item.desiredY;
    const labelY = Math.min(Math.max(lerp(item.desiredY, finalY, spreadProgress), plotTop + 7), plotBottom - 7);
    const key = item.row.name;

    let label = labelNodes.get(key);
    if (!label) {
      label = document.createElement("div");
      label.className = "flow-label";
      label.innerHTML = `<span class="name"></span><span class="value"></span>`;
      labelLayer.appendChild(label);
      labelNodes.set(key, label);
    }
    label.style.color = item.row.color;
    label.style.transform = `translate3d(${labelX.toFixed(1)}px, ${(labelY - 7.5).toFixed(1)}px, 0)`;
    label.querySelector(".name").textContent = item.row.name;
    label.querySelector(".value").textContent = formatYi(item.point.mainNet);

    let dot = dotNodes.get(key);
    if (!dot) {
      dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("class", "endpoint-dot");
      dot.setAttribute("r", "3");
      labelLines.appendChild(dot);
      dotNodes.set(key, dot);
    }
    dot.setAttribute("cx", item.x.toFixed(1));
    dot.setAttribute("cy", item.desiredY.toFixed(1));
    dot.setAttribute("fill", item.row.color);
  }
}

function animateRows(rows) {
  window.clearInterval(animationTimer);
  if (animationFrameId !== null) {
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  lastLabelCommit = 0;
  const totalPoints = Math.max(...rows.map((row) => row.points.length), 1);
  // 午盘数据点约 120、收盘约 240；按时段区分时长，让每点播放速度接近
  const duration = sessionEl.value === "morning" ? 12500 : 16500;
  const startedAt = performance.now();
  let lastChartPaint = 0;

  function tick(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    activeFrame = progress * Math.max(totalPoints - 1, 0);
    if (now - lastChartPaint > 32 || progress === 1) {
      renderChart(rows, activeFrame);
      lastChartPaint = now;
    } else {
      renderLabels(rows, activeFrame);
      const currentIndex = Math.max(0, Math.min(Math.round(activeFrame), rows[0]?.points.length - 1 || 0));
      currentTimeEl.textContent = rows[0]?.points[currentIndex]?.time || "--:--";
    }
    if (progress < 1) {
      animationFrameId = requestAnimationFrame(tick);
    } else {
      animationFrameId = null;
    }
  }

  animationFrameId = requestAnimationFrame(tick);

  animationTimer = window.setInterval(() => {
    if (activeFrame >= totalPoints - 1) {
      window.clearInterval(animationTimer);
      renderChart(rows, totalPoints - 1);
    }
  }, 500);
}

function readSavedSectorNames() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeSavedSectorNames(names) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // localStorage 被禁用或配额已满时静默忽略
  }
}

function getEditorNames() {
  return [...sectorListEl.querySelectorAll("input")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function renderSectorEditor(names) {
  sectorListEl.innerHTML = "";
  names.forEach((name, index) => {
    const row = document.createElement("div");
    row.className = "sector-row";
    const indexEl = document.createElement("span");
    indexEl.className = "sector-index";
    indexEl.textContent = String(index + 1).padStart(2, "0");
    const input = document.createElement("input");
    input.value = name;
    input.setAttribute("aria-label", `第${index + 1}个板块`);
    const errorMark = document.createElement("span");
    errorMark.className = "sector-error";
    errorMark.textContent = "×";
    errorMark.title = "该板块真实分时数据获取失败";
    row.append(indexEl, input, errorMark);
    sectorListEl.appendChild(row);
  });
}

function normalizeEditorName(name) {
  return String(name || "").replace(/\s+/g, "").toUpperCase();
}

function applySectorErrors(sectors = []) {
  const failedNames = new Set(
    sectors
      .filter((sector) => sector.error)
      .map((sector) => normalizeEditorName(sector.sampleName || sector.name)),
  );
  for (const row of sectorListEl.querySelectorAll(".sector-row")) {
    const input = row.querySelector("input");
    const mark = row.querySelector(".sector-error");
    if (!input || !mark) continue;
    mark.classList.toggle("is-visible", failedNames.has(normalizeEditorName(input.value)));
  }
}

function ensureEditorInitialized() {
  const saved = readSavedSectorNames();
  if (saved.length > 0) {
    renderSectorEditor(saved);
    modeEl.value = "custom";
    return;
  }
  renderSectorEditor([]);
  modeEl.value = "hot";
}

function applyDefaultSession() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  sessionEl.value = isTradingWeekday(now) && minutes >= 11 * 60 + 30 && minutes < 15 * 60 ? "morning" : "close";
  updateSessionOptionLabels();
  currentDataContext = resolveClientDataContext(sessionEl.value, now);
  updateReloadButtonText(currentDataContext);
}

async function fetchHotSectorNames() {
  statusEl.textContent = "正在获取同花顺板块热榜...";
  getHotEl.disabled = true;
  try {
    const response = await apiRequest(`/api/hot-sectors?hotType=concept&limit=30&session=${sessionEl.value}`);
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    const data = await response.json();
    const names = (data.sectors || []).map((sector) => sector.name).slice(0, 30);
    if (names.length === 0) throw new Error("没有拿到同花顺热榜板块");
    renderSectorEditor(names);
    modeEl.value = "hot";
    statusEl.textContent = `已列出同花顺热榜 ${names.length} 个板块，可逐个修改后保存为自定义名单。`;
  } catch (error) {
    statusEl.textContent = `获取热门失败：${error.message}`;
  } finally {
    getHotEl.disabled = false;
  }
}

async function fetchEastmoneyFlow(code) {
  const sectorCode = String(code || "").trim().toUpperCase();
  if (!/^BK\d{4}$/.test(sectorCode)) {
    throw new Error("缺少有效板块代码");
  }
  const response = await apiRequest(`/api/flow?code=${encodeURIComponent(sectorCode)}`);
  if (!response.ok) throw new Error(`真实分时接口返回 ${response.status}`);
  const data = await response.json();
  const points = data.points || [];
  if (!points.length) throw new Error("真实分时为空");
  return points;
}

async function hydrateRealMinuteFlows(data, limit) {
  const sectors = data.sectors || [];
  let cursor = 0;
  let nextRequestAt = performance.now();
  const hydrated = [];
  const concurrency = 2;
  const requestGapMs = 500;

  async function waitForRequestSlot() {
    const now = performance.now();
    const waitMs = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + requestGapMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  async function worker() {
    while (cursor < sectors.length) {
      const index = cursor;
      cursor += 1;
      const sector = sectors[index];
      try {
        statusEl.textContent = `正在获取真实分时：${sector.name} (${Math.min(index + 1, sectors.length)}/${sectors.length})`;
        await waitForRequestSlot();
        const points = await fetchEastmoneyFlow(sector.code);
        hydrated[index] = { ...sector, points, pointCount: points.length, synthetic: false, error: false };
      } catch (error) {
        hydrated[index] = { ...sector, points: [], pointCount: 0, synthetic: false, error: true, errorMessage: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sectors.length) }, () => worker()));
  const ordered = hydrated.filter(Boolean).slice(0, limit);
  return {
    ...data,
    sectors: ordered,
    failedCount: ordered.filter((sector) => sector.error).length,
    syntheticCount: 0,
    pointsReturned: true,
    pointsSource: "local-api-eastmoney-flow",
  };
}

function inferPointDataDate(sectors = []) {
  for (const sector of sectors) {
    const pointDate = String(sector.points?.[0]?.time || "").split(" ")[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(pointDate)) return pointDate;
  }
  return "";
}

function markAllSectorsFailed(data, message) {
  const sectors = (data.sectors || []).map((sector) => ({
    ...sector,
    points: [],
    pointCount: 0,
    synthetic: false,
    error: true,
    errorMessage: message,
  }));
  return {
    ...data,
    sectors,
    failedCount: sectors.length,
    syntheticCount: 0,
  };
}

async function saveClientFlow(data) {
  const payload = {
    ...data,
    queryTime: data.queryTime || formatClientQueryTime(),
  };
  const response = await apiRequest("/api/save-client-flow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return null;
  return response.json();
}

async function loadData() {
  // 防重入：即使按钮 disabled 在 finally 才解除，也避免快速连点中夹缝触发
  if (isLoading) return;
  isLoading = true;
  const mode = modeEl.value;
  const session = sessionEl.value;
  const pendingContext = resolveClientDataContext(session);
  updateReloadButtonText(pendingContext);
  statusEl.textContent = `正在拉取${mode === "custom" ? "自定义板块" : "同花顺热榜"}，随后获取东方财富真实分钟资金流...`;
  reloadEl.disabled = true;
  reloadEl.setAttribute("aria-busy", "true");

  try {
    const editorNames = getEditorNames();
    const useNamedList = mode === "custom";
    const names = useNamedList ? editorNames : [];
    if (useNamedList && names.length === 0) {
      throw new Error("请先保存或填写至少一个自定义板块名称");
    }
    const limit = useNamedList ? names.length : 30;
    const needsHistoricalData = pendingContext.dataDate !== dateStringFromDate(new Date());
    const endpoint = useNamedList
      ? `/api/custom-flow?clientFlow=1&limit=${limit}&session=${session}&names=${encodeURIComponent(names.join(","))}`
      : `/api/today-flow?clientFlow=1&mode=hot&hotType=concept&limit=${limit}&session=${session}`;
    const response = await apiRequest(endpoint);
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    let data = await response.json();
    data.queryTime = data.queryTime || formatClientQueryTime();
    if (needsHistoricalData) {
      const reason =
        mode === "hot"
          ? `同花顺热榜接口没有日期参数，无法获取 ${pendingContext.dataDate} 的历史热榜；东方财富分钟资金流接口也不支持按日期拉取该日分时。`
          : `东方财富分钟资金流接口不支持按日期拉取 ${pendingContext.dataDate} 的历史分时。`;
      data = markAllSectorsFailed(
        {
          ...data,
          dataDate: pendingContext.dataDate,
          session,
        },
        reason,
      );
      if (!useNamedList) {
        renderSectorEditor((data.sectors || []).map((sector) => sector.name));
      }
      const saved = await saveClientFlow(data);
      if (saved?.dataFile) data.dataFile = saved.dataFile;
      applySectorErrors(data.sectors || []);
      clearChartDisplay();
      currentDataContext = pendingContext;
      updateReloadButtonText(currentDataContext);
      titleEl.textContent = todayTitle(currentDataContext.session, currentDataContext.dataDate);
      const fileNote = data.dataFile?.path ? `已保存错误记录到 ${data.dataFile.path}。` : "";
      statusEl.textContent = `真实历史数据获取失败：${reason}${fileNote}`;
      return;
    }
    data = await hydrateRealMinuteFlows(data, limit);
    data.dataDate = inferPointDataDate(data.sectors) || data.dataDate;
    if (!useNamedList) {
      renderSectorEditor((data.sectors || []).map((sector) => sector.name));
    }
    const saved = await saveClientFlow(data);
    if (saved?.dataFile) data.dataFile = saved.dataFile;
    applySectorErrors(data.sectors || []);
    latestRows = normalizeRows(data.sectors || [], session);
    if (!latestRows.length) {
      const failedCount = Number(data.failedCount || data.sectors?.filter((sector) => sector.error).length || 0);
      clearChartDisplay();
      statusEl.textContent = `真实分时没有拿到可用曲线，${failedCount} 个板块已标红 ×；不会再用假曲线混入真实刷新结果。`;
      return;
    }

    currentDataContext = {
      session: data.session || session,
      dataDate: data.dataDate || pendingContext.dataDate,
    };
    updateReloadButtonText(currentDataContext);
    titleEl.textContent = todayTitle(currentDataContext.session, currentDataContext.dataDate);
    applyMarketMood(data.marketMood);
    const failedCount = Number(data.failedCount || 0);
    const pointCounts = (data.sectors || [])
      .filter((sector) => !sector.error)
      .map((sector) => Number(sector.pointCount || sector.points?.length || 0))
      .filter(Boolean);
    const pointText = pointCounts.length
      ? `每条线来自 ${Math.min(...pointCounts)}-${Math.max(...pointCounts)} 个真实分钟点。`
      : "";
    const previewNote =
      failedCount > 0
        ? `其中 ${failedCount} 个板块没有匹配到可用东方财富分钟资金流，已标红 × 且不画假线。`
        : "全部使用真实分钟资金流。";
    const scopeText = mode === "custom" ? "我的保存名单" : "同花顺热榜";
    const fileNote = data.dataFile?.path ? `已保存到 ${data.dataFile.path}。` : "";
    const hotNote = data.hotReturnedCount ? `同花顺本次返回 ${data.hotReturnedCount} 个热榜板块。` : "";
    statusEl.textContent = `已加载 ${scopeText} ${latestRows.length} 个。${hotNote}${moodText(data.marketMood)}${previewNote}${pointText}${fileNote}`;
    renderChart(latestRows, 0);
    animateRows(latestRows);
  } catch (error) {
    clearChartDisplay();
    statusEl.textContent = `加载失败：${error.message}`;
  } finally {
    isLoading = false;
    reloadEl.disabled = false;
    reloadEl.removeAttribute("aria-busy");
    updateReloadButtonText(currentDataContext);
  }
}

function renderInitialState() {
  const session = sessionEl.value;
  const context = resolveClientDataContext(session);
  currentDataContext = context;
  updateReloadButtonText(context);
  titleEl.textContent = todayTitle(context.session, context.dataDate);
  applyMarketMood({ tone: "green" });
  applySectorErrors([]);
  latestRows = [];
  currentTimeEl.textContent = "--:--";
  labelLayer.innerHTML = "";
  labelLines.innerHTML = "";
  xAxisLabelsEl.innerHTML = "";
  yAxisLabelsEl.innerHTML = "";
  labelNodes.clear();
  dotNodes.clear();
  if (chart) chart.clear();
  statusEl.textContent = `点击“${reloadEl.textContent}”后获取同花顺热榜，再用东方财富真实分钟资金流绘图。`;
}

function clearChartDisplay() {
  latestRows = [];
  currentTimeEl.textContent = "--:--";
  labelLayer.innerHTML = "";
  labelLines.innerHTML = "";
  xAxisLabelsEl.innerHTML = "";
  yAxisLabelsEl.innerHTML = "";
  labelNodes.clear();
  dotNodes.clear();
  if (chart) chart.clear();
}

window.addEventListener("resize", () => {
  if (!chart) return;
  chart.resize();
  if (latestRows.length) renderChart(latestRows, activeFrame);
});

reloadEl.addEventListener("click", loadData);
modeEl.addEventListener("change", markFiltersPendingRefresh);
sessionEl.addEventListener("change", markFiltersPendingRefresh);
watermarkNameEl.addEventListener("input", () => {
  applyWatermarkName(watermarkNameEl.value);
});
watermarkNameEl.addEventListener("change", () => {
  const value = watermarkNameEl.value.trim() || DEFAULT_WATERMARK_NAME;
  writeWatermarkName(value);
  applyWatermarkName(value);
});
getHotEl.addEventListener("click", fetchHotSectorNames);
saveSectorsEl.addEventListener("click", () => {
  const names = getEditorNames().slice(0, 50);
  if (names.length === 0) {
    statusEl.textContent = "请至少保留一个板块名称。";
    return;
  }
  writeSavedSectorNames(names);
  modeEl.value = "custom";
  markFiltersPendingRefresh();
});
resetSectorsEl.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  renderSectorEditor([]);
  modeEl.value = "hot";
  renderInitialState();
});

if (window.echarts) {
  applyDefaultSession();
  applyWatermarkName();
  ensureEditorInitialized();
  renderInitialState();
  // 没有保存的自定义名单时，进页面自动拉取一次同花顺热榜
  if (modeEl.value === "hot") {
    fetchHotSectorNames();
  }
} else {
  statusEl.textContent = "ECharts 加载失败，请检查浏览器能否访问 CDN。";
}
