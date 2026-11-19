import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  BRAIN_DIR,
  CONVERSATIONS_DIR,
  CLI_SETTINGS_PATH,
  DEFAULT_MODEL,
  DEFAULT_MAX_WINDOW,
  COMPACTION_THRESHOLDS,
  WINDOW_ESCAPE_LADDER,
  PRICING_TABLE,
  CACHE_HIT_GRADES,
  SWARM_MODEL_DISPLAY_NAMES,
} from './constants.mjs';

let DatabaseSync = null;
try {
  const require = createRequire(import.meta.url);
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // Node < 22.5 无内置 node:sqlite 时自动降级，仅依赖日志元数据解析
}

// 匹配用户在对话中途切换模型时系统注入的 <USER_SETTINGS_CHANGE> 标记
export const MODEL_SELECTION_REGEX =
  /setting [`'"]?Model Selection[`'"]? from .+? to (.+?)(?:\.\s*(?:No need|If reporting)|<\/USER_SETTINGS_CHANGE>|\.\s*$)/i;

/**
 * 轻量估算一段文本对应的 Token 数（ASCII 约 4 字符/tok，中日韩及符号约 1.5 字符/tok）
 */
export function estimateTokensFromText(text) {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

/**
 * 根据模型名称与当前实际活跃 Prompt 计算平台自动压缩安全阈值
 */
export function getModelMaxWindow(modelName, promptTokens = 0) {
  let limit = DEFAULT_MAX_WINDOW;
  if (modelName) {
    const m = String(modelName).toLowerCase();
    if (m.includes('opus') || m.includes('sonnet') || m.includes('claude')) {
      limit = COMPACTION_THRESHOLDS.CLAUDE;
    } else if (m.includes('oss') || m.includes('gpt')) {
      limit = COMPACTION_THRESHOLDS.GPT_OSS;
    } else if (
      m.includes('neon') ||
      m.includes('carbon') ||
      m.includes('argon') ||
      m.includes('hydrogen') ||
      m.includes('orchestrator') ||
      m.includes('gemini 4') ||
      m.includes('gemini-4')
    ) {
      limit = COMPACTION_THRESHOLDS.GEMINI_4;
    } else if (m.includes('flash') || m.includes('gemini') || m.includes('pro')) {
      limit = COMPACTION_THRESHOLDS.GEMINI;
    }
  }

  // 若灰度放量导致实际 Prompt 明显越过标称阈值（>1.08x），自动按阶梯上浮显示上限，避免进度条爆表
  if (promptTokens > limit * 1.08) {
    const nextTier = WINDOW_ESCAPE_LADDER.find((tier) => tier >= promptTokens * 1.02);
    limit = nextTier || WINDOW_ESCAPE_LADDER[WINDOW_ESCAPE_LADDER.length - 1];
  }
  return limit;
}

export function getModelPricingTier(modelName) {
  if (!modelName) return 'gemini-flash';
  const m = String(modelName).toLowerCase();
  // 先判定 Hydrogen / 调度执行 worker，防止名称中的 flash 或 orchestrator 被误归到 3.8 Flash 或 Carbon
  if (m.includes('hydrogen') || m.includes('gemini-flash-worker-agy')) return 'gemini-4-hydrogen';
  if (m.includes('neon') || m.includes('carbon') || m.includes('argon') || m.includes('orchestrator') || m.includes('gemini 4') || m.includes('gemini-4')) {
    return 'gemini-4-carbon';
  }
  if (m.includes('flash-lite') || m.includes('flash_lite') || m.includes('flash lite')) return 'gemini-flash-lite';
  if (m.includes('flash')) return 'gemini-flash';
  if (m.includes('opus')) return /5[._ -]5/.test(m) ? 'claude-opus-5-5' : 'claude-opus';
  if (m.includes('sonnet') || m.includes('claude')) return /5[._ -]5/.test(m) ? 'claude-sonnet-5-5' : 'claude-sonnet';
  if (m.includes('oss') || m.includes('gpt')) return 'gpt-oss';
  if (m.includes('pro')) return 'gemini-pro';
  return 'gemini-flash';
}

function getLocalTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getModelPricing(modelName, dateKey = '') {
  const tier = getModelPricingTier(modelName);
  const base = PRICING_TABLE[tier] || PRICING_TABLE['gemini-flash'];
  if (base.nextEffectiveFrom) {
    const refDate = dateKey && /^\d{4}-\d{2}-\d{2}/.test(dateKey) ? dateKey.slice(0, 10) : getLocalTodayKey();
    if (refDate >= base.nextEffectiveFrom) {
      return {
        ...base,
        input: base.nextInput ?? base.input,
        output: base.nextOutput ?? base.output,
        cacheRead: base.nextCacheRead ?? base.cacheRead,
      };
    }
  }
  return base;
}

export function calcEstimatedCost(inputTokens, cacheTokens, outputTokens, modelName, dateKey = '') {
  const p = getModelPricing(modelName, dateKey);
  const cost = (inputTokens * p.input + cacheTokens * p.cacheRead + outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 10000) / 10000;
}

/**
 * 计算有限数值数组的中位数，用于抗单步异常波动
 */
export function computeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const clean = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

const DISPLAY_NAME_TO_CANONICAL_ID = new Map(
  Object.entries(SWARM_MODEL_DISPLAY_NAMES).map(([k, v]) => [v.toLowerCase(), k])
);

function formatReadableModelId(modelKey) {
  if (!modelKey || modelKey === 'unknown') return 'Unknown Model';
  if (SWARM_MODEL_DISPLAY_NAMES[modelKey]) return SWARM_MODEL_DISPLAY_NAMES[modelKey];
  const parts = String(modelKey).split(/[-_]+/).filter(Boolean);
  const effortSet = new Set(['low', 'medium', 'high', 'xhigh', 'tiered']);
  const tokens = [];
  let effortLabel = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase();
    if (i === parts.length - 1 && effortSet.has(p)) {
      effortLabel = p === 'xhigh' ? 'XHigh' : p.charAt(0).toUpperCase() + p.slice(1);
    } else if (p === 'gpt' || p === 'oss') {
      tokens.push(p.toUpperCase());
    } else if (/^\d+(\.\d+)?$/.test(p)) {
      tokens.push(p);
    } else {
      tokens.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  const base = tokens.join(' ').replace(/\b(\d+)\s+(\d+)\b/g, '$1.$2');
  return effortLabel ? `${base} (${effortLabel})` : base;
}

/**
 * 将内部模型 ID 与展示名归一化为稳定的聚合键，避免跨数据源测速与账单分裂
 */
export function normalizeCanonicalModel(rawModelId = '', rawDisplayName = '') {
  const idClean = String(rawModelId || '').trim();
  const dispClean = String(rawDisplayName || '').trim();
  const idLower = idClean.toLowerCase().replace(/^model_/, '');
  const dispLower = dispClean.toLowerCase();

  let modelKey = '';
  if (idLower && !idLower.startsWith('placeholder')) {
    modelKey = idLower;
  } else if (dispLower && DISPLAY_NAME_TO_CANONICAL_ID.has(dispLower)) {
    modelKey = DISPLAY_NAME_TO_CANONICAL_ID.get(dispLower);
  } else if (dispLower) {
    modelKey = dispLower.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  } else {
    modelKey = 'unknown';
  }

  // 若已知展示名反查到的标准键可用且 idClean 只是展示名格式，优先统一到标准键
  if (!SWARM_MODEL_DISPLAY_NAMES[modelKey] && dispLower && DISPLAY_NAME_TO_CANONICAL_ID.has(dispLower)) {
    modelKey = DISPLAY_NAME_TO_CANONICAL_ID.get(dispLower);
  }

  const displayName =
    dispClean ||
    SWARM_MODEL_DISPLAY_NAMES[modelKey] ||
    SWARM_MODEL_DISPLAY_NAMES[idLower] ||
    formatReadableModelId(modelKey);
  const pricingTier = getModelPricingTier(`${modelKey} ${displayName}`);

  return {
    modelKey,
    displayName,
    pricingTier,
  };
}

/**
 * 读取 CLI 全局默认模型作为会话未发生显式模型切换时的初始基线
 */
let cachedCliModel = null;
let cachedCliModelTime = 0;
const genMetaCache = new Map(); // `${dir}|${convId}` -> { sig, info }
const parentMetaCache = new Map(); // `${dir}|${convId}` -> { sig, info }
const workflowStepsCache = new Map(); // `${dir}|${convId}` -> { sig, agents }
const MAX_GEN_META_CACHE = 80;
const MAX_PARENT_META_CACHE = 400;
const UUID_EXACT_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function clearModelCache() {
  cachedCliModel = null;
  cachedCliModelTime = 0;
  genMetaCache.clear();
  parentMetaCache.clear();
  workflowStepsCache.clear();
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, next: pos };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function skipWireField(buf, offset, wire) {
  if (wire === 0) {
    const v = readVarint(buf, offset);
    return v ? v.next : buf.length;
  }
  if (wire === 1) return Math.min(buf.length, offset + 8);
  if (wire === 2) {
    const len = readVarint(buf, offset);
    if (!len) return buf.length;
    return Math.min(buf.length, len.next + len.value);
  }
  if (wire === 5) return Math.min(buf.length, offset + 4);
  return buf.length;
}

function parseProtobufDuration(buf, start, end) {
  let pos = start;
  let seconds = 0;
  let nanos = 0;
  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (field === 1 && wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      seconds = v.value;
      pos = v.next;
    } else if (field === 2 && wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      nanos = v.value;
      pos = v.next;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }
  const totalSec = seconds + nanos / 1e9;
  return Number.isFinite(totalSec) && totalSec >= 0 ? totalSec : null;
}

function parseUsageSubmessage(buf, start, end) {
  let pos = start;
  let inputTokens = null;
  let outputTokens = null;
  let cacheReadTokens = null;
  let thinkingOutputTokens = null;
  let responseOutputTokens = null;
  let callId = '';

  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (wire === 0 && (field === 2 || field === 3 || field === 5 || field === 9 || field === 10)) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v.next;
      if (field === 2) inputTokens = v.value;
      else if (field === 3) outputTokens = v.value;
      else if (field === 5) cacheReadTokens = v.value;
      else if (field === 9) thinkingOutputTokens = v.value;
      else if (field === 10) responseOutputTokens = v.value;
    } else if (field === 11 && wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const strEnd = Math.min(end, len.next + len.value);
      callId = buf.toString('utf8', len.next, strEnd).trim();
      pos = strEnd;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingOutputTokens,
    responseOutputTokens,
    callId,
  };
}

function parseChatStartMetadata(buf, start, end) {
  let pos = start;
  let estimatedTokensUsed = null;
  let maxContextTokens = null;

  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (field === 10 && wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const subEnd = Math.min(end, len.next + len.value);
      let subPos = len.next;
      while (subPos < subEnd) {
        const subTag = readVarint(buf, subPos);
        if (!subTag) break;
        subPos = subTag.next;
        const subField = Math.floor(subTag.value / 8);
        const subWire = subTag.value & 7;
        if (subWire === 0 && (subField === 1 || subField === 4)) {
          const v = readVarint(buf, subPos);
          if (!v) break;
          subPos = v.next;
          if (subField === 1) estimatedTokensUsed = v.value;
          else if (subField === 4) maxContextTokens = v.value;
        } else {
          subPos = skipWireField(buf, subPos, subWire);
        }
      }
      pos = subEnd;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }

  return { estimatedTokensUsed, maxContextTokens };
}

/**
 * 解码 gen_metadata 单行 protobuf（零拷贝跳过大字段，提取步号、模型、精确 Token 拆分与 TTFT/流式耗时）
 */
export function parseGenMetadataRow(buf, rowIdx = 0) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;

  let pos = 0;
  const stepIndices = [];
  let modelId = '';
  let displayName = '';
  let usage = null;
  let ctxMeta = null;
  let ttftSec = null;
  let streamingSec = null;

  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (field === 2 && wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const end = Math.min(buf.length, len.next + len.value);
      let p = len.next;
      while (p < end) {
        const v = readVarint(buf, p);
        if (!v) break;
        stepIndices.push(v.value);
        p = v.next;
      }
      pos = end;
    } else if (field === 2 && wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      stepIndices.push(v.value);
      pos = v.next;
    } else if (field === 1 && wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const end = Math.min(buf.length, len.next + len.value);
      let subPos = len.next;
      while (subPos < end) {
        const subTag = readVarint(buf, subPos);
        if (!subTag) break;
        subPos = subTag.next;
        const subField = Math.floor(subTag.value / 8);
        const subWire = subTag.value & 7;
        if (subWire === 2 && (subField === 4 || subField === 9 || subField === 11 || subField === 12 || subField === 19 || subField === 21)) {
          const sLen = readVarint(buf, subPos);
          if (!sLen) break;
          const sEnd = Math.min(end, sLen.next + sLen.value);
          if (subField === 4) {
            usage = parseUsageSubmessage(buf, sLen.next, sEnd);
          } else if (subField === 9) {
            ctxMeta = parseChatStartMetadata(buf, sLen.next, sEnd);
          } else if (subField === 11) {
            ttftSec = parseProtobufDuration(buf, sLen.next, sEnd);
          } else if (subField === 12) {
            streamingSec = parseProtobufDuration(buf, sLen.next, sEnd);
          } else if (subField === 19) {
            modelId = buf.toString('utf8', sLen.next, sEnd).trim();
          } else if (subField === 21) {
            displayName = buf.toString('utf8', sLen.next, sEnd).trim();
          }
          subPos = sEnd;
        } else {
          subPos = skipWireField(buf, subPos, subWire);
        }
      }
      pos = end;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }

  let durationSec = null;
  if (ttftSec !== null && streamingSec !== null) {
    durationSec = ttftSec + streamingSec;
  } else if (ttftSec !== null || streamingSec !== null) {
    durationSec = ttftSec ?? streamingSec;
  }

  let thinkingTokens = usage?.thinkingOutputTokens ?? null;
  let responseTokens = usage?.responseOutputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  if (outputTokens !== null && outputTokens >= 0) {
    if (thinkingTokens === null && responseTokens !== null) {
      thinkingTokens = Math.max(0, outputTokens - responseTokens);
    } else if (responseTokens === null && thinkingTokens !== null) {
      responseTokens = Math.max(0, outputTokens - thinkingTokens);
    }
  }

  const canonical = normalizeCanonicalModel(modelId, displayName);

  return {
    rowIdx,
    stepIndices,
    modelId,
    displayName: displayName || canonical.displayName,
    modelKey: canonical.modelKey,
    pricingTier: canonical.pricingTier,
    callId: usage?.callId || '',
    inputTokens: usage?.inputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    outputTokens,
    thinkingTokens,
    responseTokens,
    estimatedTokensUsed: ctxMeta?.estimatedTokensUsed ?? null,
    maxContextTokens: ctxMeta?.maxContextTokens ?? null,
    ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(3)) : null,
    streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(3)) : null,
    durationSec: durationSec !== null ? Number(durationSec.toFixed(3)) : null,
  };
}

