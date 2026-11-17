import fs from 'fs';
import path from 'path';
import {
  BRAIN_DIR,
  CONVERSATIONS_DIR,
  CLI_BRAIN_DIR,
  CLI_CONVERSATIONS_DIR,
  MONITOR_DATA_DIR,
  SUBSCRIPTION_PRESETS,
  CURRENCY_CONFIG,
  DEFAULT_USD_TO_CNY,
  HEATMAP_THEMES,
} from './constants.mjs';
import {
  MODEL_SELECTION_REGEX,
  calcEstimatedCost,
  computeMedian,
  getConversationDbSignature,
  getModelPricing,
  normalizeCanonicalModel,
  readConversationGenMetadata,
} from './models.mjs';

const SETTINGS_FILE = path.join(MONITOR_DATA_DIR, 'profile_settings.json');
const LEDGER_CACHE_FILE = path.join(MONITOR_DATA_DIR, 'ledger_cache_v1.json');
const CACHE_SCHEMA_VERSION = 3;
const MAX_SPEED_SAMPLES_PER_CONV = 60;
const MAX_SPEED_SAMPLES_PER_MODEL = 200;
const MEMORY_TTL_MS = 3000;

let cachedMemorySnapshot = null;
let cachedMemoryTime = 0;
let inFlightScanPromise = null;

export function clearLedgerMemoryCache() {
  cachedMemorySnapshot = null;
  cachedMemoryTime = 0;
}

function safeReadJsonSync(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const json = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    fs.writeFileSync(filePath, json, 'utf8');
  }
}

