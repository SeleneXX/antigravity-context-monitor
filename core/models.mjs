import fs from 'fs';
import path from 'path';
import {
  BRAIN_DIR,
  CLI_SETTINGS_PATH,
  DEFAULT_MODEL,
  DEFAULT_MAX_WINDOW,
  COMPACTION_THRESHOLDS,
  WINDOW_ESCAPE_LADDER,
  PRICING_TABLE,
} from './constants.mjs';

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
  if (m.includes('carbon') || m.includes('argon') || m.includes('pro') || m.includes('gemini 4') || m.includes('gemini-4')) {
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

export function clearModelCache() {
  cachedCliModel = null;
  cachedCliModelTime = 0;
}

/**
 * 探测指定会话当前生效的模型（优先复用已读取的行数组，避免重复磁盘读取）
 */
export function detectConversationModel(convId, preloadedLines = null) {
  let detected = '';
  const scanLines = (lines) => {
    for (const line of lines) {
      if (line.includes('Model Selection')) {
        const m = line.match(MODEL_SELECTION_REGEX);
        if (m && m[1]) {
          detected = m[1].replace(/\.+$/, '').trim();
        }
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

  return detected || getDefaultCliModel();
}

/**
 * 统一格式化 Subagent 的模型层级标签与说明
 */
export function formatSubagentModelInfo(rawModel, parentModelName) {
  const raw = String(rawModel || 'inherit').trim().replace(/^["']+|["']+$/g, '').trim() || 'inherit';
  const mLower = raw.toLowerCase();

  if (mLower === 'inherit') {
    return {
      model: 'Inherit',
      modelKey: 'inherit',
      modelBadge: '🔗 Inherit',
      modelDesc: `继承主会话 · ${parentModelName || DEFAULT_MODEL}`,
      rawModel: raw,
    };
  }
  if (mLower === 'pro' || mLower.includes('carbon') || mLower.includes('argon')) {
    return {
      model: 'Pro',
      modelKey: 'pro',
      modelBadge: '🧠 Pro',
      modelDesc: raw.length > 4 ? raw : '旗舰推理 · Gemini 4 Carbon / Argon',
      rawModel: raw,
    };
  }
  if (mLower === 'flash_lite' || mLower === 'flash-lite') {
    return {
      model: 'Flash Lite',
      modelKey: 'flash_lite',
      modelBadge: '🪶 Flash Lite',
      modelDesc: '超轻量高速模型',
      rawModel: raw,
    };
  }
  if (mLower.includes('claude') || mLower.includes('sonnet') || mLower.includes('opus')) {
    return {
      model: raw,
      modelKey: 'pro',
      modelBadge: `✨ ${raw}`,
      modelDesc: raw,
      rawModel: raw,
    };
  }
  if (mLower.includes('gpt') || mLower.includes('oss')) {
    return {
      model: raw,
      modelKey: 'flash',
      modelBadge: `🤖 ${raw}`,
      modelDesc: raw,
      rawModel: raw,
    };
  }
  return {
    model: 'Flash',
    modelKey: 'flash',
    modelBadge: '⚡ Flash',
    modelDesc: '快速执行 · Gemini 3.8 Flash',
    rawModel: raw,
  };
}