/**
 * 构建 SQLite 数据库文件（含 WAL）变更签名，供单会话与增量账本共用
 */
export function getConversationDbSignature(convId, conversationsDir = CONVERSATIONS_DIR) {
  if (!convId || !conversationsDir) return '';
  const dbPath = path.join(conversationsDir, `${convId}.db`);
  if (!fs.existsSync(dbPath)) return '';
  try {
    const dbStat = fs.statSync(dbPath);
    let walSig = '0:0';
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      const walStat = fs.statSync(walPath);
      walSig = `${walStat.mtimeMs}:${walStat.size}`;
    }
    return `${dbStat.mtimeMs}:${dbStat.size}|${walSig}`;
  } catch {
    return '';
  }
}

/**
 * 只读读取会话 SQLite gen_metadata 全量步级遥测数据（含 WAL 热库并发读，无 node:sqlite 时安全降级为 null）
 */
export function readConversationGenMetadata(
  convId,
  { conversationsDir = CONVERSATIONS_DIR, useCache = true } = {}
) {
  if (!DatabaseSync || !convId || !conversationsDir) return null;
  const dbPath = path.join(conversationsDir, `${convId}.db`);
  const sig = getConversationDbSignature(convId, conversationsDir);
  if (!sig) return null;

  const cacheKey = `${conversationsDir}|${convId}`;
  if (useCache) {
    const cached = genMetaCache.get(cacheKey);
    if (cached && cached.sig === sig) {
      return cached.info;
    }
  }

  let db = null;
  let info = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const records = [];
    const byStepIndex = new Map();
    let latestDisplayName = '';
    let latestModelId = '';
    let latestMaxContextTokens = null;

    for (const row of rows) {
      const data = row?.data;
      if (!data) continue;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const parsed = parseGenMetadataRow(buf, row.idx);
      if (!parsed) continue;
      records.push(parsed);
      for (const sIdx of parsed.stepIndices) {
        // 按 idx 升序扫描，后续重试生成的元数据自动覆盖同 step 旧记录
        byStepIndex.set(sIdx, parsed);
      }
      if (parsed.displayName && parsed.displayName !== 'Unknown Model') {
        latestDisplayName = parsed.displayName;
      }
      if (parsed.modelId) {
        latestModelId = parsed.modelId;
      }
      if (parsed.maxContextTokens && parsed.maxContextTokens > 0) {
        latestMaxContextTokens = parsed.maxContextTokens;
      }
    }

    info = {
      sig,
      records,
      byStepIndex,
      latestDisplayName,
      latestModelId,
      latestMaxContextTokens,
    };
  } catch {
    // 忽略表不存在、并发锁冲突或损坏库，确保不影响主链路
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }

  if (useCache) {
    if (genMetaCache.size >= MAX_GEN_META_CACHE) {
      const oldestKey = genMetaCache.keys().next().value;
      genMetaCache.delete(oldestKey);
    }
    genMetaCache.set(cacheKey, { sig, info });
  }
  return info;
}