function formatLocalDateKey(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return '';
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalTodayAndPeriodKeys(now = new Date()) {
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  // 本自然周起始日（按周一为一周起点，贴合中文工作习惯）
  const dayOfWeek = now.getDay();
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
  const weekStartKey = formatLocalDateKey(monday);

  return { todayKey, monthPrefix, yearPrefix, weekStartKey };
}

export function getDefaultLedgerSettings() {
  return {
    presetId: 'pro_monthly',
    monthlyPrice: 19.99,
    currency: 'USD',
    usdToCny: DEFAULT_USD_TO_CNY,
    heatmapTheme: 'emerald',
  };
}

export function sanitizeLedgerSettings(raw = {}, base = getDefaultLedgerSettings()) {
  const next = { ...base };

  if (raw && typeof raw === 'object') {
    if (typeof raw.presetId === 'string') {
      const normalizedId = raw.presetId === 'ultra_monthly' ? 'ultra_20x' : raw.presetId;
      const matched = SUBSCRIPTION_PRESETS.find((p) => p.id === normalizedId);
      if (matched) next.presetId = matched.id;
    }

    if (typeof raw.currency === 'string' && CURRENCY_CONFIG[raw.currency.toUpperCase()]) {
      next.currency = raw.currency.toUpperCase();
    }

    if (raw.monthlyPrice !== undefined && raw.monthlyPrice !== null && raw.monthlyPrice !== '') {
      const price = Number(raw.monthlyPrice);
      if (Number.isFinite(price) && price >= 0 && price <= 1_000_000) {
        next.monthlyPrice = Math.round(price * 100) / 100;
      }
    }

    if (raw.usdToCny !== undefined && raw.usdToCny !== null && raw.usdToCny !== '') {
      const rate = Number(raw.usdToCny);
      if (Number.isFinite(rate) && rate > 0 && rate <= 1000) {
        next.usdToCny = Math.round(rate * 1000) / 1000;
      }
    }

    if (typeof raw.heatmapTheme === 'string' && HEATMAP_THEMES[raw.heatmapTheme]) {
      next.heatmapTheme = raw.heatmapTheme;
    }
  }

  return next;
}

export function getLedgerSettings() {
  const saved = safeReadJsonSync(SETTINGS_FILE, null);
  return sanitizeLedgerSettings(saved || {}, getDefaultLedgerSettings());
}

export function saveLedgerSettings(payload = {}) {
  const current = getLedgerSettings();
  const next = sanitizeLedgerSettings(payload, current);
  safeWriteJsonSync(SETTINGS_FILE, next);
  clearLedgerMemoryCache();
  return next;
}

function getSafeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * 扫描单个来源（desktop / cli）下的全部会话文件及元信息签名
 */
function discoverSourceConversations(source, brainDir, conversationsDir) {
  const itemsByConv = new Map();
  const visitedBrainDirs = new Set();

  if (brainDir && fs.existsSync(brainDir)) {
    try {
      const realBrain = fs.realpathSync(brainDir);
      if (!visitedBrainDirs.has(realBrain)) {
        visitedBrainDirs.add(realBrain);
        const entries = fs.readdirSync(realBrain, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const convId = entry.name;
          const dirPath = path.join(realBrain, convId);
          const pStd = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
          const pDirect = path.join(dirPath, 'transcript.jsonl');
          const transcriptPath = fs.existsSync(pStd) ? pStd : fs.existsSync(pDirect) ? pDirect : '';
          if (!transcriptPath) continue;
          const tStat = getSafeStat(transcriptPath);
          if (!tStat) continue;

          itemsByConv.set(convId, {
            source,
            convId,
            conversationsDir,
            transcriptPath,
            tStat,
            dbPath: '',
            pbPath: '',
            pbStat: null,
          });
        }
      }
    } catch {}
  }

  if (conversationsDir && fs.existsSync(conversationsDir)) {
    try {
      const files = fs.readdirSync(conversationsDir);
      for (const name of files) {
        if (!name.endsWith('.db') && !name.endsWith('.pb')) continue;
        const convId = name.slice(0, -3);
        const fullPath = path.join(conversationsDir, name);
        const st = getSafeStat(fullPath);
        if (!st || !st.isFile()) continue;

        let rec = itemsByConv.get(convId);
        if (!rec) {
          rec = {
            source,
            convId,
            conversationsDir,
            transcriptPath: '',
            tStat: null,
            dbPath: '',
            pbPath: '',
            pbStat: null,
          };
          itemsByConv.set(convId, rec);
        }
        if (name.endsWith('.db')) rec.dbPath = fullPath;
        else if (name.endsWith('.pb')) {
          rec.pbPath = fullPath;
          rec.pbStat = st;
        }
      }
    } catch {}
  }

  const jobs = [];
  for (const rec of itemsByConv.values()) {
    const tSig = rec.tStat ? `${rec.tStat.mtimeMs}:${rec.tStat.size}` : '0:0';
    const dbSig = rec.dbPath ? getConversationDbSignature(rec.convId, rec.conversationsDir) : '0:0';
    const pbSig = rec.pbStat ? `${rec.pbStat.mtimeMs}:${rec.pbStat.size}` : '0:0';
    rec.sig = `${tSig}|${dbSig}|${pbSig}`;
    jobs.push(rec);
  }
  return jobs;
}

/**
 * 扫描单个会话的日志与 SQLite gen_metadata，输出可持久化缓存的紧凑日维度摘要
 */
function scanSingleConversation(job) {
  const { source, convId, conversationsDir, transcriptPath, tStat, pbStat } = job;
  const dailyByModel = {}; // dateKey -> modelKey -> { label, inp, cap, out, think, steps }
  const speedSamples = [];
  let isSubagent = false;
  let firstDate = '';
  let totalSteps = 0;

  const registerDate = (dateKey) => {
    if (!dateKey) return;
    if (!firstDate || dateKey < firstDate) firstDate = dateKey;
  };

  if (!transcriptPath) {
    const statRef = pbStat || (job.dbPath ? getSafeStat(job.dbPath) : null);
    if (statRef) {
      const ts =
        statRef.birthtimeMs && statRef.birthtimeMs > 946_684_800_000
          ? Math.min(statRef.birthtimeMs, statRef.mtimeMs)
          : statRef.mtimeMs;
      if (ts > 946_684_800_000) {
        registerDate(formatLocalDateKey(new Date(ts)));
      }
    }
    return {
      sig: job.sig,
      source,
      convId,
      isSubagent: false,
      firstDate,
      totalSteps: 0,
      dailyByModel,
      speedSamples,
    };
  }

  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const rawLines = content.split(/\r?\n/);
  // 全量扫描时禁用 LRU 缓存，避免 300+ 历史 DB 挤占实时会话监控缓存
  const genMetaInfo = readConversationGenMetadata(convId, { conversationsDir, useCache: false });
  const consumedGenRows = new Set();

  let currentModel = genMetaInfo?.latestDisplayName || '';
  let inExecutionMode = false;
  let checkedFirst = false;
  const seenCallKeys = new Set();

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i].trim();
    if (!raw) continue;
    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!checkedFirst) {
      checkedFirst = true;
      isSubagent = Boolean(item.source === 'SYSTEM' || item.type === 'SYSTEM_MESSAGE');
    }

    let itemDateKey = '';
    let itemTimeMs = 0;
    if (item.created_at) {
      const dt = new Date(item.created_at);
      if (!Number.isNaN(dt.getTime())) {
        itemTimeMs = dt.getTime();
        itemDateKey = formatLocalDateKey(dt);
        registerDate(itemDateKey);
      }
    }

    const textContent = typeof item.content === 'string' ? item.content : '';
    const isSystemOrUser = item.type === 'USER_INPUT' || item.type === 'SYSTEM_MESSAGE';
    if (isSystemOrUser && textContent.includes('USER_SETTINGS_CHANGE') && textContent.includes('Model Selection')) {
      const m = textContent.match(MODEL_SELECTION_REGEX);
      if (m && m[1]) {
        currentModel = m[1].replace(/\.+$/, '').trim();
      }
    }
    if (isSystemOrUser && textContent.includes('Plan mode is off: this turn runs on the execution model')) {
      inExecutionMode = true;
    } else if (isSystemOrUser && textContent.includes('Plan mode is on')) {
      inExecutionMode = false;
    }

    if (item.type !== 'PLANNER_RESPONSE') continue;

    const input = Number(item.input_tokens || 0);
    const cache = Number(item.cache_read_tokens || 0);
    const output = Number(item.output_tokens || 0);
    if (input + cache + output <= 0) continue;

    let genRec = null;
    if (genMetaInfo) {
      const stepIdx = item.step_index;
      if (stepIdx !== undefined && stepIdx !== null) {
        genRec = genMetaInfo.byStepIndex.get(stepIdx) || null;
      }
      if (!genRec) {
        genRec =
          genMetaInfo.records.find(
            (r) =>
              !consumedGenRows.has(r.rowIdx) &&
              r.inputTokens === input &&
              r.cacheReadTokens === cache &&
              r.outputTokens === output
          ) || null;
      }
      if (genRec) consumedGenRows.add(genRec.rowIdx);
    }

    // 同一会话内按 callId 或步号去重，避免重复写入行造成双倍计费
    const dedupKey = genRec?.callId
      ? `call:${genRec.callId}`
      : item.step_index !== undefined && item.step_index !== null
        ? `step:${item.step_index}:${input}:${cache}:${output}`
        : `line:${i}`;
    if (seenCallKeys.has(dedupKey)) continue;
    seenCallKeys.add(dedupKey);

    if (!itemDateKey && tStat) {
      itemTimeMs = tStat.mtimeMs;
      itemDateKey = formatLocalDateKey(new Date(itemTimeMs));
      registerDate(itemDateKey);
    }
    if (!itemDateKey) continue;

    let modelIdRaw = genRec?.modelId || '';
    let modelDispRaw = genRec?.displayName && genRec.displayName !== 'Unknown Model' ? genRec.displayName : '';
    if (!modelIdRaw && !modelDispRaw) {
      if (inExecutionMode && String(currentModel).toLowerCase().includes('orchestrator')) {
        modelIdRaw = 'gemini-4-hydrogen';
        modelDispRaw = 'Gemini 4 Hydrogen (Orchestrator)';
      } else {
        modelDispRaw = currentModel || 'Gemini 3.8 Flash';
      }
    }
    const canonical = normalizeCanonicalModel(modelIdRaw, modelDispRaw);

    let stepThink = 0;
    if (genRec && genRec.thinkingTokens !== null) {
      stepThink = Math.min(output, genRec.thinkingTokens);
    } else if (genRec && genRec.responseTokens !== null) {
      stepThink = Math.max(0, output - genRec.responseTokens);
    }

    if (!dailyByModel[itemDateKey]) dailyByModel[itemDateKey] = {};
    if (!dailyByModel[itemDateKey][canonical.modelKey]) {
      dailyByModel[itemDateKey][canonical.modelKey] = {
        label: canonical.displayName,
        inp: 0,
        cap: 0,
        out: 0,
        think: 0,
        steps: 0,
      };
    }
    const cell = dailyByModel[itemDateKey][canonical.modelKey];
    cell.inp += input;
    cell.cap += cache;
    cell.out += output;
    cell.think += stepThink;
    cell.steps += 1;
    totalSteps += 1;

    // 仅收录来自 SQLite gen_metadata 的持续流式真测速样本，过滤短结构化工具调用的 flush 脉冲
    if (genRec && output >= 60 && genRec.streamingSec !== null && genRec.streamingSec >= 0.8) {
      const streamSec = genRec.streamingSec;
      const totalGenSec = genRec.durationSec !== null && genRec.durationSec > 0.05 ? genRec.durationSec : streamSec;
      const rawStreamTps = output / streamSec;
      const rawE2eTps = totalGenSec ? output / totalGenSec : rawStreamTps;
      const isBurstAnomaly =
        streamSec < 1.2 && (genRec.ttftSec || 0) > streamSec * 3 && rawStreamTps > 500;

      if (!isBurstAnomaly && rawStreamTps > 0 && rawStreamTps <= 2000) {
        const sTps = Number(rawStreamTps.toFixed(1));
        const eTps = Number((rawE2eTps || rawStreamTps).toFixed(1));
        const ttftVal = genRec.ttftSec !== null && genRec.ttftSec >= 0 ? Number(genRec.ttftSec.toFixed(2)) : null;
        const durVal = totalGenSec ? Number(totalGenSec.toFixed(2)) : null;
        speedSamples.push([
          itemTimeMs || Date.now(),
          canonical.modelKey,
          canonical.displayName,
          sTps,
          eTps,
          ttftVal,
          durVal,
          output,
        ]);
      }
    }
  }

  return {
    sig: job.sig,
    source,
    convId,
    isSubagent,
    firstDate,
    totalSteps,
    dailyByModel,
    speedSamples: speedSamples.slice(-MAX_SPEED_SAMPLES_PER_CONV),
  };
}

