import fs from 'fs';
import path from 'path';
import { BRAIN_DIR, DEFAULT_MAX_WINDOW } from './constants.mjs';
import { detectConversationModel, formatSubagentModelInfo } from './models.mjs';
import { parseTranscript } from './transcript.mjs';

const UUID_REGEX_GLOBAL = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;

// 针对 transcript_full.jsonl 中未截断 invoke_subagent 参数的按需缓存（仅在 compact 日志截断了 tool_calls 时兜底）
const fullInvokeCache = new Map();

export function clearSubagentCache() {
  fullInvokeCache.clear();
}

function getFullInvokeCalls(convId, force = false) {
  if (!convId) return [];
  const pFull = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (!fs.existsSync(pFull)) return [];

  try {
    const stat = fs.statSync(pFull);
    const cached = !force ? fullInvokeCache.get(convId) : null;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.calls;
    }

    const calls = [];
    const lines = fs.readFileSync(pFull, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('invoke_subagent')) continue;
      try {
        const item = JSON.parse(lines[i]);
        if (!Array.isArray(item.tool_calls)) continue;

        const invokeCount = item.tool_calls.filter((tc) => tc?.name === 'invoke_subagent').length;
        const returnedUuids = [];
        for (let j = i + 1; j < Math.min(lines.length, i + 2 + invokeCount * 2); j++) {
          if ((lines[j] || '').includes('"PLANNER_RESPONSE"')) break;
          const matches = (lines[j] || '').match(UUID_REGEX_GLOBAL);
          if (matches) {
            for (const u of matches) {
              if (u !== convId && !returnedUuids.includes(u)) returnedUuids.push(u);
            }
          }
        }

        let uuidCursor = 0;
        for (const tc of item.tool_calls) {
          if (tc?.name !== 'invoke_subagent' || !tc.args) continue;
          const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
          let subs = args.Subagents || args.subagents;
          if (!subs) subs = [args];
          else if (typeof subs === 'string') subs = JSON.parse(subs);
          if (!Array.isArray(subs)) subs = [subs];

          for (const s of subs) {
            const unquote = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
            calls.push({
              role: unquote(s.Role || s.role),
              typeName: unquote(s.TypeName || s.typeName),
              model: unquote(s.Model || s.model),
              prompt: unquote(s.Prompt || s.prompt),
              uuid: returnedUuids[uuidCursor++] || null,
              stepIndex: item.step_index || 0,
            });
          }
        }
      } catch {}
    }

    fullInvokeCache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, calls });
    return calls;
  } catch {
    return [];
  }
}

/**
 * 结合时序状态机、后台任务日志活跃度、父会话调度记录与描述符状态，给出无闪烁的精准状态
 */