/**
 * 只读读取 Antigravity SQLite 会话库中的实际推理模型展示名
 */
export function readConversationDbModel(convId, options = {}) {
  const meta = readConversationGenMetadata(convId, options);
  if (!meta || !meta.latestDisplayName) return null;
  return {
    displayName: meta.latestDisplayName,
    modelId: meta.latestModelId || '',
  };
}

function parseProtobufTimestampMs(buf, start, end) {
  let pos = start;
  let seconds = 0;
  let nanos = 0;
  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (wire === 0 && (field === 1 || field === 2)) {
      const v = readVarint(buf, pos);
      if (!v) break;
      if (field === 1) seconds = v.value;
      else nanos = v.value;
      pos = v.next;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }
  return seconds > 0 ? Math.floor(seconds * 1000 + nanos / 1e6) : 0;
}

/**
 * 零拷贝解码 trajectory_metadata_blob 中的父会话与 Workflow 调用归属信息
 */
function parseTrajectoryParentMetaBlob(buf, convId = '') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  let pos = 0;
  let parentCascadeId = '';
  let rootCascadeId = '';
  let wfParentId = '';
  let wfStepIndex = 0;
  let wfToolName = '';
  let wfAgentLabel = '';

  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (wire === 2 && (field === 5 || field === 6 || field === 12)) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const end = Math.min(buf.length, len.next + len.value);
      if (field === 5) {
        parentCascadeId = buf.toString('utf8', len.next, end).trim();
      } else if (field === 6) {
        rootCascadeId = buf.toString('utf8', len.next, end).trim();
      } else if (field === 12) {
        let p2 = len.next;
        while (p2 < end) {
          const t2 = readVarint(buf, p2);
          if (!t2) break;
          p2 = t2.next;
          const f2 = Math.floor(t2.value / 8);
          const w2 = t2.value & 7;
          if (f2 === 1 && w2 === 2) {
            const l2 = readVarint(buf, p2);
            if (!l2) break;
            const e2 = Math.min(end, l2.next + l2.value);
            let p3 = l2.next;
            while (p3 < e2) {
              const t3 = readVarint(buf, p3);
              if (!t3) break;
              p3 = t3.next;
              const f3 = Math.floor(t3.value / 8);
              const w3 = t3.value & 7;
              if (f3 === 2 && w3 === 0) {
                const v3 = readVarint(buf, p3);
                if (!v3) break;
                wfStepIndex = v3.value;
                p3 = v3.next;
              } else if (w3 === 2 && (f3 === 1 || f3 === 3 || f3 === 4)) {
                const l3 = readVarint(buf, p3);
                if (!l3) break;
                const e3 = Math.min(e2, l3.next + l3.value);
                if (f3 === 1) {
                  wfParentId = buf.toString('utf8', l3.next, e3).trim();
                } else if (f3 === 4) {
                  wfAgentLabel = buf.toString('utf8', l3.next, e3).trim();
                } else if (f3 === 3) {
                  let p4 = l3.next;
                  while (p4 < e3) {
                    const t4 = readVarint(buf, p4);
                    if (!t4) break;
                    p4 = t4.next;
                    const f4 = Math.floor(t4.value / 8);
                    const w4 = t4.value & 7;
                    if (f4 === 2 && w4 === 2) {
                      const l4 = readVarint(buf, p4);
                      if (!l4) break;
                      const e4 = Math.min(e3, l4.next + l4.value);
                      wfToolName = buf.toString('utf8', l4.next, e4).trim();
                      p4 = e4;
                    } else {
                      p4 = skipWireField(buf, p4, w4);
                    }
                  }
                }
                p3 = e3;
              } else {
                p3 = skipWireField(buf, p3, w3);
              }
            }
            p2 = e2;
          } else {
            p2 = skipWireField(buf, p2, w2);
          }
        }
      }
      pos = end;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }

  const effectiveParentId = parentCascadeId || wfParentId || '';
  const selfLower = String(convId || '').toLowerCase();
  const isChild = Boolean(
    (effectiveParentId && effectiveParentId.toLowerCase() !== selfLower) ||
    (rootCascadeId && rootCascadeId.toLowerCase() !== selfLower)
  );

  return {
    parentId: effectiveParentId,
    rootId: rootCascadeId,
    spawnStepIndex: wfStepIndex,
    parentToolName: wfToolName,
    agentLabel: wfAgentLabel,
    isChild,
    isWorkflowChild: wfToolName === 'run_workflow',
  };
}

