import path from 'path';
import os from 'os';

// Antigravity 数据根目录与会话日志目录
export const APP_DATA_DIR =
  process.env.ANTIGRAVITY_APP_DATA_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.gemini', 'antigravity');

export const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');
export const SCRATCH_DIR = path.join(APP_DATA_DIR, 'scratch');
export const CLI_SETTINGS_PATH = path.join(APP_DATA_DIR, '..', 'antigravity-cli', 'settings.json');

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