export function evaluateSubagentLiveStatus({
  subId,
  descriptor,
  subStats,
  parentIndex,
}) {
  const now = Date.now();
  const descriptorKilled = descriptor?.state === 'SUBAGENT_STATE_KILLED';
  const parentDispatchMs = parentIndex?.dispatchesBySubId?.get(subId) || 0;
  const parentReplyMs = parentIndex?.repliesBySubId?.get(subId) || 0;
  const parentKillMs = Math.max(
    parentIndex?.killsBySubId?.get(subId) || 0,
    parentIndex?.globalKillTimeMs || 0
  );

  // 情况 1：子代理已被创建，但 transcript.jsonl 尚未刷盘落盘（刚被 invoke_subagent 唤起的前几秒）
  if (!subStats || !subStats._lifecycle) {
    if (descriptorKilled) {
      return { status: 'STOPPED', statusDetail: '已终止' };
    }
    const spawnAnchorMs = descriptor?.mtimeMs || descriptor?.spawnTimeMs || 0;
    if (spawnAnchorMs > 0 && now - spawnAnchorMs < 180_000 && parentKillMs <= spawnAnchorMs) {
      return { status: 'RUNNING', statusDetail: '启动初始化' };
    }
    return { status: 'STOPPED', statusDetail: '未就绪' };
  }

  const lc = subStats._lifecycle;
  const logMtimeMs = subStats._logMtimeMs || lc.lastStepTimeMs || 0;
  const lastActivityMs = Math.max(lc.lastStepTimeMs || 0, logMtimeMs);

  // 情况 2：父会话刚刚向该子代理追加发送了新指令（send_message），消息尚在投递或模型正在预填充
  if (
    parentDispatchMs > (lc.lastStepTimeMs || 0) &&
    now - parentDispatchMs < 180_000 &&
    parentKillMs < parentDispatchMs &&
    !descriptorKilled
  ) {
    return { status: 'RUNNING', statusDetail: '处理新指令' };
  }

  // 情况 3：当前执行周期已完整收尾且已向父代理交付汇报（免疫后续的清理 kill 或服务重启通知）
  const hasRepliedInCurrentCycle = lc.repliedInCycle || parentReplyMs >= lc.cycleStartTimeMs;
  if (lc.cycleState === 'TURN_CONCLUDED' && hasRepliedInCurrentCycle) {
    return { status: 'DONE', statusDetail: '已完成' };
  }
  if (hasRepliedInCurrentCycle && lc.cycleState === 'AWAITING_MODEL' && now - lastActivityMs >= 15_000) {
    return { status: 'DONE', statusDetail: '已完成' };
  }

  // 情况 4：在未完成本轮汇报前被显式 kill 或被服务重启中断
  const killedDuringActiveRun =
    descriptorKilled ||
    lc.interruptedByRestart ||
    (parentKillMs >= lc.spawnTimeMs && parentKillMs >= (lc.lastStepTimeMs || 0));

  if (killedDuringActiveRun) {
    // 若在重启/清理发生前早已自然结束发言超过 10 秒，保留其 DONE 状态而非误标 STOPPED
    if (lc.cycleState === 'TURN_CONCLUDED' && parentKillMs > (lc.lastStepTimeMs || 0) + 10_000 && !descriptorKilled) {
      return { status: 'DONE', statusDetail: '已完成' };
    }
    return { status: 'STOPPED', statusDetail: '已中止' };
  }

  // 情况 5：子代理主动挂起当前轮次，等待后台任务（如 C++ 编译、自动化测试）完成唤醒
  if (lc.cycleState === 'WAITING_BG_TASK') {
    let latestBgLogMtime = 0;
    if (Array.isArray(lc.activeBgTaskLogs)) {
      for (const taskLog of lc.activeBgTaskLogs) {
        try {
          if (fs.existsSync(taskLog)) {
            const m = fs.statSync(taskLog).mtimeMs;
            if (m > latestBgLogMtime) latestBgLogMtime = m;
          }
        } catch {}
      }
    }
    const bgAnchorMs = Math.max(lastActivityMs, latestBgLogMtime);
    // 后台大型编译或全量测试允许最长 30 分钟静默等待
    if (now - bgAnchorMs < 30 * 60 * 1000) {
      return { status: 'RUNNING', statusDetail: '等待后台任务' };
    }
    return { status: 'STOPPED', statusDetail: '后台任务超时' };
  }

  // 情况 6：子代理唤起了下级子代理并等待其回调唤醒
  if (lc.cycleState === 'WAITING_SUBAGENT') {
    if (now - lastActivityMs < 20 * 60 * 1000) {
      return { status: 'RUNNING', statusDetail: '等待子代理' };
    }
    return { status: 'STOPPED', statusDetail: '等待超时' };
  }

  // 情况 7：正处于工具同步执行、上下文自动压缩恢复或深度思考解码中
  if (
    lc.cycleState === 'COMPACTING' ||
    lc.cycleState === 'EXECUTING_TOOLS' ||
    lc.cycleState === 'AWAITING_MODEL' ||
    lc.cycleState === 'WORKING'
  ) {
    // 深度思考模型与上下文压缩预填充耗时较长，给予 10 分钟活跃窗口避免中途闪断为 STOPPED
    if (now - lastActivityMs < 10 * 60 * 1000) {
      const detailMap = {
        COMPACTING: '上下文压缩中',
        EXECUTING_TOOLS: '执行工具中',
        AWAITING_MODEL: '模型推理中',
        WORKING: '模型推理中',
      };
      return { status: 'RUNNING', statusDetail: detailMap[lc.cycleState] || '运行中' };
    }
    return { status: 'STOPPED', statusDetail: '响应超时' };
  }

  // 情况 8：模型无后续工具调用自然结束发言（即使未显式调用 send_message）
  if (lc.cycleState === 'TURN_CONCLUDED') {
    if (now - lastActivityMs < 5_000) {
      return { status: 'RUNNING', statusDetail: '收尾中' };
    }
    return { status: 'DONE', statusDetail: '已完成' };
  }

  return { status: 'STOPPED', statusDetail: '异常停止' };
}

/**
 * 解析单个子代理的 Role、TypeName 与真实运行模型信息
 */