/**
 * 只读读取会话 SQLite trajectory_metadata_blob，用于精准识别 Workflow / Subagent 归属关系
 */
export function readConversationParentMeta(
  convId,
  { conversationsDir = CONVERSATIONS_DIR, useCache = true } = {}
) {
  if (!DatabaseSync || !convId || !conversationsDir) return null;
  const dbPath = path.join(conversationsDir, `${convId}.db`);
  const sig = getConversationDbSignature(convId, conversationsDir);
  if (!sig) return null;

  const cacheKey = `${conversationsDir}|${convId}`;
  if (useCache) {
    const cached = parentMetaCache.get(cacheKey);
    if (cached && cached.sig === sig) {
      return cached.info;
    }
  }

  let db = null;
  let info = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
    if (row?.data) {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      info = parseTrajectoryParentMetaBlob(buf, convId);
    }
  } catch {
    // 忽略旧版本缺失表或并发锁冲突
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }

  if (useCache) {
    if (parentMetaCache.size >= MAX_PARENT_META_CACHE) {
      const oldestKey = parentMetaCache.keys().next().value;
      parentMetaCache.delete(oldestKey);
    }
    parentMetaCache.set(cacheKey, { sig, info });
  }
  return info;
}

/**
 * 递归遍历 run_workflow 步骤渲染树（f140.f2.f3），提取所有已派发的子代理节点
 */
