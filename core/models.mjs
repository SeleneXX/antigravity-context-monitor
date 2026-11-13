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
      m.includes('carbon') ||
      m.includes('argon') ||
      m.includes('hydrogen') ||
      m.includes('orchestrator') ||
      m.includes('flash') ||
      m.includes('gemini') ||
      m.includes('pro')
    ) {
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

export function getModelPricing(modelName) {
  if (!modelName) return PRICING_TABLE['gemini-flash'];
  const m = String(modelName).toLowerCase();
  if (m.includes('flash-lite') || m.includes('flash_lite')) return PRICING_TABLE['gemini-flash-lite'];
  if (m.includes('flash')) return PRICING_TABLE['gemini-flash'];
  if (m.includes('opus')) return PRICING_TABLE['claude-opus'];
  if (m.includes('sonnet') || m.includes('claude')) return PRICING_TABLE['claude-sonnet'];
  if (m.includes('oss') || m.includes('gpt')) return PRICING_TABLE['gpt-oss'];
  if (
    m.includes('carbon') ||
    m.includes('argon') ||
    m.includes('hydrogen') ||
    m.includes('orchestrator') ||
    m.includes('pro') ||
    m.includes('gemini 4') ||
    m.includes('gemini-4')
  ) {
    return PRICING_TABLE['gemini-pro'];
  }
  return PRICING_TABLE['gemini-flash'];
}

export function calcEstimatedCost(inputTokens, cacheTokens, outputTokens, modelName) {
  const p = getModelPricing(modelName);
  const cost = (inputTokens * p.input + cacheTokens * p.cacheRead + outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 10000) / 10000;
}

/**
 * 读取 CLI 全局默认模型作为会话未发生显式模型切换时的初始基线
 */
let cachedCliModel = null;
let cachedCliModelTime = 0;
const dbModelCache = new Map(); // convId -> { sig, info }

export function clearModelCache() {
  cachedCliModel = null;
  cachedCliModelTime = 0;
  dbModelCache.clear();
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

/**
 * 从 gen_metadata protobuf Blob 中提取 root.1.21 (model_display_name)
 */
function parseGenMetadataProtobuf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (field === 1 && wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      const end = Math.min(buf.length, len.next + len.value);
      let subPos = len.next;
      let displayName = '';
      while (subPos < end) {
        const subTag = readVarint(buf, subPos);
        if (!subTag) break;
        subPos = subTag.next;
        const subField = Math.floor(subTag.value / 8);
        const subWire = subTag.value & 7;
        if (subField === 21 && subWire === 2) {
          const strLen = readVarint(buf, subPos);
          if (!strLen) break;
          const strEnd = Math.min(end, strLen.next + strLen.value);
          displayName = buf.toString('utf8', strLen.next, strEnd).trim();
          if (displayName) return { displayName };
          subPos = strEnd;
        } else {
          subPos = skipWireField(buf, subPos, subWire);
        }
      }
      pos = end;
    } else {
      pos = skipWireField(buf, pos, wire);
    }
  }
  return null;
}

/**
 * 只读读取 Antigravity SQLite 会话库中的实际推理模型展示名（支持 WAL 热库并发读，无 node:sqlite 时返回 null）
 */
export function readConversationDbModel(convId) {
  if (!DatabaseSync || !convId) return null;
  const dbPath = path.join(CONVERSATIONS_DIR, `${convId}.db`);
  if (!fs.existsSync(dbPath)) return null;

  let sig = '';
  try {
    const dbStat = fs.statSync(dbPath);
    let walSig = '0:0';
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      const walStat = fs.statSync(walPath);
      walSig = `${walStat.mtimeMs}:${walStat.size}`;
    }
    sig = `${dbStat.mtimeMs}:${dbStat.size}|${walSig}`;
    const cached = dbModelCache.get(convId);
    if (cached && cached.sig === sig) {
      return cached.info;
    }
  } catch {
    return null;
  }

  let db = null;
  let info = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 5').all();
    for (const row of rows) {
      const data = row?.data;
      if (!data) continue;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const parsed = parseGenMetadataProtobuf(buf);
      if (parsed?.displayName) {
        info = parsed;
        break;
      }
    }
  } catch {
    // 忽略表不存在、并发锁冲突或损坏库，确保不影响主链路
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }

  dbModelCache.set(convId, { sig, info });
  return info;
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

