import fs from 'fs';
import path from 'path';
import { BRAIN_DIR, DEFAULT_MAX_WINDOW } from './constants.mjs';
import { clearModelCache } from './models.mjs';
import { parseTranscript, clearTranscriptCache } from './transcript.mjs';
import { getSubagentsForConversation, clearSubagentCache } from './subagents.mjs';

let cachedConvs = null;
let lastConvsFetchTime = 0;

/**
 * 仅读取文件头 1KB 提取首行元信息，避免为排除子代理而把上百 MB 日志全量读入内存
 */
function readFirstJsonHeader(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
    if (bytesRead <= 0) return null;
    const head = buf.toString('utf8', 0, bytesRead);
    const nlIdx = head.indexOf('\n');
    const firstLine = (nlIdx >= 0 ? head.slice(0, nlIdx) : head).trim();
    if (!firstLine) return null;
    return JSON.parse(firstLine);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function clearAllCaches() {
  cachedConvs = null;
  lastConvsFetchTime = 0;
  clearModelCache();
  clearTranscriptCache();
  clearSubagentCache();
}

/**
 * 列出所有顶层主会话（排除子代理目录），按最后活跃时间降序排列
 */
export function getConversations({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedConvs && now - lastConvsFetchTime < 2500) {
    return cachedConvs;
  }
  if (!fs.existsSync(BRAIN_DIR)) return [];

  const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
  const convs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logPath = path.join(BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(logPath)) continue;

    try {
      const firstObj = readFirstJsonHeader(logPath);
      if (!firstObj || firstObj.source === 'SYSTEM' || firstObj.type === 'SYSTEM_MESSAGE') {
        continue;
      }
      const stat = fs.statSync(logPath);
      convs.push({
        id: entry.name,
        updatedAt: stat.mtimeMs,
        updatedAtIso: stat.mtime.toISOString(),
        size: stat.size,
        logPath,
      });
    } catch {}
  }

  convs.sort((a, b) => b.updatedAt - a.updatedAt);
  cachedConvs = convs;
  lastConvsFetchTime = now;
  return convs;
}

/**
 * 定位目标会话日志文件（优先直连指定 ID，未传时回退至最近活跃的主会话）
 */
export function resolveTargetConversation(requestedId = '', { force = false } = {}) {
  const cleanId = (requestedId || '').trim();
  if (cleanId) {
    const directLog = path.join(BRAIN_DIR, cleanId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(directLog)) {
      try {
        const stat = fs.statSync(directLog);
        return {
          id: cleanId,
          updatedAt: stat.mtimeMs,
          updatedAtIso: stat.mtime.toISOString(),
          size: stat.size,
          logPath: directLog,
        };
      } catch {}
    }
  }

  const convs = getConversations({ force });
  if (cleanId) {
    const found = convs.find((c) => c.id === cleanId);
    if (found) return found;
  }
  return convs[0] || null;
}

/**
 * 获取完整会话上下文监控快照（主 Agent + 全量 Subagents 集群汇总）
 */