function collectWorkflowAgentsFromRenderNode(buf, start, end, out, seenIds, depth = 0) {
  if (depth > 8 || start >= end) return;
  let pos = start;
  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (wire === 2 && field === 10) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const subEnd = Math.min(end, len.next + len.value);
      // 检查当前 f10 子项是直接的 Agent 节点（f4）还是嵌套分组容器（f5 -> f1）
      let p = len.next;
      while (p < subEnd) {
        const t2 = readVarint(buf, p);
        if (!t2) break;
        p = t2.next;
        const f2 = Math.floor(t2.value / 8);
        const w2 = t2.value & 7;
        if (w2 === 2 && f2 === 4) {
          const l4 = readVarint(buf, p);
          if (!l4) break;
          const e4 = Math.min(subEnd, l4.next + l4.value);
          let agId = '';
          let agRole = '';
          let agType = '';
          let p4 = l4.next;
          while (p4 < e4) {
            const t4 = readVarint(buf, p4);
            if (!t4) break;
            p4 = t4.next;
            const f4 = Math.floor(t4.value / 8);
            const w4 = t4.value & 7;
            if (w4 === 2 && (f4 === 1 || f4 === 2 || f4 === 3)) {
              const sLen = readVarint(buf, p4);
              if (!sLen) break;
              const sEnd = Math.min(e4, sLen.next + sLen.value);
              const sVal = buf.toString('utf8', sLen.next, sEnd).trim();
              if (f4 === 1) agId = sVal;
              else if (f4 === 2) agRole = sVal;
              else if (f4 === 3) agType = sVal;
              p4 = sEnd;
            } else {
              p4 = skipWireField(buf, p4, w4);
            }
          }
          if (agId && UUID_EXACT_REGEX.test(agId) && !seenIds.has(agId)) {
            seenIds.add(agId);
            out.push({
              id: agId,
              role: agRole || 'Workflow Agent',
              typeName: agType || 'research',
            });
          }
          p = e4;
        } else if (w2 === 2 && f2 === 5) {
          const l5 = readVarint(buf, p);
          if (!l5) break;
          const e5 = Math.min(subEnd, l5.next + l5.value);
          let p5 = l5.next;
          while (p5 < e5) {
            const t5 = readVarint(buf, p5);
            if (!t5) break;
            p5 = t5.next;
            const f5 = Math.floor(t5.value / 8);
            const w5 = t5.value & 7;
            if (w5 === 2 && f5 === 1) {
              const l1 = readVarint(buf, p5);
              if (!l1) break;
              const e1 = Math.min(e5, l1.next + l1.value);
              collectWorkflowAgentsFromRenderNode(buf, l1.next, e1, out, seenIds, depth + 1);
              p5 = e1;
            } else {
              p5 = skipWireField(buf, p5, w5);
            }
          }
          p = e5;
        } else {
          p = skipWireField(buf, p, w2);
        }
      }
      pos = subEnd;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }
}

