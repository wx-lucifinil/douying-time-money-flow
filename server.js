import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const port = Number(process.env.PORT || 4173);

const EASTMONEY_UT = "b2884a393a59ad64002292a3e90d46a5";
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Referer: "https://data.eastmoney.com/bkzj/hy.html",
};

const thsHeaders = {
  ...headers,
  Referer: "https://eq.10jqka.com.cn/webpage/ths-hot-list/index.html?showStatusBar=true",
  Origin: "https://eq.10jqka.com.cn",
};

const sectorFs = {
  industry: "m:90+t:2",
  concept: "m:90+t:3",
  region: "m:90+t:1",
};

const indexSecids = "1.000001,0.399001,0.399006,1.000688";
const sampleSectorSpecs = [
  ["有色金属", 39.34],
  ["电力", 37.29],
  ["锂矿", 24.24],
  ["网络游戏", 18.4],
  ["煤炭", 10.78],
  ["创新药", 10.56],
  ["银行II", 6.52],
  ["白酒", 0.32],
  ["AI应用", -4.4],
  ["电网设备", -10.67],
  ["人形机器人", -16.16],
  ["光学光电子", -19.94],
  ["证券", -33.44],
  ["化工", -43.46],
  ["半导体设备", -72.81],
  ["电力设备", -76.96],
  ["MLCC", -77.76],
  ["锂电池", -87.07],
  ["玻璃基板", -97.38],
  ["消费电子", -102.95],
  ["储能", -118.86],
  ["商业航天", -126.93],
  ["光纤", -155.73],
  ["液冷服务器", -171.55],
  ["人工智能", -245.47],
  ["PCB", -251.61],
  ["算力租赁", -257.32],
  ["CPO", -329.57],
  ["半导体", -484.31],
  ["存储芯片", -512.19],
  ["通信技术", -598.53],
];

