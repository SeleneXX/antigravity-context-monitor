import path from 'path';
import os from 'os';

// Antigravity 数据根目录与会话日志目录
export const APP_DATA_DIR =
  process.env.ANTIGRAVITY_APP_DATA_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.gemini', 'antigravity');

export const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');
export const SCRATCH_DIR = path.join(APP_DATA_DIR, 'scratch');
export const CONVERSATIONS_DIR = path.join(APP_DATA_DIR, 'conversations');
export const CLI_DATA_DIR =
  process.env.ANTIGRAVITY_CLI_DIR || path.join(APP_DATA_DIR, '..', 'antigravity-cli');
export const CLI_BRAIN_DIR = path.join(CLI_DATA_DIR, 'brain');
export const CLI_CONVERSATIONS_DIR = path.join(CLI_DATA_DIR, 'conversations');
export const CLI_SETTINGS_PATH = path.join(CLI_DATA_DIR, 'settings.json');
// 账本增量缓存与个人偏好目录放在 scratch 下，避免污染插件源码目录
export const MONITOR_DATA_DIR = path.join(SCRATCH_DIR, 'context-monitor-data');

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
  'gemini-flash-worker-agy': 'Gemini 4 Hydrogen (Orchestrator)',
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
  GEMINI_4: 512000, // Gemini 4 Carbon / Argon / Hydrogen 及其 Orchestrator 上下文翻倍至 512k
  GEMINI: 256000,   // Gemini 3.8 Flash / 3.5 Flash Lite / Flash Worker 保持 256k
  GPT_OSS: 128000,  // 开源或第三方小窗口模型
};

// 当灰度实验或特殊路由使实际 Prompt 突破默认压缩阈值时的阶梯扩容档位
export const WINDOW_ESCAPE_LADDER = [256000, 512000, 1000000, 2000000];

// 各模型百万 Token 估算单价（USD / 1M tokens），用于会话与全局账本成本参考（核对日期: 2026-11-16）
export const PRICING_TABLE = {
  'gemini-flash-lite': { label: 'Gemini 3.5 Flash-Lite', input: 0.30, output: 2.50, cacheRead: 0.030 },
  'gemini-flash':      { label: 'Gemini 3.8 Flash',      input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-4-hydrogen': { label: 'Gemini 4 Hydrogen',     input: 1.50, output: 7.50, cacheRead: 0.075 },
  'gemini-4-carbon':   {
    label: 'Gemini 4 Carbon / Argon',
    input: 2.00,
    output: 10.0,
    cacheRead: 0.100,
    nextEffectiveFrom: '2026-12-01',
    nextInput: 4.00,
    nextOutput: 20.0,
    nextCacheRead: 0.200,
  },
  'gemini-pro':        { label: 'Gemini Pro',            input: 2.00, output: 10.0, cacheRead: 0.200 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5',     input: 2.00, output: 10.0, cacheRead: 0.100 },
  'claude-opus-5-5':   { label: 'Claude Opus 5.5',       input: 4.00, output: 20.0, cacheRead: 0.200 },
  'claude-sonnet':     { label: 'Claude Sonnet (4.x)',   input: 3.00, output: 15.0, cacheRead: 0.300 },
  'claude-opus':       { label: 'Claude Opus (4.x)',     input: 15.0, output: 75.0, cacheRead: 1.500 },
  'gpt-oss':           { label: 'GPT-OSS 120B',          input: 0.09, output: 0.36, cacheRead: 0.000 },
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

// 订阅回本核算预设方案
export const SUBSCRIPTION_PRESETS = [
  { id: 'pro_monthly', label: 'Google AI Pro ($19.99/月)',       monthlyPrice: 19.99,  currency: 'USD' },
  { id: 'ultra_5x',    label: 'Google AI Ultra 5x ($99.99/月)',  monthlyPrice: 99.99,  currency: 'USD' },
  { id: 'ultra_20x',   label: 'Google AI Ultra 20x ($199.99/月)', monthlyPrice: 199.99, currency: 'USD' },
  { id: 'free_offer',  label: '学生认证 / 设备附赠 ($0 白嫖)',   monthlyPrice: 0,      currency: 'USD' },
  { id: 'custom',      label: '自定义实付方案',                  monthlyPrice: 19.99,  currency: 'USD' },
];

export const DEFAULT_USD_TO_CNY = 7.25;

// 各币种符号及相对 USD 的参考换算率（ratesPerUsd 表示 1 USD 约折合多少该币种，CNY 运行时以用户配置 usdToCny 为准）
export const CURRENCY_CONFIG = {
  USD: { code: 'USD', symbol: '$',   label: '美元 (USD)',   ratesPerUsd: 1.0 },
  CNY: { code: 'CNY', symbol: '¥',   label: '人民币 (CNY)', ratesPerUsd: DEFAULT_USD_TO_CNY },
  HKD: { code: 'HKD', symbol: 'HK$', label: '港币 (HKD)',   ratesPerUsd: 7.80 },
  EUR: { code: 'EUR', symbol: '€',   label: '欧元 (EUR)',   ratesPerUsd: 0.92 },
  GBP: { code: 'GBP', symbol: '£',   label: '英镑 (GBP)',   ratesPerUsd: 0.79 },
  JPY: { code: 'JPY', symbol: '¥',   label: '日元 (JPY)',   ratesPerUsd: 152.0 },
  TWD: { code: 'TWD', symbol: 'NT$', label: '新台币 (TWD)', ratesPerUsd: 32.0 },
};

// 52 周活跃热力图色阶预设（索引 0 为无用量空色，1~4 为活跃渐变档）
export const HEATMAP_THEMES = {
  emerald: {
    key: 'emerald',
    label: '翠绿',
    colors: ['#1e202b', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
  amethyst: {
    key: 'amethyst',
    label: '紫晶',
    colors: ['#1e202b', '#3b1d5e', '#5b2d90', '#8b5cf6', '#c084fc'],
  },
  ocean: {
    key: 'ocean',
    label: '冰蓝',
    colors: ['#1e202b', '#0c3547', '#0e5a7a', '#0284c7', '#38bdf8'],
  },
  amber: {
    key: 'amber',
    label: '琥珀',
    colors: ['#1e202b', '#4d2608', '#8a4208', '#d97706', '#fbbf24'],
  },
};