/**
 * 解析单条 run_workflow 工具步骤（step_type=132）的 step_payload，返回派发的子代理列表
 */
function parseWorkflowStepPayload(buf, stepIdx = 0, stepStatus = 0) {
  if (!Buffer.isBuffer(buf) || !buf.includes('run_workflow')) return [];

  let pos = 0;
  let toolName = '';
  let spawnTimeMs = 0;
  let description = '';
  let renderTreeRange = null;

  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (wire === 2 && field === 5) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const end = Math.min(buf.length, len.next + len.value);
      let p = len.next;
      while (p < end) {
        const t2 = readVarint(buf, p);
        if (!t2) break;
        p = t2.next;
        const f2 = Math.floor(t2.value / 8);
        const w2 = t2.value & 7;
        if (w2 === 2 && f2 === 1) {
          const l1 = readVarint(buf, p);
          if (!l1) break;
          const e1 = Math.min(end, l1.next + l1.value);
          spawnTimeMs = parseProtobufTimestampMs(buf, l1.next, e1);
          p = e1;
        } else if (w2 === 2 && f2 === 4) {
          const l4 = readVarint(buf, p);
          if (!l4) break;
          const e4 = Math.min(end, l4.next + l4.value);
          let p4 = l4.next;
          while (p4 < e4) {
            const t4 = readVarint(buf, p4);
            if (!t4) break;
            p4 = t4.next;
            const f4 = Math.floor(t4.value / 8);
            const w4 = t4.value & 7;
            if (w4 === 2 && f4 === 2) {
              const sLen = readVarint(buf, p4);
              if (!sLen) break;
              const sEnd = Math.min(e4, sLen.next + sLen.value);
              toolName = buf.toString('utf8', sLen.next, sEnd).trim();
              p4 = sEnd;
            } else {
              p4 = skipWireField(buf, p4, w4);
            }
          }
          p = e4;
        } else {
          p = skipWireField(buf, p, w2);
        }
      }
      pos = end;
    } else if (wire === 2 && field === 140) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const end = Math.min(buf.length, len.next + len.value);
      let p = len.next;
      while (p < end) {
        const t2 = readVarint(buf, p);
        if (!t2) break;
        p = t2.next;
        const f2 = Math.floor(t2.value / 8);
        const w2 = t2.value & 7;
        if (w2 === 2 && f2 === 1) {
          const l1 = readVarint(buf, p);
          if (!l1) break;
          const e1 = Math.min(end, l1.next + l1.value);
          let kvKey = '';
          let kvVal = '';
          let pk = l1.next;
          while (pk < e1) {
            const tk = readVarint(buf, pk);
            if (!tk) break;
            pk = tk.next;
            const fk = Math.floor(tk.value / 8);
            const wk = tk.value & 7;
            if (wk === 2 && (fk === 1 || fk === 2)) {
              const sl = readVarint(buf, pk);
              if (!sl) break;
              const se = Math.min(e1, sl.next + sl.value);
              const sv = buf.toString('utf8', sl.next, se);
              if (fk === 1) kvKey = sv;
              else kvVal = sv;
              pk = se;
            } else {
              pk = skipWireField(buf, pk, wk);
            }
          }
          if (kvKey === 'Description' && kvVal) description = kvVal.trim();
          p = e1;
        } else if (w2 === 2 && f2 === 2) {
          const l2 = readVarint(buf, p);
          if (!l2) break;
          const e2 = Math.min(end, l2.next + l2.value);
          let p2 = l2.next;
          while (p2 < e2) {
            const t3 = readVarint(buf, p2);
            if (!t3) break;
            p2 = t3.next;
            const f3 = Math.floor(t3.value / 8);
            const w3 = t3.value & 7;
            if (w3 === 2 && f3 === 3) {
              const l3 = readVarint(buf, p2);
              if (!l3) break;
              const e3 = Math.min(e2, l3.next + l3.value);
              renderTreeRange = { start: l3.next, end: e3 };
              p2 = e3;
            } else {
              p2 = skipWireField(buf, p2, w3);
            }
          }
          p = e2;
        } else {
          p = skipWireField(buf, p, w2);
        }
      }
      pos = end;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }

  // 严格校验工具名为 run_workflow，避免 read_file 读到含 run_workflow 字样的文档产生误报
  if (toolName !== 'run_workflow' || !renderTreeRange) return [];

  const agents = [];
  const seenIds = new Set();
  collectWorkflowAgentsFromRenderNode(buf, renderTreeRange.start, renderTreeRange.end, agents, seenIds, 0);
  return agents.map((ag) => ({
    ...ag,
    spawnStepIndex: stepIdx,
    spawnTimeMs,
    workflowStepStatus: stepStatus,
    workflowDescription: description,
  }));
}