function resolveSubagentMetadata({
  subId,
  mainConvId,
  mainModel,
  descriptor,
  subStats,
  parentIndex,
  force = false,
}) {
  let role = descriptor?.role || 'Subagent Worker';
  let typeName = descriptor?.typeName || 'subagent';
  let rawModel = descriptor?.model || '';
  const parentOwnerId = subStats?._lifecycle?.parentOwnerId || mainConvId;

  const tryMatchFromCalls = (calls) => {
    if (!Array.isArray(calls) || calls.length === 0) return null;
    let match = calls.find((c) => c.uuid && c.uuid.toLowerCase() === subId.toLowerCase());
    if (!match && role && role !== 'Subagent Worker') {
      match = calls.find((c) => c.role && c.role.toLowerCase() === role.toLowerCase());
    }
    if (!match && subStats?._lifecycle?.firstPromptSnippet) {
      const snippet = subStats._lifecycle.firstPromptSnippet;
      match = calls.find((c) => c.prompt && c.prompt.length >= 20 && snippet.includes(c.prompt.slice(0, 50)));
    }
    return match || null;
  };

  // 先查内存中的主会话单遍索引
  if (!rawModel || rawModel === 'inherit' || role === 'Subagent Worker') {
    let matched = tryMatchFromCalls(parentIndex?.invokeCalls || []);
    // 若 compact 日志因超长 Prompt 截断了 tool_calls，再按需回查 transcript_full.jsonl
    if (!matched || !matched.model) {
      const fullCalls = getFullInvokeCalls(parentOwnerId, force);
      matched = tryMatchFromCalls(fullCalls) || matched;
    }
    if (matched) {
      if (matched.role && role === 'Subagent Worker') role = matched.role;
      if (matched.typeName && typeName === 'subagent') typeName = matched.typeName;
      if (matched.model) rawModel = matched.model;
    }
  }

  // browser 子代理未显式传模型时平台默认使用 flash，其余默认继承主会话
  if (!rawModel) {
    rawModel = typeName === 'browser' ? 'flash' : 'inherit';
  }

  const parentEffectiveModel =
    parentOwnerId === mainConvId ? mainModel : detectConversationModel(parentOwnerId);
  const modelInfo = formatSubagentModelInfo(rawModel, parentEffectiveModel);

  return {
    role,
    typeName,
    ...modelInfo,
    parentId: parentOwnerId,
  };
}

/**
 * 获取主会话关联的全部 Subagents 实时状态与统计列表
 */