export function getSessionSnapshot({
  conversationId = '',
  maxWindowOverride = 0,
  force = false,
} = {}) {
  if (force) {
    clearAllCaches();
  }

  const target = resolveTargetConversation(conversationId, { force });
  if (!target) return null;

  const stats = parseTranscript(target.logPath, { maxWindowOverride, force });
  if (!stats) {
    const fallbackMax = maxWindowOverride || DEFAULT_MAX_WINDOW;
    return {
      conversationId: target.id,
      updatedAt: target.updatedAtIso || new Date().toISOString(),
      turns: 0,
      steps: 0,
      maxWindow: fallbackMax,
      totalPromptTokens: 0,
      cacheHitRate: 0,
      contextPercent: 0,
      subagents: [],
      allAgentsSummary: {
        totalAgents: 1,
        subagentsCount: 0,
        combinedSteps: 0,
        combinedTotalPrompt: 0,
        combinedOutputTokens: 0,
        combinedThinkingTokens: 0,
        combinedResponseTokens: 0,
        combinedSessionTokens: 0,
        combinedCacheTokens: 0,
        combinedCacheHitRate: 0,
        combinedContextPercent: 0,
        combinedTokPerSec: 0,
        combinedTps: 0,
        combinedTtft: 0,
        combinedCompactions: 0,
        combinedReclaimedTokens: 0,
      },
    };
  }

  const activeMaxWindow = stats.maxWindow || DEFAULT_MAX_WINDOW;
  const subagents = getSubagentsForConversation(target.id, stats, {
    maxWindowOverride: maxWindowOverride || 0,
    force,
  });

  // 聚合主 Agent 与全部 Subagents 的全局吞吐数据
  let combinedTotalPrompt = stats.totalPromptTokens || 0;
  let combinedOutputTokens = stats.outputTokens || 0;
  let combinedThinkingTokens = stats.sessionThinkingTokens || 0;
  let combinedResponseTokens = stats.sessionResponseTokens || 0;
  let combinedSteps = stats.steps || 0;
  let combinedSessionTokens = stats.sessionTotalTokens || 0;
  let combinedInputTotal = stats.sessionInputTokens || 0;
  let combinedCacheTotal = stats.sessionCacheTokens || 0;
  let combinedCompactions = stats.compactions?.count || 0;
  let combinedReclaimedTokens = stats.compactions?.totalReclaimedTokens || 0;

  let speedSum = stats.tps || stats.tokPerSec || 0;
  let speedCount = speedSum > 0 ? 1 : 0;
  let ttftSum = stats.ttft || 0;
  let ttftCount = ttftSum > 0 ? 1 : 0;

  for (const sa of subagents) {
    combinedTotalPrompt += sa.totalPromptTokens || 0;
    combinedOutputTokens += sa.outputTokens || 0;
    combinedThinkingTokens += sa.sessionThinkingTokens || 0;
    combinedResponseTokens += sa.sessionResponseTokens || 0;
    combinedSteps += sa.steps || 0;
    combinedSessionTokens += sa.sessionTotalTokens || 0;
    combinedInputTotal += sa.sessionInputTokens || 0;
    combinedCacheTotal += sa.sessionCacheTokens || 0;
    combinedCompactions += sa.compactions?.count || 0;
    combinedReclaimedTokens += sa.compactions?.totalReclaimedTokens || 0;

    const sTps = sa.tps || sa.tokPerSec || 0;
    if (sTps > 0) {
      speedSum += sTps;
      speedCount++;
    }
    if (sa.ttft > 0) {
      ttftSum += sa.ttft;
      ttftCount++;
    }
  }

  const combinedAllPrompt = combinedInputTotal + combinedCacheTotal;
  const combinedCacheHitRate =
    combinedAllPrompt > 0
      ? Math.round((combinedCacheTotal / combinedAllPrompt) * 1000) / 10
      : stats.cacheHitRate;
  const combinedContextPercent =
    activeMaxWindow > 0 ? Math.round((combinedTotalPrompt / activeMaxWindow) * 1000) / 10 : 0;
  const combinedTps = speedCount > 0 ? Math.round(speedSum / speedCount) : stats.tps || stats.tokPerSec || 0;
  const combinedTtft = ttftCount > 0 ? Math.round((ttftSum / ttftCount) * 10) / 10 : stats.ttft || 0;

  const allAgentsSummary = {
    totalAgents: 1 + subagents.length,
    subagentsCount: subagents.length,
    combinedSteps,
    combinedTotalPrompt,
    combinedOutputTokens,
    combinedThinkingTokens,
    combinedResponseTokens,
    combinedSessionTokens,
    combinedCacheTokens: combinedCacheTotal,
    combinedCacheHitRate,
    combinedContextPercent,
    combinedTokPerSec: combinedTps,
    combinedTps,
    combinedTtft,
    combinedCompactions,
    combinedReclaimedTokens,
  };

  // 移除内部私有索引字段后再序列化输出
  const { _parentIndex, _lifecycle, _logMtimeMs, ...publicStats } = stats;

  return {
    conversationId: target.id,
    updatedAt: target.updatedAtIso,
    ...publicStats,
    maxWindow: activeMaxWindow,
    subagents,
    allAgentsSummary,
  };
}