/**
 * 从父会话 SQLite steps 表实时读取全部 run_workflow 派发的子代理（支持运行中实时可见）
 */
export function readWorkflowSubagentsFromDb(
  mainConvId,
  { conversationsDir = CONVERSATIONS_DIR, useCache = true } = {}
) {
  if (!DatabaseSync || !mainConvId || !conversationsDir) return [];
  const dbPath = path.join(conversationsDir, `${mainConvId}.db`);
  const sig = getConversationDbSignature(mainConvId, conversationsDir);
  if (!sig) return [];

  const cacheKey = `${conversationsDir}|${mainConvId}`;
  if (useCache) {
    const cached = workflowStepsCache.get(cacheKey);
    if (cached && cached.sig === sig) {
      return cached.agents;
    }
  }

  let db = null;
  const agents = [];
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT idx, status, step_payload FROM steps WHERE step_type = 132 ORDER BY idx ASC')
      .all();
    for (const row of rows) {
      if (!row?.step_payload) continue;
      const buf = Buffer.isBuffer(row.step_payload) ? row.step_payload : Buffer.from(row.step_payload);
      const parsed = parseWorkflowStepPayload(buf, row.idx || 0, row.status || 0);
      for (const ag of parsed) {
        agents.push(ag);
      }
    }
  } catch {
    // 忽略并发锁或结构差异，交由日志兜底链路处理
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }

  if (useCache) {
    if (workflowStepsCache.size >= MAX_GEN_META_CACHE) {
      const oldestKey = workflowStepsCache.keys().next().value;
      workflowStepsCache.delete(oldestKey);
    }
    workflowStepsCache.set(cacheKey, { sig, agents });
  }
  return agents;
}

export function getDefaultCliModel(force = false) {
  const now = Date.now();
  if (!force && cachedCliModel && now - cachedCliModelTime < 10_000) {
    return cachedCliModel;
  }
  let fallback = DEFAULT_MODEL;
  if (fs.existsSync(CLI_SETTINGS_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(CLI_SETTINGS_PATH, 'utf8'));
      if (s && s.model) fallback = s.model;
    } catch {}
  }
  cachedCliModel = fallback;
  cachedCliModelTime = now;
  return fallback;
}

/**
 * 探测指定会话当前生效的模型（优先复用已读取的行数组，避免重复磁盘读取）
 */
export function detectConversationModel(convId, preloadedLines = null) {
  let detected = '';
  const scanLines = (lines) => {
    for (const line of lines) {
      if (line.includes('USER_SETTINGS_CHANGE') && line.includes('Model Selection')) {
        try {
          const item = JSON.parse(line);
          if (item.type !== 'USER_INPUT' && item.type !== 'SYSTEM_MESSAGE') continue;
          const m = String(item.content || '').match(MODEL_SELECTION_REGEX);
          if (m && m[1]) {
            detected = m[1].replace(/\.+$/, '').trim();
          }
        } catch {}
      }
    }
  };

  if (Array.isArray(preloadedLines)) {
    scanLines(preloadedLines);
  } else if (convId) {
    const logPath = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(logPath)) {
      try {
        scanLines(fs.readFileSync(logPath, 'utf8').split('\n'));
      } catch {}
    }
  }

  if (detected) return detected;
  const dbModel = readConversationDbModel(convId);
  return dbModel?.displayName || getDefaultCliModel();
}

function extractEffortLabel(text) {
  if (!text) return '';
  const m = String(text).match(/(?:\(|\b|-)(xhigh|high|medium|low)(?:\)|$)/i);
  if (!m) return '';
  const norm = m[1].toLowerCase();
  if (norm === 'xhigh') return 'XHigh';
  return norm.charAt(0).toUpperCase() + norm.slice(1);
}

/**
 * 统一格式化 Subagent / Swarm Worker 的模型层级标签与说明
 * @param {string} rawModel 日志或成员配置中记录的原始模型标识（tier 或具体 model id）
 * @param {string} parentModelName 父会话模型名
 * @param {string} resolvedDisplayName 从 SQLite gen_metadata 解析出的实际推理模型展示名
 */