/**
 * 按来源过滤条件聚合全量多维账本（热力图、月/年走势、模型费率明细、模型测速排行）
 */
function buildViewAggregation(entries, sourceFilter = 'all', periodKeys) {
  const { todayKey, monthPrefix, yearPrefix, weekStartKey } = periodKeys;

  const dailyMap = {};
  const monthAcc = {};
  const yearAcc = {};
  const modelAcc = {};
  const speedBuckets = new Map();

  let grandTotalTokens = 0;
  let totalInputTokens = 0;
  let totalCacheTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let todayTokens = 0;
  let weekTokens = 0;
  let monthTokens = 0;
  let yearTokens = 0;
  let totalCostUSD = 0;
  let monthCostUSD = 0;
  let todayCostUSD = 0;
  let totalSteps = 0;
  let mainConversations = 0;
  let subagentConversations = 0;
  let firstUseDate = '';

  for (const entry of entries) {
    if (!entry) continue;
    if (sourceFilter !== 'all' && entry.source !== sourceFilter) continue;

    if (entry.isSubagent) subagentConversations++;
    else mainConversations++;

    if (entry.firstDate && (!firstUseDate || entry.firstDate < firstUseDate)) {
      firstUseDate = entry.firstDate;
    }

    const dailyObj = entry.dailyByModel || {};
    for (const [dateKey, modelsObj] of Object.entries(dailyObj)) {
      if (!firstUseDate || dateKey < firstUseDate) firstUseDate = dateKey;
      const monthKey = dateKey.slice(0, 7);
      const yearKey = dateKey.slice(0, 4);

      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = { total: 0, input: 0, cache: 0, output: 0, thinking: 0, steps: 0, costUSD: 0 };
      }
      if (!monthAcc[monthKey]) {
        monthAcc[monthKey] = { month: monthKey, total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, activeDaysSet: new Set() };
      }
      if (!yearAcc[yearKey]) {
        yearAcc[yearKey] = { year: yearKey, total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, activeDaysSet: new Set() };
      }

      const dCell = dailyMap[dateKey];
      const mCell = monthAcc[monthKey];
      const yCell = yearAcc[yearKey];

      for (const [modelKey, stat] of Object.entries(modelsObj)) {
        const inp = stat.inp || 0;
        const cap = stat.cap || 0;
        const out = stat.out || 0;
        const think = stat.think || 0;
        const steps = stat.steps || 0;
        const tok = inp + cap + out;
        if (tok <= 0) continue;

        const canonical = normalizeCanonicalModel(
          modelKey,
          stat.label && stat.label !== modelKey ? stat.label : ''
        );
        const modelPricingName = `${canonical.modelKey} ${canonical.displayName}`;
        const costUSD = calcEstimatedCost(inp, cap, out, modelPricingName, dateKey);

        grandTotalTokens += tok;
        totalInputTokens += inp;
        totalCacheTokens += cap;
        totalOutputTokens += out;
        totalThinkingTokens += think;
        totalSteps += steps;
        totalCostUSD += costUSD;

        if (dateKey === todayKey) {
          todayTokens += tok;
          todayCostUSD += costUSD;
        }
        if (dateKey >= weekStartKey && dateKey <= todayKey) {
          weekTokens += tok;
        }
        if (monthKey === monthPrefix) {
          monthTokens += tok;
          monthCostUSD += costUSD;
        }
        if (yearKey === yearPrefix) {
          yearTokens += tok;
        }

        dCell.total += tok;
        dCell.input += inp;
        dCell.cache += cap;
        dCell.output += out;
        dCell.thinking += think;
        dCell.steps += steps;
        dCell.costUSD += costUSD;

        mCell.total += tok;
        mCell.input += inp;
        mCell.cache += cap;
        mCell.output += out;
        mCell.steps += steps;
        mCell.costUSD += costUSD;
        mCell.activeDaysSet.add(dateKey);

        yCell.total += tok;
        yCell.input += inp;
        yCell.cache += cap;
        yCell.output += out;
        yCell.steps += steps;
        yCell.costUSD += costUSD;
        yCell.activeDaysSet.add(dateKey);

        if (!modelAcc[canonical.modelKey]) {
          const rates = getModelPricing(modelPricingName, todayKey);
          modelAcc[canonical.modelKey] = {
            modelKey: canonical.modelKey,
            modelLabel: canonical.displayName,
            pricingTier: canonical.pricingTier,
            rates: { input: rates.input, cacheRead: rates.cacheRead, output: rates.output },
            steps: 0,
            input: 0,
            cache: 0,
            output: 0,
            total: 0,
            allTimeCostUSD: 0,
            monthCostUSD: 0,
            monthTotalTokens: 0,
            monthSteps: 0,
          };
        }
        const mItem = modelAcc[canonical.modelKey];
        mItem.steps += steps;
        mItem.input += inp;
        mItem.cache += cap;
        mItem.output += out;
        mItem.total += tok;
        mItem.allTimeCostUSD += costUSD;
        if (monthKey === monthPrefix) {
          mItem.monthCostUSD += costUSD;
          mItem.monthTotalTokens += tok;
          mItem.monthSteps += steps;
        }
      }
    }

    if (Array.isArray(entry.speedSamples)) {
      for (const s of entry.speedSamples) {
        const [ts, mKey, mLabel, streamingTps, e2eTps, ttftSec, durationSec, outTok] = s;
        if (!mKey || !Number.isFinite(streamingTps) || streamingTps <= 0) continue;
        let bucket = speedBuckets.get(mKey);
        if (!bucket) {
          const disp = mLabel && mLabel !== mKey ? mLabel : normalizeCanonicalModel(mKey, '').displayName;
          bucket = { modelKey: mKey, modelLabel: disp, rows: [] };
          speedBuckets.set(mKey, bucket);
        }
        bucket.rows.push({
          ts: Number(ts) || 0,
          date: ts ? formatLocalDateKey(new Date(ts)) : '',
          streamingTps,
          e2eTps: e2eTps || streamingTps,
          ttftSec: ttftSec !== null && ttftSec !== undefined ? ttftSec : null,
          durationSec: durationSec !== null && durationSec !== undefined ? durationSec : null,
          outTok: outTok || 0,
        });
      }
    }
  }

  for (const d of Object.values(dailyMap)) {
    d.costUSD = Math.round(d.costUSD * 10000) / 10000;
  }

  const activeDays = Object.values(dailyMap).filter((d) => d.total > 0).length;
  let companionDays = 0;
  if (firstUseDate) {
    const startMs = new Date(`${firstUseDate}T00:00:00`).getTime();
    const endMs = new Date(`${todayKey}T00:00:00`).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      companionDays = Math.floor((endMs - startMs) / 86_400_000) + 1;
    }
  }

  const totalPromptAll = totalInputTokens + totalCacheTokens;
  const overallCacheHitRate =
    totalPromptAll > 0 ? Math.round((totalCacheTokens / totalPromptAll) * 1000) / 10 : 0;

  const monthlyList = Object.values(monthAcc)
    .map((m) => {
      const mPrompt = m.input + m.cache;
      return {
        month: m.month,
        total: m.total,
        input: m.input,
        cache: m.cache,
        output: m.output,
        steps: m.steps,
        activeDays: m.activeDaysSet.size,
        cacheHitRate: mPrompt > 0 ? Math.round((m.cache / mPrompt) * 1000) / 10 : 0,
        costUSD: Math.round(m.costUSD * 10000) / 10000,
      };
    })
    .sort((a, b) => b.month.localeCompare(a.month));

  const yearlyList = Object.values(yearAcc)
    .map((y) => {
      const yPrompt = y.input + y.cache;
      return {
        year: y.year,
        total: y.total,
        input: y.input,
        cache: y.cache,
        output: y.output,
        steps: y.steps,
        activeDays: y.activeDaysSet.size,
        cacheHitRate: yPrompt > 0 ? Math.round((y.cache / yPrompt) * 1000) / 10 : 0,
        costUSD: Math.round(y.costUSD * 10000) / 10000,
      };
    })
    .sort((a, b) => b.year.localeCompare(a.year));

  const availableYears = yearlyList.map((y) => y.year);
  if (!availableYears.includes(yearPrefix)) {
    availableYears.unshift(yearPrefix);
  }

  const modelBreakdown = Object.values(modelAcc)
    .map((m) => {
      const mPrompt = m.input + m.cache;
      return {
        ...m,
        cacheHitRate: mPrompt > 0 ? Math.round((m.cache / mPrompt) * 1000) / 10 : 0,
        allTimeCostUSD: Math.round(m.allTimeCostUSD * 10000) / 10000,
        monthCostUSD: Math.round(m.monthCostUSD * 10000) / 10000,
      };
    })
    .sort((a, b) => b.allTimeCostUSD - a.allTimeCostUSD || b.total - a.total);

  const speedBenchmarks = [];
  for (const bucket of speedBuckets.values()) {
    bucket.rows.sort((a, b) => a.ts - b.ts);
    const windowRows = bucket.rows.slice(-MAX_SPEED_SAMPLES_PER_MODEL);
    if (windowRows.length === 0) continue;

    const streamList = windowRows.map((r) => r.streamingTps);
    const e2eList = windowRows.map((r) => r.e2eTps);
    const ttftList = windowRows.map((r) => r.ttftSec).filter((v) => v !== null && v >= 0);
    const durList = windowRows.map((r) => r.durationSec).filter((v) => v !== null && v > 0);

    const sortedStream = [...streamList].sort((a, b) => a - b);
    const p75Val = sortedStream[Math.min(sortedStream.length - 1, Math.floor(sortedStream.length * 0.75))];

    const medStream = computeMedian(streamList);
    const medE2e = computeMedian(e2eList);
    const medTtft = ttftList.length ? computeMedian(ttftList) : null;
    const medDur = durList.length ? computeMedian(durList) : null;

    speedBenchmarks.push({
      modelKey: bucket.modelKey,
      modelLabel: bucket.modelLabel,
      sampleCount: windowRows.length,
      lowSampleWarning: windowRows.length < 3,
      medianStreamingTps: medStream !== null ? Number(medStream.toFixed(1)) : 0,
      p75StreamingTps: Number((p75Val || medStream || 0).toFixed(1)),
      medianE2eTps: medE2e !== null ? Number(medE2e.toFixed(1)) : 0,
      medianTtftSec: medTtft !== null ? Number(medTtft.toFixed(2)) : null,
      medianDurationSec: medDur !== null ? Number(medDur.toFixed(2)) : null,
      lastUpdatedMs: windowRows[windowRows.length - 1].ts,
      recentSeries: windowRows.slice(-40),
    });
  }
  speedBenchmarks.sort((a, b) => b.medianStreamingTps - a.medianStreamingTps);

  return {
    summary: {
      grandTotalTokens,
      totalInputTokens,
      totalCacheTokens,
      totalOutputTokens,
      totalThinkingTokens,
      todayTokens,
      weekTokens,
      monthTokens,
      yearTokens,
      activeDays,
      firstUseDate: firstUseDate || todayKey,
      companionDays: companionDays || (activeDays > 0 ? 1 : 0),
      mainConversations,
      subagentConversations,
      totalConversations: mainConversations + subagentConversations,
      totalSteps,
      overallCacheHitRate,
      totalCostUSD: Math.round(totalCostUSD * 10000) / 10000,
      monthCostUSD: Math.round(monthCostUSD * 10000) / 10000,
      todayCostUSD: Math.round(todayCostUSD * 10000) / 10000,
    },
    dailyMap,
    monthlyList,
    yearlyList,
    availableYears,
    modelBreakdown,
    speedBenchmarks,
  };
}