export function getSubagentsForConversation(mainConvId, mainStats, { maxWindowOverride = 0, force = false } = {}) {
  const parentIndex = mainStats?._parentIndex || {
    invokeCalls: [],
    discoveredSubIds: new Map(),
    dispatchesBySubId: new Map(),
    repliesBySubId: new Map(),
    killsBySubId: new Map(),
    globalKillTimeMs: 0,
  };
  const mainModel = mainStats?.detectedModel || mainStats?.model || '';

  // 合并权威描述符目录 (.system_generated/subagents) 与主会话日志发现的 UUID
  const subagentsMap = new Map();
  const subDir = path.join(BRAIN_DIR, mainConvId, '.system_generated', 'subagents');
  if (fs.existsSync(subDir)) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.json')) continue;
        const fullPath = path.join(subDir, f);
        try {
          const stat = fs.statSync(fullPath);
          const sd = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          const sid = sd.conversationId || f.replace(/\.json$/i, '');
          if (sid) {
            subagentsMap.set(sid, {
              id: sid,
              role: sd.subagentDescriptor?.role || 'Subagent Worker',
              typeName: sd.subagentDescriptor?.typeName || 'subagent',
              model: sd.subagentDescriptor?.model || '',
              state: sd.state || 'SUBAGENT_STATE_ALIVE',
              spawnStepIndex: sd.spawnStepIndex || 0,
              mtimeMs: stat.mtimeMs,
              hasAuthoritativeDescriptor: true,
            });
          }
        } catch {}
      }
    } catch {}
  }

  for (const [sid, fallbackMeta] of parentIndex.discoveredSubIds.entries()) {
    if (sid !== mainConvId && !subagentsMap.has(sid)) {
      subagentsMap.set(sid, {
        ...fallbackMeta,
        hasAuthoritativeDescriptor: false,
      });
    }
  }

  const result = [];
  for (const [subId, desc] of subagentsMap.entries()) {
    const subLog = path.join(BRAIN_DIR, subId, '.system_generated', 'logs', 'transcript.jsonl');

    if (!fs.existsSync(subLog)) {
      // 仅对权威描述符刚创建但日志尚未落盘的新生子代理展示初始化态
      if (!desc.hasAuthoritativeDescriptor) continue;
      const live = evaluateSubagentLiveStatus({
        subId,
        descriptor: desc,
        subStats: null,
        parentIndex,
      });
      if (live.status !== 'RUNNING') continue;

      const resolved = resolveSubagentMetadata({
        subId,
        mainConvId,
        mainModel,
        descriptor: desc,
        subStats: null,
        parentIndex,
        force,
      });
      result.push({
        id: subId,
        role: resolved.role,
        typeName: resolved.typeName,
        model: resolved.model,
        modelKey: resolved.modelKey,
        modelBadge: resolved.modelBadge,
        modelDesc: resolved.modelDesc,
        rawModel: resolved.rawModel,
        spawnStepIndex: desc.spawnStepIndex || 0,
        steps: 0,
        turns: 0,
        status: live.status,
        statusDetail: live.statusDetail,
        tokPerSec: 0,
        tps: 0,
        recentTps: 0,
        ttft: 0,
        recentTtft: 0,
        inputTokens: 0,
        cacheTokens: 0,
        totalPromptTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        sessionThinkingTokens: 0,
        sessionResponseTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        sessionInputTokens: 0,
        sessionCacheTokens: 0,
        sessionTotalTokens: 0,
        compactions: { count: 0, totalReclaimedTokens: 0, lastCompaction: null },
      });
      continue;
    }

    const subStats = parseTranscript(subLog, { maxWindowOverride, force });
    if (!subStats) continue;

    // 过滤掉正文中误匹配到的顶层独立用户会话 UUID
    if (!desc.hasAuthoritativeDescriptor && !subStats._lifecycle?.isSubagentTranscript) {
      continue;
    }

    const live = evaluateSubagentLiveStatus({
      subId,
      descriptor: desc,
      subStats,
      parentIndex,
    });
    const resolved = resolveSubagentMetadata({
      subId,
      mainConvId,
      mainModel,
      descriptor: desc,
      subStats,
      parentIndex,
      force,
    });

    result.push({
      id: subId,
      role: resolved.role,
      typeName: resolved.typeName,
      model: resolved.model,
      modelKey: resolved.modelKey,
      modelBadge: resolved.modelBadge,
      modelDesc: resolved.modelDesc,
      rawModel: resolved.rawModel,
      spawnStepIndex: desc.spawnStepIndex || 0,
      steps: subStats.steps,
      turns: subStats.turns,
      status: live.status,
      statusDetail: live.statusDetail,
      tokPerSec: subStats.tokPerSec || 0,
      tps: subStats.tps || subStats.tokPerSec || 0,
      recentTps: subStats.recentTps || 0,
      ttft: subStats.ttft || 0,
      recentTtft: subStats.recentTtft || 0,
      inputTokens: subStats.inputTokens,
      cacheTokens: subStats.cacheTokens,
      totalPromptTokens: subStats.totalPromptTokens,
      outputTokens: subStats.outputTokens,
      thinkingTokens: subStats.thinkingTokens,
      responseTokens: subStats.responseTokens,
      sessionThinkingTokens: subStats.sessionThinkingTokens,
      sessionResponseTokens: subStats.sessionResponseTokens,
      totalTokens: subStats.totalTokens,
      cacheHitRate: subStats.cacheHitRate,
      sessionInputTokens: subStats.sessionInputTokens,
      sessionCacheTokens: subStats.sessionCacheTokens,
      sessionTotalTokens: subStats.sessionTotalTokens,
      compactions: subStats.compactions,
    });
  }

  // 二级排序：RUNNING 置顶，其次 DONE，最后 STOPPED；同级内保持创建步序稳定不跳动
  result.forEach((item, idx) => {
    item._order = idx;
  });
  result.sort((a, b) => {
    const getPriority = (s) => (s === 'RUNNING' ? 0 : s === 'DONE' ? 1 : 2);
    const pDiff = getPriority(a.status) - getPriority(b.status);
    if (pDiff !== 0) return pDiff;
    if ((a.spawnStepIndex || 0) !== (b.spawnStepIndex || 0)) {
      return (a.spawnStepIndex || 0) - (b.spawnStepIndex || 0);
    }
    return (a._order || 0) - (b._order || 0);
  });
  result.forEach((item) => {
    delete item._order;
  });

  return result;
}