const sampleSectorAliases = {
  银行: ["银行II", "银行"],
  证券: ["证券", "券商概念"],
  化工: ["化工", "化学原料"],
  AI应用: ["AI应用", "AIGC概念", "ChatGPT概念"],
  锂矿: ["锂矿", "盐湖提锂"],
  通信技术: ["通信技术", "通信服务", "通信设备"],
  机器人概念: ["人形机器人", "机器人概念", "机器人"],
  "共封装光学(CPO)": ["共封装光学(CPO)", "CPO", "共封装光学"],
  氟化工概念: ["氟化工概念", "氟化工"],
  黄金概念: ["黄金概念", "黄金", "贵金属"],
  PCB概念: ["PCB概念", "PCB"],
  ST板块: ["ST板块", "ST股"],
  光刻胶: ["光刻胶", "光刻机(胶)"],
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const sessionNames = new Set(["morning", "close"]);
const oneDayMs = 24 * 60 * 60 * 1000;

function dateStringFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatQueryTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function isTradingWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function previousTradingDate(date) {
  const previous = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  do {
    previous.setTime(previous.getTime() - oneDayMs);
  } while (!isTradingWeekday(previous));
  return dateStringFromDate(previous);
}

function defaultSessionForNow(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (isTradingWeekday(date) && minutes >= 11 * 60 + 30 && minutes < 15 * 60) {
    return "morning";
  }
  return "close";
}

function resolveDataContext(searchParams = new URLSearchParams()) {
  const now = new Date();
  const requestedSession = searchParams.get("session");
  const session = sessionNames.has(requestedSession) ? requestedSession : defaultSessionForNow(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  let dataDate = dateStringFromDate(now);
  if (!isTradingWeekday(now)) {
    dataDate = previousTradingDate(now);
  } else if (session === "morning" && minutes < 11 * 60 + 30) {
    dataDate = previousTradingDate(now);
  } else if (session === "close" && minutes < 15 * 60) {
    dataDate = previousTradingDate(now);
  }

  return {
    session,
    dataDate,
    queryTime: formatQueryTime(now),
    generatedAt: now.toISOString(),
  };
}

function dataFileName(dataContext) {
  return dataContext.session === "morning" ? "morning.json" : "close.json";
}

function dataFilePath(dataContext) {
  return join(dataDir, dataContext.dataDate, dataFileName(dataContext));
}

function pointDate(point) {
  return String(point?.time || "").split(" ")[0];
}

function pointMinute(point) {
  const minute = String(point?.time || "").match(/\d{2}:\d{2}/)?.[0] || "";
  return minute;
}

function validateSavedSnapshot(payload, dataContext) {
  const sectors = Array.isArray(payload?.sectors) ? payload.sectors : [];
  if (!sectors.length) {
    throw new Error("本地快照没有板块数据");
  }
  const pointDates = new Set();
  let latestMinute = "";
  for (const sector of sectors) {
    const points = Array.isArray(sector.points) ? sector.points : [];
    for (const point of points) {
      const date = pointDate(point);
      const minute = pointMinute(point);
      if (date) pointDates.add(date);
      if (minute > latestMinute) latestMinute = minute;
    }
  }
  if (pointDates.size !== 1 || !pointDates.has(dataContext.dataDate)) {
    throw new Error(`本地快照日期不匹配：需要 ${dataContext.dataDate}，实际 ${[...pointDates].join(", ") || "空"}`);
  }
  const requiredMinute = dataContext.session === "morning" ? "11:30" : "15:00";
  if (latestMinute < requiredMinute) {
    throw new Error(`本地${dataContext.session === "morning" ? "午盘" : "收盘"}快照不完整：最后分钟 ${latestMinute || "空"}`);
  }
}

async function readSavedFlow(searchParams) {
  const dataDate = searchParams.get("dataDate") || resolveDataContext(searchParams).dataDate;
  const requestedSession = searchParams.get("session");
  const session = sessionNames.has(requestedSession) ? requestedSession : "close";
  const dataContext = { dataDate, session };
  const filePath = dataFilePath(dataContext);
  let payload;
  try {
    payload = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`没有找到本地快照 data/${dataDate}/${dataFileName(dataContext)}`);
  }
  validateSavedSnapshot(payload, dataContext);
  return {
    ...payload,
    loadedFromSnapshot: true,
    dataFile: {
      path: `data/${dataDate}/${dataFileName(dataContext)}`,
      written: false,
    },
  };
}

async function writeJsonIfChanged(filePath, payload) {
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    const existing = await readFile(filePath, "utf8");
    const existingPayload = JSON.parse(existing);
    const comparableExisting = JSON.stringify(stripVolatileFields(existingPayload));
    const comparableNext = JSON.stringify(stripVolatileFields(payload));
    if (comparableExisting === comparableNext) return false;
  } catch {
    // The first run creates the file.
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return true;
}

function stripVolatileFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["generatedAt", "savedAt"].includes(key))
      .map(([key, item]) => [key, stripVolatileFields(item)]),
  );
}

