import path from 'path';
import os from 'os';

// Antigravity 数据根目录与会话日志目录
export const APP_DATA_DIR =
  process.env.ANTIGRAVITY_APP_DATA_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.gemini', 'antigravity');

export const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');
export const SCRATCH_DIR = path.join(APP_DATA_DIR, 'scratch');
export const CONVERSATIONS_DIR = path.join(APP_DATA_DIR, 'conversations');
export const CLI_SETTINGS_PATH = path.join(APP_DATA_DIR, '..', 'antigravity-cli', 'settings.json');

// Swarm / 内部模型 ID 到展示名的兜底映射（当 conversations/*.db 不可读时使用）
export const SWARM_MODEL_DISPLAY_NAMES = {
  'gemini-4-carbon-low': 'Gemini 4 Carbon (Low)',
  'gemini-4-carbon-medium': 'Gemini 4 Carbon (Medium)',
  'gemini-4-carbon-high': 'Gemini 4 Carbon (High)',
  'gemini-4-argon-low': 'Gemini 4 Argon (Low)',
  'gemini-4-argon-medium': 'Gemini 4 Argon (Medium)',
  'gemini-4-argon-high': 'Gemini 4 Argon (High)',
  'gemini-4-hydrogen-low': 'Gemini 4 Hydrogen (Low)',
  'gemini-4-hydrogen-medium': 'Gemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-high': 'Gemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh': 'Gemini 4 Hydrogen (XHigh)',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-flash-worker-agy': 'Gemini Flash',
  'gemini-pro-orchestrator': 'Orchestrator (Carbon)',
  'gemini-pro-orchestrator-argon': 'Orchestrator (Argon)',
  'claude-opus-5-5-low': 'Claude Opus 5.5 (Low)',
  'claude-opus-5-5-medium': 'Claude Opus 5.5 (Medium)',
  'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
  'claude-sonnet-5-5-low': 'Claude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium': 'Claude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high': 'Claude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
};

export const DEFAULT_MODEL = 'Gemini 3.8 Flash';
export const DEFAULT_MAX_WINDOW = 256000;

// 平台自动压缩安全阈值（非物理极限窗口，而是触发自动摘要截断的实际水位线）
export const COMPACTION_THRESHOLDS = {
  CLAUDE: 512000,   // Claude Opus / Sonnet 系列保持 512k 压缩水位
  GEMINI: 256000,   // Gemini Carbon / Argon / Flash 系列统一按 256k 触发压缩
  GPT_OSS: 128000,  // 开源或第三方小窗口模型
};

// 当灰度实验或特殊路由使实际 Prompt 突破默认压缩阈值时的阶梯扩容档位
export const WINDOW_ESCAPE_LADDER = [256000, 512000, 1000000, 2000000];

// 各模型百万 Token 估算单价（USD / 1M tokens），用于会话成本参考
export const PRICING_TABLE = {
  'gemini-flash-lite': { input: 0.35, output: 1.75, cacheRead: 0.035 },
  'gemini-flash':      { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-pro':        { input: 2.00, output: 10.0, cacheRead: 0.200 },
  'claude-sonnet':     { input: 3.00, output: 15.0, cacheRead: 0.300 },
  'claude-opus':       { input: 15.0, output: 75.0, cacheRead: 1.500 },
  'gpt-oss':           { input: 0.09, output: 0.36, cacheRead: 0.000 },
};

// Antigravity 系统固定注入上下文开销估算（对齐 CLI /context 分类口径）
export const SYSTEM_BASE_TOKENS = {
  systemPrompt: 12500,
  systemTools: 12600,
  skills: 4300,
  subagents: 686,
};

export const SYSTEM_BASE_TOTAL =
  SYSTEM_BASE_TOKENS.systemPrompt +
  SYSTEM_BASE_TOKENS.systemTools +
  SYSTEM_BASE_TOKENS.skills +
  SYSTEM_BASE_TOKENS.subagents;

// Prompt Cache 命中率六档视觉分级定义（适配左偏态分布：93%+ 正常步骤集中在 80% 以上）
export const CACHE_HIT_GRADES = {
  MISS:     { key: 'miss',     label: '未命中', range: '0%',     color: '#8b8e9f', emoji: '⚪' },
  CRITICAL: { key: 'critical', label: '极低',   range: '0~40%',  color: '#f87171', emoji: '🔴' },
  LOW:      { key: 'low',      label: '偏低',   range: '40~60%', color: '#fb923c', emoji: '🟠' },
  MODERATE: { key: 'moderate', label: '一般',   range: '60~80%', color: '#facc15', emoji: '🟡' },
  GOOD:     { key: 'good',     label: '良好',   range: '80~95%', color: '#a3e635', emoji: '🍏' },
  OPTIMAL:  { key: 'optimal',  label: '极佳',   range: '95%+',   color: '#34d399', emoji: '🟢' },
};