/**
 * 基于用户订阅设置计算本月与全量回本 ROI 评估
 */
export function computeRoiSummary(summary, settings) {
  const curCode = settings.currency || 'USD';
  const curMeta = CURRENCY_CONFIG[curCode] || CURRENCY_CONFIG.USD;
  const usdToCny = Number(settings.usdToCny) > 0 ? Number(settings.usdToCny) : DEFAULT_USD_TO_CNY;
  const ratePerUsd = curCode === 'CNY' ? usdToCny : curMeta.ratesPerUsd || 1;

  const monthlyPaidOriginal = Number(settings.monthlyPrice) || 0;
  const monthlyPaidUSD = ratePerUsd > 0 ? monthlyPaidOriginal / ratePerUsd : monthlyPaidOriginal;
  const monthlyPaidCNY = monthlyPaidUSD * usdToCny;

  const monthApiCostUSD = Number(summary?.monthCostUSD || 0);
  const monthApiCostCNY = monthApiCostUSD * usdToCny;
  const allTimeApiCostUSD = Number(summary?.totalCostUSD || 0);
  const allTimeApiCostCNY = allTimeApiCostUSD * usdToCny;

  const roiPercent =
    monthlyPaidUSD > 0 ? Math.round((monthApiCostUSD / monthlyPaidUSD) * 1000) / 10 : null;
  const netSavedUSD = monthApiCostUSD - monthlyPaidUSD;
  const netSavedCNY = monthApiCostCNY - monthlyPaidCNY;

  return {
    presetId: settings.presetId,
    currency: curCode,
    currencySymbol: curMeta.symbol,
    usdToCny,
    monthlyPaidOriginal: Math.round(monthlyPaidOriginal * 100) / 100,
    monthlyPaidUSD: Math.round(monthlyPaidUSD * 100) / 100,
    monthlyPaidCNY: Math.round(monthlyPaidCNY * 100) / 100,
    monthApiCostUSD: Math.round(monthApiCostUSD * 100) / 100,
    monthApiCostCNY: Math.round(monthApiCostCNY * 100) / 100,
    allTimeApiCostUSD: Math.round(allTimeApiCostUSD * 100) / 100,
    allTimeApiCostCNY: Math.round(allTimeApiCostCNY * 100) / 100,
    roiPercent,
    netSavedUSD: Math.round(netSavedUSD * 100) / 100,
    netSavedCNY: Math.round(netSavedCNY * 100) / 100,
    isBreakEven: monthlyPaidUSD === 0 ? monthApiCostUSD > 0 : monthApiCostUSD >= monthlyPaidUSD,
  };
}