async function persistDailyFlow(payload, dataContext) {
  const fileName = dataFileName(dataContext);
  const filePath = dataFilePath(dataContext);
  const savedPayload = {
    ...payload,
    dataDate: dataContext.dataDate,
    session: dataContext.session,
    queryTime: payload.queryTime || dataContext.queryTime || formatQueryTime(),
    generatedAt: payload.generatedAt || dataContext.generatedAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  const written = await writeJsonIfChanged(filePath, savedPayload);
  return {
    path: `data/${dataContext.dataDate}/${fileName}`,
    written,
  };
}

async function persistHotSectors(payload, dataContext) {
  const folder = join(dataDir, dataContext.dataDate);
  const filePath = join(folder, "hot-sectors.json");
  const savedPayload = {
    ...payload,
    dataDate: dataContext.dataDate,
    session: dataContext.session,
    queryTime: payload.queryTime || dataContext.queryTime || formatQueryTime(),
    generatedAt: payload.generatedAt || dataContext.generatedAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  const written = await writeJsonIfChanged(filePath, savedPayload);
  return {
    path: `data/${dataContext.dataDate}/hot-sectors.json`,
    written,
  };
}

function sendJson(res, status, body) {
  const hasQueryTime =
    body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "queryTime");
  const payload = hasQueryTime ? body : { ...body, queryTime: formatQueryTime() };
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function unwrapEastmoneyJson(text) {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace > -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(trimmed);
}

async function fetchEastmoney(url, options = {}) {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 8000;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Eastmoney request failed: ${response.status}`);
      }
      return unwrapEastmoneyJson(await response.text());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchThs(url, options = {}) {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 8000;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: thsHeaders, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Tonghuashun request failed: ${response.status}`);
      }
      return JSON.parse(await response.text());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function collectFlowsWithConcurrency(candidates, wanted, concurrency) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length && results.length < wanted) {
      const sector = candidates[cursor];
      cursor += 1;
      try {
        const points = await getFlow(sector.code);
        if (!points.length) {
          throw new Error("No minute flow data");
        }
        if (results.length < wanted) {
          results.push({ ...sector, points, pointCount: points.length, synthetic: false, error: false });
        }
      } catch (error) {
        if (results.length < wanted) {
          results.push({
            ...sector,
            points: [],
            pointCount: 0,
            synthetic: false,
            error: true,
            errorMessage: error.message,
          });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );
  return results.slice(0, wanted);
}

function sectorTypeFromSearch(searchParams) {
  const type = searchParams.get("type") || "industry";
  return sectorFs[type] ? type : "industry";
}

async function getSectors(type = "industry") {
  const rows = [];
  const pageSize = 100;
  for (let page = 1; page <= 30; page += 1) {
    const url = new URL("https://push2delay.eastmoney.com/api/qt/clist/get");
    url.search = new URLSearchParams({
      fid: "f62",
      po: "1",
      pz: String(pageSize),
      pn: String(page),
      np: "1",
      fltt: "2",
      invt: "2",
      ut: EASTMONEY_UT,
      fs: sectorFs[type],
      fields: "f12,f14,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87",
    }).toString();

    const json = await fetchEastmoney(url, { retries: 3, timeoutMs: 8000 });
    const pageRows = json?.data?.diff || [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }
  return rows
    .filter((row) => row.f12 && row.f14 && Number.isFinite(Number(row.f62)))
    .map((row) => ({
      code: row.f12,
      name: row.f14,
      type,
      changePct: Number(row.f3),
      mainNet: Number(row.f62),
      mainRatio: Number(row.f184),
      hugeNet: Number(row.f66),
      bigNet: Number(row.f72),
      midNet: Number(row.f78),
      smallNet: Number(row.f84),
    }));
}

async function getAllSectors() {
  const groups = await Promise.all(
    Object.keys(sectorFs).map(async (type) => getSectors(type)),
  );
  const seen = new Set();
  return groups.flat().filter((sector) => {
    const key = `${sector.code}:${sector.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSectorName(name) {
  return String(name || "")
    .replace(/\s+/g, "")
    .replace(/[（(](.*?)[）)]/g, "$1")
    .replace(/[ⅠⅡⅢIV]+$/i, "")
    .replace(/概念$/g, "")
    .toUpperCase();
}

function matchSectorByName(name, sectors) {
  const aliases = [name, ...(sampleSectorAliases[name] || [])];
  for (const alias of aliases) {
    const normalized = normalizeSectorName(alias);
    const exact = sectors.find((sector) => normalizeSectorName(sector.name) === normalized);
    if (exact) return { sector: exact, method: alias === name ? "exact-name" : "alias-exact", matchedBy: alias, confidence: 1 };
  }
  for (const alias of aliases) {
    const normalized = normalizeSectorName(alias);
    const fuzzy = sectors.find((sector) => {
      const sectorName = normalizeSectorName(sector.name);
      return sectorName.includes(normalized) || normalized.includes(sectorName);
    });
    if (fuzzy) return { sector: fuzzy, method: alias === name ? "fuzzy-name" : "alias-fuzzy", matchedBy: alias, confidence: 0.72 };
  }
  return null;
}

function pickSampleSectors(sectors, limit) {
  const picked = [];
  const usedCodes = new Set();
  for (const [name, fallbackYi] of sampleSectorSpecs) {
    const match = matchSectorByName(name, sectors);
    const sector = match?.sector;
    if (sector && !usedCodes.has(sector.code)) {
      picked.push({ ...sector, name, sampleName: name, mainNet: fallbackYi * 100000000 });
      usedCodes.add(sector.code);
    } else {
      picked.push({
        code: `SAMPLE${String(picked.length + 1).padStart(3, "0")}`,
        name,
        sampleName: name,
        type: "sample",
        changePct: 0,
        mainNet: fallbackYi * 100000000,
        mainRatio: 0,
        hugeNet: 0,
        bigNet: 0,
        midNet: 0,
        smallNet: 0,
      });
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

function pickNamedSectors(names, sectors, limit) {
  const picked = [];
  const usedCodes = new Set();
  for (const rawName of names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const match = matchSectorByName(name, sectors);
    const sector = match?.sector;
    if (sector && !usedCodes.has(sector.code)) {
      picked.push({ ...sector, name });
      usedCodes.add(sector.code);
    } else {
      picked.push({
        code: `CUSTOM${String(picked.length + 1).padStart(3, "0")}`,
        name,
        type: "custom",
        changePct: 0,
        mainNet: 0,
        mainRatio: 0,
        hugeNet: 0,
        bigNet: 0,
        midNet: 0,
        smallNet: 0,
      });
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

async function getThsHotPlates(type = "concept") {
  const thsType = type === "industry" ? "industry" : "concept";
  const url = new URL("https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate");
  url.searchParams.set("type", thsType);
  const json = await fetchThs(url, { retries: 3, timeoutMs: 10000 });
  const rows = json?.data?.plate_list || [];
  return rows
    .filter((row) => row?.name)
    .map((row) => ({
      thsCode: String(row.code || ""),
      thsType,
      name: String(row.name || "").trim(),
      hotRank: Number(row.order || 0),
      hot: Number(row.rate || 0),
      hotTag: row.hot_tag || "",
      hotReason: row.tag || "",
      thsMarketId: row.market_id || "",
      thsEtfName: row.etf_name || "",
      thsEtfRate: row.etf_rate || "",
      changePct: Number(row.change || row.platenum || 0),
    }));
}

async function getThsHotPlateCandidates(type = "concept", limit = 30) {
  const primaryType = type === "industry" ? "industry" : "concept";
  const fallbackType = primaryType === "concept" ? "industry" : "concept";
  const primaryRows = await getThsHotPlates(primaryType);
  if (primaryRows.length >= limit) return primaryRows.slice(0, limit);

  const fallbackRows = await getThsHotPlates(fallbackType);
  const seen = new Set(primaryRows.map((row) => normalizeSectorName(row.name)));
  const merged = [...primaryRows];
  for (const row of fallbackRows) {
    const key = normalizeSectorName(row.name);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
}

function pickThsHotSectors(hotRows, sectors, limit) {
  const picked = [];
  const usedCodes = new Set();
  for (const hot of hotRows) {
    const match = matchSectorByName(hot.name, sectors);
    const matched = match?.sector;
    const base = {
      name: hot.name,
      hotSource: "tonghuashun",
      hotRank: hot.hotRank,
      hot: hot.hot,
      hotTag: hot.hotTag,
      hotReason: hot.hotReason,
      thsCode: hot.thsCode,
      thsType: hot.thsType,
      thsMarketId: hot.thsMarketId,
      thsEtfName: hot.thsEtfName,
      thsEtfRate: hot.thsEtfRate,
    };
    if (matched && !usedCodes.has(matched.code)) {
      picked.push({
        ...matched,
        ...base,
        eastmoneyCode: matched.code,
        eastmoneyName: matched.name,
        matchMethod: match.method,
        matchedBy: match.matchedBy,
        matchConfidence: match.confidence,
        changePct: Number.isFinite(hot.changePct) ? hot.changePct : matched.changePct,
      });
      usedCodes.add(matched.code);
    } else {
      picked.push({
        ...base,
        code: `THS${hot.thsCode || String(picked.length + 1).padStart(3, "0")}`,
        eastmoneyCode: null,
        type: "ths",
        changePct: Number.isFinite(hot.changePct) ? hot.changePct : 0,
        mainNet: 0,
        mainRatio: 0,
        hugeNet: 0,
        bigNet: 0,
        midNet: 0,
        smallNet: 0,
        missingEastmoneyMatch: true,
        matchMethod: "unmatched",
        matchConfidence: 0,
      });
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

async function getIndexQuotes() {
  const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
  url.search = new URLSearchParams({
    fltt: "2",
    invt: "2",
    fields: "f12,f14,f2,f3,f4",
    secids: indexSecids,
    ut: EASTMONEY_UT,
  }).toString();

  const json = await fetchEastmoney(url, { retries: 3, timeoutMs: 8000 });
  const rows = json?.data?.diff || [];
  return rows.map((row) => ({
    code: row.f12,
    name: row.f14,
    price: Number(row.f2),
    changePct: Number(row.f3),
    change: Number(row.f4),
  }));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function calculateMarketMood(indexes, sectors) {
  const usableIndexes = indexes.filter((item) => Number.isFinite(item.changePct));
  const usableSectors = sectors.filter(
    (item) => Number.isFinite(item.changePct) && Number.isFinite(item.mainNet),
  );
  const indexAverage =
    usableIndexes.reduce((sum, item) => sum + item.changePct, 0) / Math.max(usableIndexes.length, 1);
  const sectorAverage =
    usableSectors.reduce((sum, item) => sum + item.changePct, 0) / Math.max(usableSectors.length, 1);
  const upCount = usableSectors.filter((item) => item.changePct > 0).length;
  const downCount = usableSectors.filter((item) => item.changePct < 0).length;
  const sectorBreadth = (upCount - downCount) / Math.max(usableSectors.length, 1);
  const netFlow = usableSectors.reduce((sum, item) => sum + item.mainNet, 0);
  const grossFlow = usableSectors.reduce((sum, item) => sum + Math.abs(item.mainNet), 0);
  const flowBalance = grossFlow > 0 ? netFlow / grossFlow : 0;

  const indexScore = clamp(indexAverage / 3, -1, 1);
  const sectorScore = clamp(sectorBreadth * 0.65 + clamp(sectorAverage / 3, -1, 1) * 0.35, -1, 1);
  const score = clamp(indexScore * 0.55 + sectorScore * 0.25 + flowBalance * 0.2, -1, 1);

  return {
    tone: score >= 0 ? "red" : "green",
    score,
    indexAverage,
    sectorAverage,
    upCount,
    downCount,
    netFlow,
    indexes: usableIndexes,
  };
}

async function getFlow(code) {
  const sectorCode = String(code || "").trim().toUpperCase();
  if (!/^BK\d{4}$/.test(sectorCode)) {
    throw new Error("Invalid sector code");
  }

  const url = new URL("https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get");
  url.search = new URLSearchParams({
    lmt: "0",
    klt: "1",
    secid: `90.${sectorCode}`,
    fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55",
    ut: EASTMONEY_UT,
  }).toString();

  const json = await fetchEastmoney(url, { retries: 2, timeoutMs: 12000 });
  const klines = json?.data?.klines || [];
  return klines.map((line) => {
    const [time, mainNet, smallNet, midNet, bigNet] = String(line).split(",");
    return {
      time,
      mainNet: Number(mainNet),
      smallNet: Number(smallNet),
      midNet: Number(midNet),
      bigNet: Number(bigNet),
    };
  });
}

function pickHotSectors(sectors, mode, limit) {
  if (mode === "sample") {
    return pickSampleSectors(sectors, limit);
  }
  const ranked = [...sectors].sort((a, b) => {
    if (mode === "inflow") return b.mainNet - a.mainNet;
    if (mode === "outflow") return a.mainNet - b.mainNet;
    return Math.abs(b.mainNet) - Math.abs(a.mainNet);
  });
  return ranked.slice(0, limit);
}

async function getTodayFlow(searchParams) {
  const dataContext = resolveDataContext(searchParams);
  const mode = searchParams.get("mode") || "hot";
  const hotType = searchParams.get("hotType") === "industry" ? "industry" : "concept";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 30), 5), 50);
  let source = "eastmoney";
  let type = sectorTypeFromSearch(searchParams);
  let sectors;
  let candidates;
  let hotRows = [];
  const indexes = await getIndexQuotes();
  if (mode === "hot") {
    source = "tonghuashun/eastmoney";
    type = hotType;
    const [allSectors, thsRows] = await Promise.all([getAllSectors(), getThsHotPlateCandidates(hotType, limit)]);
    sectors = allSectors;
    hotRows = thsRows;
    candidates = pickThsHotSectors(hotRows, sectors, limit);
  } else {
    sectors = mode === "sample" ? await getAllSectors() : await getSectors(type);
    const candidateLimit = mode === "sample" ? limit : Math.min(sectors.length, limit * 4);
    candidates = pickHotSectors(sectors, mode, candidateLimit);
  }
  if (searchParams.get("clientFlow") === "1") {
    return {
      source,
      type,
      mode,
      hotType: mode === "hot" ? hotType : undefined,
      limit,
      pointsReturned: false,
      pointsSource: "client-local-api-eastmoney-flow",
      generatedAt: dataContext.generatedAt,
      queryTime: dataContext.queryTime,
      dataDate: dataContext.dataDate,
      session: dataContext.session,
      marketMood: calculateMarketMood(indexes, sectors),
      hotReturnedCount: mode === "hot" ? hotRows.length : undefined,
      sectors: candidates.slice(0, limit),
    };
  }
  const flows = await collectFlowsWithConcurrency(candidates, limit, 2);

  const payload = {
    source,
    type,
    mode,
    hotType: mode === "hot" ? hotType : undefined,
    limit,
    generatedAt: dataContext.generatedAt,
    queryTime: dataContext.queryTime,
    dataDate: flows.find((item) => item.points?.[0])?.points?.[0]?.time?.split(" ")?.[0] || dataContext.dataDate,
    session: dataContext.session,
    marketMood: calculateMarketMood(indexes, sectors),
    hotReturnedCount: mode === "hot" ? hotRows.length : undefined,
    syntheticCount: flows.filter((item) => item.synthetic).length,
    failedCount: flows.filter((item) => item.error).length,
    sectors: flows,
  };
  return {
    ...payload,
    dataFile: await persistDailyFlow(payload, dataContext),
  };
}

function parseNames(searchParams) {
  const raw = searchParams.get("names") || "";
  return raw
    .split(/[,\n，]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

async function getCustomFlow(searchParams) {
  const dataContext = resolveDataContext(searchParams);
  const names = parseNames(searchParams);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || names.length || 30), 5), 50);
  const [sectors, indexes] = await Promise.all([getAllSectors(), getIndexQuotes()]);
  const candidates = pickNamedSectors(names, sectors, limit);
  if (searchParams.get("clientFlow") === "1") {
    return {
      source: "eastmoney",
      type: "custom",
      mode: "custom",
      limit,
      pointsReturned: false,
      pointsSource: "client-local-api-eastmoney-flow",
      generatedAt: dataContext.generatedAt,
      queryTime: dataContext.queryTime,
      dataDate: dataContext.dataDate,
      session: dataContext.session,
      marketMood: calculateMarketMood(indexes, sectors),
      sectors: candidates,
      names,
    };
  }
  const flows = await collectFlowsWithConcurrency(candidates, limit, 2);

  const payload = {
    source: "eastmoney",
    type: "custom",
    mode: "custom",
    limit,
    generatedAt: dataContext.generatedAt,
    queryTime: dataContext.queryTime,
    dataDate: dataContext.dataDate,
    session: dataContext.session,
    marketMood: calculateMarketMood(indexes, sectors),
    syntheticCount: flows.filter((item) => item.synthetic).length,
    failedCount: flows.filter((item) => item.error).length,
    sectors: flows,
    names,
  };
  return {
    ...payload,
    dataFile: await persistDailyFlow(payload, dataContext),
  };
}

async function getHotSectors(searchParams) {
  const dataContext = resolveDataContext(searchParams);
  const hotType = searchParams.get("hotType") === "industry" ? "industry" : "concept";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 30), 5), 50);
  const [sectors, hotRows] = await Promise.all([getAllSectors(), getThsHotPlateCandidates(hotType, limit)]);
  const picked = pickThsHotSectors(hotRows, sectors, limit);
  const payload = {
    source: "tonghuashun/eastmoney",
    type: hotType,
    mode: "hot",
    generatedAt: dataContext.generatedAt,
    queryTime: dataContext.queryTime,
    dataDate: dataContext.dataDate,
    session: dataContext.session,
    limit,
    hotReturnedCount: hotRows.length,
    sectors: picked,
  };
  return {
    ...payload,
    dataFile: await persistHotSectors(payload, dataContext),
  };
}

async function getMarketMood(searchParams) {
  const type = sectorTypeFromSearch(searchParams);
  const [indexes, sectors] = await Promise.all([getIndexQuotes(), getSectors(type)]);
  return calculateMarketMood(indexes, sectors);
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/sectors") {
      sendJson(res, 200, {
        type: sectorTypeFromSearch(url.searchParams),
        sectors: await getSectors(sectorTypeFromSearch(url.searchParams)),
      });
      return;
    }

    if (url.pathname === "/api/flow") {
      const points = await getFlow(url.searchParams.get("code"));
      sendJson(res, 200, {
        code: url.searchParams.get("code"),
        points,
        pointCount: points.length,
        pointsSource: "eastmoney-flow-kline",
      });
      return;
    }

    if (url.pathname === "/api/today-flow") {
      sendJson(res, 200, await getTodayFlow(url.searchParams));
      return;
    }

    if (url.pathname === "/api/custom-flow") {
      sendJson(res, 200, await getCustomFlow(url.searchParams));
      return;
    }

    if (url.pathname === "/api/saved-flow") {
      sendJson(res, 200, await readSavedFlow(url.searchParams));
      return;
    }

    if (url.pathname === "/api/save-client-flow" && req.method === "POST") {
      const payload = await readRequestJson(req);
      const dataContext = {
        session: sessionNames.has(payload.session) ? payload.session : defaultSessionForNow(),
        dataDate: payload.dataDate || dateStringFromDate(new Date()),
        queryTime: payload.queryTime || formatQueryTime(),
        generatedAt: payload.generatedAt || new Date().toISOString(),
      };
      sendJson(res, 200, {
        dataFile: await persistDailyFlow(payload, dataContext),
      });
      return;
    }

    if (url.pathname === "/api/hot-sectors") {
      sendJson(res, 200, await getHotSectors(url.searchParams));
      return;
    }

    if (url.pathname === "/api/sample-sector-names") {
      sendJson(res, 200, { names: sampleSectorSpecs.map(([name]) => name) });
      return;
    }

    if (url.pathname === "/api/market-mood") {
      sendJson(res, 200, await getMarketMood(url.searchParams));
      return;
    }

    sendJson(res, 404, { error: "Unknown API route" });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
}).listen(port, () => {
  console.log(`Preview server running at http://localhost:${port}`);
});