export function formatSubagentModelInfo(rawModel, parentModelName, resolvedDisplayName = '') {
  const raw = String(rawModel || 'inherit').trim().replace(/^["']+|["']+$/g, '').trim() || 'inherit';
  const mLower = raw.toLowerCase();
  const resolved = String(resolvedDisplayName || '').trim();
  const mappedRaw = SWARM_MODEL_DISPLAY_NAMES[mLower] || '';
  const displayTarget = resolved || mappedRaw || raw;
  const targetLower = displayTarget.toLowerCase();

  // 1) invoke_subagent 传入的抽象 Tier：保留 Tier 徽章，并在 modelDesc 透出实际解析模型
  if (mLower === 'inherit') {
    const effectiveDesc = resolved || parentModelName || DEFAULT_MODEL;
    return {
      model: 'Inherit',
      modelKey: 'inherit',
      modelBadge: '🔗 Inherit',
      modelDesc: `继承主会话 · ${effectiveDesc}`,
      rawModel: raw,
    };
  }
  if (mLower === 'flash_lite' || mLower === 'flash-lite') {
    return {
      model: 'Flash Lite',
      modelKey: 'flash_lite',
      modelBadge: '🪶 Flash Lite',
      modelDesc: resolved || '超轻量高速模型 · Gemini 3.5 Flash Lite',
      rawModel: raw,
    };
  }
  if (mLower === 'flash') {
    return {
      model: 'Flash',
      modelKey: 'flash',
      modelBadge: '⚡ Flash',
      modelDesc: resolved || '快速执行 · Gemini Flash / 3.8 Flash',
      rawModel: raw,
    };
  }
  if (mLower === 'pro') {
    return {
      model: 'Pro',
      modelKey: 'pro',
      modelBadge: '🧠 Pro',
      modelDesc: resolved || '高阶推理 · Gemini 4 Pro Tier',
      rawModel: raw,
    };
  }

  // 2) 具体模型 ID / 展示名（常见于 Swarm Worker 或 DB 实测模型）
  if (targetLower.includes('orchestrator')) {
    const subVariant = targetLower.includes('argon') ? 'Argon' : targetLower.includes('carbon') ? 'Carbon' : '';
    return {
      model: subVariant ? `Orchestrator (${subVariant})` : 'Orchestrator',
      modelKey: 'orchestrator',
      modelBadge: subVariant ? `🎼 Orchestrator (${subVariant})` : '🎼 Orchestrator',
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('hydrogen')) {
    const eff = extractEffortLabel(displayTarget);
    return {
      model: eff ? `Hydrogen (${eff})` : 'Hydrogen',
      modelKey: 'hydrogen',
      modelBadge: eff ? `⚛️ Hydrogen · ${eff}` : '⚛️ Hydrogen',
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('neon')) {
    const eff = extractEffortLabel(displayTarget);
    return {
      model: eff ? `Neon (${eff})` : 'Neon',
      modelKey: 'neon',
      modelBadge: eff ? `🌟 Neon · ${eff}` : '🌟 Neon',
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('carbon')) {
    const eff = extractEffortLabel(displayTarget);
    return {
      model: eff ? `Carbon (${eff})` : 'Carbon',
      modelKey: 'carbon',
      modelBadge: eff ? `💎 Carbon · ${eff}` : '💎 Carbon',
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('argon')) {
    const eff = extractEffortLabel(displayTarget);
    return {
      model: eff ? `Argon (${eff})` : 'Argon',
      modelKey: 'argon',
      modelBadge: eff ? `🔷 Argon · ${eff}` : '🔷 Argon',
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('flash-lite') || targetLower.includes('flash lite') || targetLower.includes('flash_lite')) {
    return {
      model: 'Flash Lite',
      modelKey: 'flash_lite',
      modelBadge: '🪶 Flash Lite',
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('flash')) {
    const eff = extractEffortLabel(displayTarget);
    const shortName = targetLower.includes('3.8') ? '3.8 Flash' : 'Gemini Flash';
    return {
      model: eff ? `${shortName} (${eff})` : shortName,
      modelKey: 'flash',
      modelBadge: eff ? `⚡ ${shortName} · ${eff}` : `⚡ ${shortName}`,
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('claude') || targetLower.includes('sonnet') || targetLower.includes('opus')) {
    return {
      model: displayTarget,
      modelKey: 'claude',
      modelBadge: `✨ ${displayTarget}`,
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  if (targetLower.includes('gpt') || targetLower.includes('oss')) {
    return {
      model: displayTarget,
      modelKey: 'gpt',
      modelBadge: `🤖 ${displayTarget}`,
      modelDesc: displayTarget,
      rawModel: raw,
    };
  }
  return {
    model: displayTarget,
    modelKey: 'flash',
    modelBadge: `🔹 ${displayTarget}`,
    modelDesc: displayTarget,
    rawModel: raw,
  };
}

/**
 * 对单步或累计 Cache 命中率执行统一六档分级
 * @param {number} hitRatePercent 命中率百分比 (0 ~ 100)
 * @param {number|null} cacheTokens 实际命中的缓存 Token 数（用于精准区分 0 命中与极小比例非零命中）
 */
export function classifyCacheHit(hitRatePercent, cacheTokens = null) {
  const rate = Number(hitRatePercent) || 0;
  const isZeroCache = cacheTokens !== null ? cacheTokens <= 0 : rate <= 0;

  if (isZeroCache || rate <= 0) return CACHE_HIT_GRADES.MISS;
  if (rate < 40) return CACHE_HIT_GRADES.CRITICAL;
  if (rate < 60) return CACHE_HIT_GRADES.LOW;
  if (rate < 80) return CACHE_HIT_GRADES.MODERATE;
  if (rate < 95) return CACHE_HIT_GRADES.GOOD;
  return CACHE_HIT_GRADES.OPTIMAL;
}