async function computeGlobalLedgerInternal({ force = false } = {}) {
  const startedAt = Date.now();
  const settings = getLedgerSettings();

  const rawCache = !force ? safeReadJsonSync(LEDGER_CACHE_FILE, null) : null;
  const diskCache =
    rawCache && rawCache.version === CACHE_SCHEMA_VERSION && rawCache.entries && typeof rawCache.entries === 'object'
      ? rawCache
      : { version: CACHE_SCHEMA_VERSION, entries: {} };

  const desktopJobs = discoverSourceConversations('desktop', BRAIN_DIR, CONVERSATIONS_DIR);
  const cliJobs = discoverSourceConversations('cli', CLI_BRAIN_DIR, CLI_CONVERSATIONS_DIR);
  const allJobs = [...desktopJobs, ...cliJobs];

  const activeKeys = new Set();
  const activeEntries = [];
  let cacheHits = 0;
  let rescanned = 0;

  for (let i = 0; i < allJobs.length; i++) {
    const job = allJobs[i];
    const cacheKey = `${job.source}:${job.convId}`;
    activeKeys.add(cacheKey);

    const cached = !force ? diskCache.entries[cacheKey] : null;
    if (cached && cached.sig === job.sig) {
      cacheHits++;
      activeEntries.push(cached);
      continue;
    }

    const scanned = scanSingleConversation(job);
    if (scanned) {
      diskCache.entries[cacheKey] = scanned;
      activeEntries.push(scanned);
      rescanned++;
      // 每扫描一批未命中历史库即主动让出事件循环，防止阻塞实时轮询接口
      if (rescanned % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  let pruned = 0;
  for (const k of Object.keys(diskCache.entries)) {
    if (!activeKeys.has(k)) {
      delete diskCache.entries[k];
      pruned++;
    }
  }

  if (rescanned > 0 || pruned > 0 || !fs.existsSync(LEDGER_CACHE_FILE)) {
    try {
      safeWriteJsonSync(LEDGER_CACHE_FILE, diskCache);
    } catch {}
  }

  const now = new Date();
  const periodKeys = getLocalTodayAndPeriodKeys(now);
  const viewAll = buildViewAggregation(activeEntries, 'all', periodKeys);
  const viewDesktop = buildViewAggregation(activeEntries, 'desktop', periodKeys);
  const viewCli = buildViewAggregation(activeEntries, 'cli', periodKeys);

  const snapshot = {
    ok: true,
    generatedAt: now.toISOString(),
    todayKey: periodKeys.todayKey,
    currentMonth: periodKeys.monthPrefix,
    currentYear: periodKeys.yearPrefix,
    scanStats: {
      durationMs: Date.now() - startedAt,
      desktopCount: desktopJobs.length,
      cliCount: cliJobs.length,
      cacheHits,
      rescanned,
    },
    settings,
    presets: SUBSCRIPTION_PRESETS,
    currencies: CURRENCY_CONFIG,
    heatmapThemes: HEATMAP_THEMES,
    roiSummary: computeRoiSummary(viewAll.summary, settings),
    views: {
      all: viewAll,
      desktop: viewDesktop,
      cli: viewCli,
    },
  };

  cachedMemorySnapshot = snapshot;
  cachedMemoryTime = Date.now();
  return snapshot;
}

/**
 * 获取全局桌面端 + CLI 增量历史 Token 账本（自带单飞合并与短期内存缓存）
 */
export async function getGlobalLedger({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedMemorySnapshot && now - cachedMemoryTime < MEMORY_TTL_MS) {
    return cachedMemorySnapshot;
  }
  if (!force && inFlightScanPromise) {
    return inFlightScanPromise;
  }

  const task = computeGlobalLedgerInternal({ force });
  inFlightScanPromise = task;
  try {
    return await task;
  } finally {
    if (inFlightScanPromise === task) {
      inFlightScanPromise = null;
    }
  }
}
