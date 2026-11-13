import fs from 'fs';
import path from 'path';
import {
  BRAIN_DIR,
  DEFAULT_MAX_WINDOW,
  SYSTEM_BASE_TOKENS,
  SYSTEM_BASE_TOTAL,
} from './constants.mjs';
import {
  MODEL_SELECTION_REGEX,
  estimateTokensFromText,
  getModelMaxWindow,
  calcEstimatedCost,
  getDefaultCliModel,
  readConversationDbModel,
  classifyCacheHit,
} from './models.mjs';

const UUID_REGEX_GLOBAL = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
const SENDER_UUID_REGEX = /sender=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/([^\s\n"]+))?/i;
const BG_TASK_START_REGEX = /background task with task id:\s*([^\s\n"]+)/i;
const BG_TASK_FINISH_REGEX = /Task id ["']?([^"'\s\n]+)["']? finished/i;

// 基于文件 mtimeMs + size 的内存解析缓存，避免对多 MB 历史日志每秒重复做 JSON.parse
const transcriptCache = new Map();
const MAX_CACHE_ENTRIES = 80;

export function clearTranscriptCache() {
  transcriptCache.clear();
}

function cleanStr(val) {
  return String(val || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

function safeParseArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 将 invoke_subagent 的参数归一化为子智能体声明数组
 */
function extractSubagentSpecs(args) {
  let subs = args.Subagents || args.subagents;
  if (!subs) {
    if (args.Role || args.role || args.Model || args.model || args.TypeName || args.typeName || args.Prompt || args.prompt) {
      return [args];
    }
    return [];
  }
  if (typeof subs === 'string') {
    try {
      subs = JSON.parse(subs);
    } catch {
      return [];
    }
  }
  return Array.isArray(subs) ? subs : [subs];
}

/**
 * 单遍解析会话日志，同时构建统计指标、父会话子代理事件索引与子代理生命周期状态摘要
 */
function parseTranscriptFromDisk(logPath, stat) {
  const content = fs.readFileSync(logPath, 'utf8');
  const rawLines = content.split('\n');
  const convId = path.basename(path.dirname(path.dirname(path.dirname(logPath))));

  // 一次反序列化所有有效 JSON 行，自动忽略正在写入中的残缺末尾行
  const items = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i].trim();
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw));
    } catch {}
  }

  let currentModel = readConversationDbModel(convId)?.displayName || getDefaultCliModel();
  let explicitModelSelected = false;
  let inExecutionMode = false;

  let turns = 0;
  let steps = 0;
  let latestPlanner = null;
  let sessionCost = 0;
  let sessionInputTokens = 0;
  let sessionCacheTokens = 0;
  let sessionOutputTokens = 0;
  let sessionThinkingTokens = 0;
  let sessionResponseTokens = 0;

  let compactionsCount = 0;
  let totalReclaimedTokens = 0;
  let lastPromptBeforeDrop = 0;
  let pendingCheckpoint = false;
  let lastCompaction = null;

  // 当前活跃窗口（最近一次压缩后）的各类字符占比，用于准确反映当前上下文构成
  let activeUserChars = 0;
  let activeAgentChars = 0;
  let activeToolChars = 0;

  const plannerHistory = [];
  const tpsSamples = [];
  const ttftSamples = [];
  const userTtftSamples = [];

  // 父会话对子代理的调度事件索引（避免子代理状态判定时重复扫描主会话大文件）
  const parentIndex = {
    invokeCalls: [],
    discoveredSubIds: new Map(), // subId -> fallbackMeta
    dispatchesBySubId: new Map(),
    repliesBySubId: new Map(),
    killsBySubId: new Map(),
    swarmModelsByName: new Map(), // Swarm 成员名 -> model id
    globalKillTimeMs: 0,
  };

  // 若当前文件本身是子代理日志，同步维护其时序状态机摘要
  const firstItem = items[0] || null;
  const isSubagentTranscript = Boolean(
    firstItem && (firstItem.source === 'SYSTEM' || firstItem.type === 'SYSTEM_MESSAGE')
  );

  let parentOwnerId = '';
  if (isSubagentTranscript && typeof firstItem?.content === 'string') {
    const m = firstItem.content.match(SENDER_UUID_REGEX);
    if (m && m[1]) parentOwnerId = m[1];
  }

  const activeBgTasks = new Map(); // taskId -> { logFile, startedAtMs }
  let cycleState = 'WORKING';
  let cycleStartTimeMs = firstItem?.created_at ? new Date(firstItem.created_at).getTime() : stat.birthtimeMs;
  let repliedInCycle = false;
  let bgTaskStartedAfterReply = false;
  let waitingForChildSubagent = false;
  let interruptedByRestart = false;
  let errorMessage = '';
  let pendingHasSwarmWait = false;
  let pendingBatchRemaining = 0;
  let lastStepTimeMs = cycleStartTimeMs;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const nextItem = items[i + 1] || null;
    const itemTimeMs = item.created_at ? new Date(item.created_at).getTime() : 0;
    if (itemTimeMs > lastStepTimeMs) lastStepTimeMs = itemTimeMs;

    if (item.step_index && item.step_index > steps) {
      steps = item.step_index;
    }

    const textContent = typeof item.content === 'string' ? item.content : '';

    // 1. 处理模型切换标记与 Orchestrator Plan / Execution 切换提示（仅采信系统/用户输入步骤，避免代码或命令输出误匹配）
    const isSystemOrUser = item.type === 'USER_INPUT' || item.type === 'SYSTEM_MESSAGE';
    if (isSystemOrUser && textContent.includes('USER_SETTINGS_CHANGE') && textContent.includes('Model Selection')) {
      const m = textContent.match(MODEL_SELECTION_REGEX);
      if (m && m[1]) {
        currentModel = m[1].replace(/\.+$/, '').trim();
        explicitModelSelected = true;
      }
    }
    if (isSystemOrUser && textContent.includes('Plan mode is off: this turn runs on the execution model')) {
      inExecutionMode = true;
    } else if (isSystemOrUser && textContent.includes('Plan mode is on')) {
      inExecutionMode = false;
    }

    // 2. 父会话接收到的消息与重启通知索引（仅采信 SYSTEM_MESSAGE，防止读取其他会话日志造成串台）
    if (item.type === 'SYSTEM_MESSAGE' && textContent) {
      const senderMatch = textContent.match(SENDER_UUID_REGEX);
      if (senderMatch && senderMatch[1] && senderMatch[1] !== convId && !senderMatch[2]) {
        const sid = senderMatch[1];
        if (itemTimeMs > (parentIndex.repliesBySubId.get(sid) || 0)) {
          parentIndex.repliesBySubId.set(sid, itemTimeMs || stat.mtimeMs);
        }
        if (!parentIndex.discoveredSubIds.has(sid)) {
          parentIndex.discoveredSubIds.set(sid, {
            id: sid,
            role: 'Subagent Worker',
            typeName: 'subagent',
            spawnStepIndex: item.step_index || 0,
          });
        }
      }
      if (textContent.includes('All your subagents and background tasks have been stopped')) {
        if (itemTimeMs > parentIndex.globalKillTimeMs) {
          parentIndex.globalKillTimeMs = itemTimeMs || stat.mtimeMs;
        }
      }
    }

    // 3. 按步骤类型分类统计与状态机流转
    if (item.type === 'USER_INPUT') {
      turns++;
      activeUserChars += textContent.length;
      pendingHasSwarmWait = false;
      pendingBatchRemaining = 0;
      errorMessage = '';

      // 用户消息到下一条 PLANNER_RESPONSE 的首字延迟
      if (nextItem && nextItem.type === 'PLANNER_RESPONSE' && itemTimeMs > 0 && nextItem.created_at) {
        const diffSec = (new Date(nextItem.created_at).getTime() - itemTimeMs) / 1000;
        if (diffSec > 0 && diffSec <= 30) {
          userTtftSamples.push(diffSec);
        }
      }
    } else if (item.type === 'SYSTEM_MESSAGE') {
      pendingHasSwarmWait = false;
      pendingBatchRemaining = 0;
      errorMessage = '';
      if (textContent.includes('All your subagents and background tasks have been stopped')) {
        activeBgTasks.clear();
        waitingForChildSubagent = false;
        interruptedByRestart = true;
      } else {
        // 识别后台任务完成唤醒通知
        const senderTaskMatch = textContent.match(SENDER_UUID_REGEX);
        if (senderTaskMatch && senderTaskMatch[2]) {
          const fullTaskId = `${senderTaskMatch[1]}/${senderTaskMatch[2]}`;
          activeBgTasks.delete(fullTaskId);
          activeBgTasks.delete(senderTaskMatch[2]);
        }
        const finishMatch = textContent.match(BG_TASK_FINISH_REGEX);
        if (finishMatch && finishMatch[1]) {
          activeBgTasks.delete(finishMatch[1]);
        }

        // 若收到父代理发来的新指令，开启新一轮执行周期
        if (parentOwnerId && textContent.includes(`sender=${parentOwnerId}`)) {
          if (i > 0) {
            repliedInCycle = false;
            bgTaskStartedAfterReply = false;
            cycleStartTimeMs = itemTimeMs || lastStepTimeMs;
          }
        } else if (senderTaskMatch && senderTaskMatch[1] && senderTaskMatch[1] !== parentOwnerId && !senderTaskMatch[2]) {
          // 子代理自己唤起的下级子代理返回了结果
          waitingForChildSubagent = false;
        }
        interruptedByRestart = false;
        cycleState = 'WORKING';
      }
    } else if (item.type === 'CHECKPOINT') {
      // 上下文压缩检查点：重置当前活跃窗口字符统计基线，并标记子代理处于压缩恢复态
      pendingCheckpoint = true;
      pendingHasSwarmWait = false;
      pendingBatchRemaining = 0;
      errorMessage = '';
      if (item.input_tokens || item.cache_read_tokens) {
        const cpPrompt = (item.input_tokens || 0) + (item.cache_read_tokens || 0);
        if (cpPrompt > lastPromptBeforeDrop) lastPromptBeforeDrop = cpPrompt;
      }
      activeUserChars = textContent.length;
      activeAgentChars = 0;
      activeToolChars = 0;
      interruptedByRestart = false;
      cycleState = 'COMPACTING';
    } else if (item.type === 'ERROR_MESSAGE') {
      pendingHasSwarmWait = false;
      pendingBatchRemaining = 0;
      if (textContent.includes('Please continue the task')) {
        cycleState = 'WORKING';
        errorMessage = '';
      } else {
        cycleState = 'ERROR_HALTED';
        errorMessage = textContent.trim().slice(0, 120);
      }
    } else if (item.type === 'GENERIC') {
      activeToolChars += textContent.length;
      interruptedByRestart = false;
      if (pendingBatchRemaining > 0) pendingBatchRemaining--;

      // 捕获异步后台任务启动（如编译、自动化测试、长耗时脚本）
      const bgMatch = textContent.match(BG_TASK_START_REGEX);
      if (item.status === 'RUNNING' || bgMatch) {
        const taskId = bgMatch ? bgMatch[1] : `${convId}/task-${item.step_index || i}`;
        const taskShortName = taskId.includes('/') ? taskId.split('/').pop() : taskId;
        const logFile = path.join(BRAIN_DIR, convId, '.system_generated', 'tasks', `${taskShortName}.log`);
        activeBgTasks.set(taskId, { logFile, startedAtMs: itemTimeMs || stat.mtimeMs });
        bgTaskStartedAfterReply = true;
      } else if (textContent.includes('No background tasks are currently running')) {
        activeBgTasks.clear();
        bgTaskStartedAfterReply = false;
      }

      // 判定当前等待态：后台任务 > Swarm 看板挂起 (swarm_wait DONE) > 等待模型下一轮推理
      if (item.status === 'RUNNING' && !nextItem) {
        cycleState = 'WAITING_BG_TASK';
      } else if (
        pendingHasSwarmWait &&
        item.status === 'DONE' &&
        (pendingBatchRemaining === 0 || textContent.includes('Waiting for a message'))
      ) {
        cycleState = 'WAITING_BOARD';
      } else {
        cycleState = 'AWAITING_MODEL';
      }
    } else if (item.type === 'PLANNER_RESPONSE') {
      latestPlanner = item;
      interruptedByRestart = false;
      errorMessage = '';

      const cLen = textContent.length;
      const tLen = (item.thinking || '').length;
      activeAgentChars += cLen + tLen;

      const input = item.input_tokens || 0;
      const cache = item.cache_read_tokens || 0;
      const output = item.output_tokens || 0;
      const prompt = input + cache;

      const stepPricingModel =
        inExecutionMode && String(currentModel).toLowerCase().includes('orchestrator')
          ? 'gemini-flash'
          : currentModel;
      sessionInputTokens += input;
      sessionCacheTokens += cache;
      sessionOutputTokens += output;
      sessionCost += calcEstimatedCost(input, cache, output, stepPricingModel);

      // 估算本步思考与正文输出比例
      const thinkEst = estimateTokensFromText(item.thinking || '');
      const contentEst =
        estimateTokensFromText(textContent) +
        estimateTokensFromText(item.tool_calls ? JSON.stringify(item.tool_calls) : '');
      let stepThinking = 0;
      let stepResponse = output;
      if (thinkEst + contentEst > 0 && output > 0) {
        stepThinking = Math.min(output, Math.round((thinkEst / (thinkEst + contentEst)) * output));
        stepResponse = output - stepThinking;
      } else if (thinkEst > 0) {
        stepThinking = Math.min(output, thinkEst);
        stepResponse = Math.max(0, output - stepThinking);
      }
      sessionThinkingTokens += stepThinking;
      sessionResponseTokens += stepResponse;

      // 检测平台自动压缩或用户手动 /compact 导致的上下文回落
      const isSignificantDrop = lastPromptBeforeDrop > 50_000 && prompt < lastPromptBeforeDrop - 40_000;
      const isCheckpointDrop = pendingCheckpoint && lastPromptBeforeDrop > prompt + 5_000;
      if (prompt > 0 && (isSignificantDrop || isCheckpointDrop)) {
        const reclaimed = lastPromptBeforeDrop - prompt;
        const dropPct = Math.round((reclaimed / lastPromptBeforeDrop) * 1000) / 10;
        compactionsCount++;
        totalReclaimedTokens += reclaimed;
        lastCompaction = {
          stepIndex: item.step_index || 0,
          beforeTokens: lastPromptBeforeDrop,
          afterTokens: prompt,
          reclaimedTokens: reclaimed,
          dropPercent: dropPct,
          reductionPercent: dropPct,
          time: item.created_at || '',
        };
      }
      pendingCheckpoint = false;
      if (prompt > 0) lastPromptBeforeDrop = prompt;

      // 解析工具调用（维护父子通信索引与子代理状态流转）
      const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      pendingHasSwarmWait = toolCalls.some((tc) => tc?.name === 'swarm_wait');
      pendingBatchRemaining = toolCalls.length;
      const hasInvokeCall = toolCalls.some((tc) => tc?.name === 'invoke_subagent');
      const stepReturnedUuids = [];
      if (hasInvokeCall) {
        const invokeCount = toolCalls.filter((tc) => tc?.name === 'invoke_subagent').length;
        for (let j = i + 1; j < Math.min(items.length, i + 2 + invokeCount * 2); j++) {
          if (items[j]?.type === 'PLANNER_RESPONSE') break;
          const lookaheadStr = JSON.stringify(items[j]);
          const matches = lookaheadStr.match(UUID_REGEX_GLOBAL);
          if (matches) {
            for (const u of matches) {
              if (u !== convId && !stepReturnedUuids.includes(u)) {
                stepReturnedUuids.push(u);
              }
            }
          }
        }
      }
      let invokeUuidCursor = 0;

      for (const tc of toolCalls) {
        if (!tc || !tc.name) continue;
        const args = safeParseArgs(tc.args);

        if (tc.name === 'invoke_subagent') {
          waitingForChildSubagent = true;
          const specs = extractSubagentSpecs(args);
          for (const s of specs) {
            const uuid = stepReturnedUuids[invokeUuidCursor++] || null;
            const role = cleanStr(s.Role || s.role);
            const typeName = cleanStr(s.TypeName || s.typeName);
            const model = cleanStr(s.Model || s.model);
            const promptText = cleanStr(s.Prompt || s.prompt);
            parentIndex.invokeCalls.push({
              role,
              typeName,
              model,
              prompt: promptText,
              uuid,
              stepIndex: item.step_index || 0,
              createdAtMs: itemTimeMs,
            });
            if (uuid && !parentIndex.discoveredSubIds.has(uuid)) {
              parentIndex.discoveredSubIds.set(uuid, {
                id: uuid,
                role: role || 'Subagent Worker',
                typeName: typeName || 'subagent',
                model: model || 'inherit',
                spawnStepIndex: item.step_index || 0,
                spawnTimeMs: itemTimeMs,
              });
            }
          }
        } else if (tc.name === 'send_message') {
          const rec = String(args.Recipient || args.recipient || '').replace(/^["']|["']$/g, '').trim();
          if (isSubagentTranscript) {
            repliedInCycle = true;
            bgTaskStartedAfterReply = false;
          }
          if (rec && rec !== convId) {
            if (itemTimeMs > (parentIndex.dispatchesBySubId.get(rec) || 0)) {
              parentIndex.dispatchesBySubId.set(rec, itemTimeMs || stat.mtimeMs);
            }
            if (!parentIndex.discoveredSubIds.has(rec)) {
              parentIndex.discoveredSubIds.set(rec, {
                id: rec,
                role: 'Subagent Worker',
                typeName: 'subagent',
                spawnStepIndex: item.step_index || 0,
              });
            }
          }
        } else if (tc.name === 'manage_subagents') {
          const action = String(args.Action || args.action || '').toLowerCase();
          if (action === 'kill_all') {
            waitingForChildSubagent = false;
            if (itemTimeMs > parentIndex.globalKillTimeMs) {
              parentIndex.globalKillTimeMs = itemTimeMs || stat.mtimeMs;
            }
          } else if (action === 'kill') {
            const idsRaw = args.ConversationIds || args.conversationIds || args.ConversationId || args.conversationId || [];
            const idsStr = JSON.stringify(idsRaw);
            const killedUuids = idsStr.match(UUID_REGEX_GLOBAL) || [];
            for (const kid of killedUuids) {
              if (itemTimeMs > (parentIndex.killsBySubId.get(kid) || 0)) {
                parentIndex.killsBySubId.set(kid, itemTimeMs || stat.mtimeMs);
              }
            }
          }
        } else if (tc.name === 'manage_task') {
          const action = String(args.Action || args.action || '').toLowerCase();
          if (action === 'kill') {
            const tid = String(args.TaskId || args.taskId || '').trim();
            if (tid) {
              activeBgTasks.delete(tid);
              const uuids = tid.match(UUID_REGEX_GLOBAL) || [];
              for (const u of uuids) {
                if (u !== convId && itemTimeMs > (parentIndex.killsBySubId.get(u) || 0)) {
                  parentIndex.killsBySubId.set(u, itemTimeMs || stat.mtimeMs);
                }
              }
            }
          }
        } else if (tc.name === 'schedule') {
          bgTaskStartedAfterReply = true;
        } else if (tc.name === 'swarm') {
          const action = String(args.action || args.Action || '').toLowerCase();
          const mName = cleanStr(args.name || args.Name);
          const mModel = cleanStr(args.model || args.Model);
          if ((action === 'add' || action === 'model') && mName && mModel) {
            if (action === 'add' && Array.isArray(args.tasks) && args.tasks.length > 0) {
              for (let ti = 0; ti < args.tasks.length; ti++) {
                parentIndex.swarmModelsByName.set(`${mName}-${ti + 1}`, mModel);
              }
            } else if (action === 'add' && Number(args.n) > 1) {
              for (let ti = 1; ti <= Number(args.n); ti++) {
                parentIndex.swarmModelsByName.set(`${mName}-${ti}`, mModel);
              }
            } else {
              parentIndex.swarmModelsByName.set(mName, mModel);
            }
          }
        }
      }

      // 更新子代理步骤结束时的周期状态
      if (toolCalls.length > 0) {
        cycleState = 'EXECUTING_TOOLS';
      } else if (repliedInCycle && !bgTaskStartedAfterReply) {
        cycleState = 'TURN_CONCLUDED';
      } else if (activeBgTasks.size > 0) {
        cycleState = 'WAITING_BG_TASK';
      } else if (waitingForChildSubagent && !repliedInCycle) {
        cycleState = 'WAITING_SUBAGENT';
      } else {
        cycleState = 'TURN_CONCLUDED';
      }

      // 计算单步完成时间与解码 TPS / TTFT 样本
      let finishTime = '';
      let durationSec = null;
      for (let j = i + 1; j < Math.min(items.length, i + 5); j++) {
        const lookNext = items[j];
        if (lookNext && lookNext.created_at && itemTimeMs > 0) {
          const tEnd = new Date(lookNext.created_at).getTime();
          const dur = Math.round((tEnd - itemTimeMs) / 1000);
          if (lookNext.type === 'USER_INPUT') {
            const estDur = Math.max(1, Math.round((output || 100) / 120));
            durationSec = dur >= 1 && dur <= estDur * 1.5 ? dur : estDur;
            finishTime = new Date(itemTimeMs + durationSec * 1000).toISOString();
          } else if (dur >= 0) {
            durationSec = dur;
            finishTime = lookNext.created_at;
          }
          break;
        }
      }

      if (nextItem && (nextItem.type === 'GENERIC' || nextItem.type === 'USER_INPUT')) {
        if (output > 10 && itemTimeMs > 0 && nextItem.created_at) {
          const durSec = (new Date(nextItem.created_at).getTime() - itemTimeMs) / 1000;
          if (durSec >= 1 && (nextItem.type !== 'USER_INPUT' || durSec <= 15)) {
            const estTtft = Math.min(durSec * 0.65, Math.max(0.5, 0.8 + input / 4000 + cache / 80000));
            const decodeSec = Math.max(0.2, durSec - estTtft);
            const stepTps = Math.round(output / decodeSec);
            if (stepTps > 0 && stepTps <= 800) {
              tpsSamples.push({ stepTps, outTok: output, durSec: decodeSec });
              ttftSamples.push(Math.round(estTtft * 10) / 10);
            }
          }
        }
      }

      const hitRate = prompt > 0 ? (cache / prompt) * 100 : 0;
      const roundedHitRate = Math.round(hitRate * 10) / 10;
      plannerHistory.push({
        step: item.step_index || 0,
        startTime: item.created_at || '',
        startTimeMs: itemTimeMs,
        finishTime,
        durationSec,
        hasTools: toolCalls.length > 0,
        firstToolName: toolCalls[0]?.name || '',
        time: item.created_at || '',
        input,
        cache,
        output,
        thinking: stepThinking,
        response: stepResponse,
        isCacheHit: cache > 0,
        tokensSaved: cache,
        totalPrompt: prompt,
        cacheHitRate: roundedHitRate,
        cacheGrade: classifyCacheHit(roundedHitRate, cache),
        model: currentModel,
      });
    }
  }

  // 汇总 TPS 与 TTFT 指标
  let tps = 0;
  let recentTps = 0;
  let peakTps = 0;
  if (tpsSamples.length > 0) {
    let totTok = 0;
    let totSec = 0;
    for (const s of tpsSamples) {
      totTok += s.outTok;
      totSec += s.durSec;
      if (s.stepTps > peakTps) peakTps = s.stepTps;
    }
    tps = totSec > 0 ? Math.round(totTok / totSec) : 0;
    const recent = tpsSamples.slice(-10);
    const rTok = recent.reduce((acc, s) => acc + s.outTok, 0);
    const rSec = recent.reduce((acc, s) => acc + s.durSec, 0);
    recentTps = rSec > 0 ? Math.round(rTok / rSec) : tps;
  }

  let ttft = 0;
  let recentTtft = 0;
  let userTtft = 0;
  if (ttftSamples.length > 0) {
    ttft = Math.round((ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length) * 10) / 10;
    const r = ttftSamples.slice(-10);
    recentTtft = Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10;
  }
  if (userTtftSamples.length > 0) {
    userTtft = Math.round((userTtftSamples.reduce((a, b) => a + b, 0) / userTtftSamples.length) * 10) / 10;
  }

  const lifecycle = {
    isSubagentTranscript,
    parentOwnerId,
    spawnTimeMs: firstItem?.created_at ? new Date(firstItem.created_at).getTime() : stat.birthtimeMs,
    cycleStartTimeMs,
    lastStepTimeMs,
    cycleState,
    repliedInCycle,
    bgTaskStartedAfterReply,
    waitingForChildSubagent,
    interruptedByRestart,
    errorMessage,
    inExecutionMode,
    activeBgTaskLogs: Array.from(activeBgTasks.values()).map((t) => t.logFile),
    firstPromptSnippet: typeof firstItem?.content === 'string' ? firstItem.content : '',
  };

  return {
    convId,
    turns,
    steps,
    explicitModelSelected,
    parsedModel: currentModel,
    latestPlanner,
    sessionCost: Math.round(sessionCost * 10000) / 10000,
    sessionInputTokens,
    sessionCacheTokens,
    sessionOutputTokens,
    sessionThinkingTokens,
    sessionResponseTokens,
    compactionsCount,
    totalReclaimedTokens,
    lastCompaction,
    activeUserChars,
    activeAgentChars,
    activeToolChars,
    tps,
    recentTps,
    peakTps,
    ttft,
    recentTtft,
    userTtft,
    recentHistory: plannerHistory.slice(-35),
    parentIndex,
    lifecycle,
  };
}

/**
 * 基于缓存的静态解析结果与实时时钟（Date.now()）生成最终输出对象
 */
function buildFinalStats(cached, logMtimeMs, maxWindowOverride = 0) {
  const dbFallbackModel = readConversationDbModel(cached.convId)?.displayName || '';
  const detectedModel = cached.explicitModelSelected
    ? cached.parsedModel
    : dbFallbackModel || getDefaultCliModel();

  if (!cached.latestPlanner) {
    const fallbackWindow = maxWindowOverride > 0 ? maxWindowOverride : getModelMaxWindow(detectedModel, 0);
    return {
      turns: cached.turns,
      steps: cached.steps,
      model: detectedModel,
      detectedModel,
      maxWindow: fallbackWindow,
      inputTokens: 0,
      cacheTokens: 0,
      totalPromptTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      responseTokens: 0,
      sessionThinkingTokens: 0,
      sessionResponseTokens: 0,
      sessionInputTokens: 0,
      sessionCacheTokens: 0,
      sessionOutputTokens: 0,
      sessionTotalTokens: 0,
      totalTokens: 0,
      cacheHitRate: 0,
      sessionCacheHitRate: 0,
      stepCacheHitRate: 0,
      sessionCacheGrade: classifyCacheHit(0, 0),
      stepCacheGrade: classifyCacheHit(0, 0),
      contextPercent: 0,
      tokPerSec: 0,
      tps: 0,
      recentTps: 0,
      peakTps: 0,
      ttft: 0,
      recentTtft: 0,
      userTtft: 0,
      estimatedCost: 0,
      compactions: { count: 0, totalReclaimedTokens: 0, reclaimedTokens: 0, lastCompaction: null },
      compaction: { count: 0, totalReclaimedTokens: 0, reclaimedTokens: 0, lastCompaction: null },
      breakdown: {
        userMessages: 0,
        agentResponses: 0,
        toolCalls: 0,
        systemPrompt: SYSTEM_BASE_TOKENS.systemPrompt,
        systemTools: SYSTEM_BASE_TOKENS.systemTools,
        skills: SYSTEM_BASE_TOKENS.skills,
        subagents: SYSTEM_BASE_TOKENS.subagents,
        freeSpace: fallbackWindow,
        activePrompt: 0,
        maxWindow: fallbackWindow,
        systemFiles: ['~/.gemini/GEMINI.md'],
      },
      history: [],
      _parentIndex: cached.parentIndex,
      _lifecycle: cached.lifecycle,
      _logMtimeMs: logMtimeMs,
    };
  }

  const lp = cached.latestPlanner;
  const input = lp.input_tokens || 0;
  const cache = lp.cache_read_tokens || 0;
  const output = lp.output_tokens || 0;
  const totalPrompt = input + cache;

  const stepCacheHitRate = totalPrompt > 0 ? (cache / totalPrompt) * 100 : 0;
  const sessionTotalPrompt = cached.sessionInputTokens + cached.sessionCacheTokens;
  const sessionCacheHitRate = sessionTotalPrompt > 0 ? (cached.sessionCacheTokens / sessionTotalPrompt) * 100 : 0;

  const modelLimit = getModelMaxWindow(detectedModel, totalPrompt);
  const effectiveMaxWindow = maxWindowOverride > 0 ? maxWindowOverride : modelLimit;
  const contextPercent = effectiveMaxWindow > 0 ? (totalPrompt / effectiveMaxWindow) * 100 : 0;

  // 最新单步思考与正文拆分
  const lastThinkEst = estimateTokensFromText(lp.thinking || '');
  const lastContentEst =
    estimateTokensFromText(lp.content || '') +
    estimateTokensFromText(lp.tool_calls ? JSON.stringify(lp.tool_calls) : '');
  let latestThinking = 0;
  let latestResponse = output;
  if (lastThinkEst + lastContentEst > 0 && output > 0) {
    latestThinking = Math.min(output, Math.round((lastThinkEst / (lastThinkEst + lastContentEst)) * output));
    latestResponse = output - latestThinking;
  } else if (lastThinkEst > 0) {
    latestThinking = Math.min(output, lastThinkEst);
    latestResponse = Math.max(0, output - latestThinking);
  }

  // 动态分类占比拆解
  const totalDynChars = cached.activeUserChars + cached.activeAgentChars + cached.activeToolChars;
  const dynamicTokens = Math.max(0, totalPrompt - SYSTEM_BASE_TOTAL);
  let userTokens = 0;
  let agentTokens = 0;
  let toolTokens = 0;

  if (dynamicTokens > 0 && totalDynChars > 0) {
    userTokens = Math.round((cached.activeUserChars / totalDynChars) * dynamicTokens);
    agentTokens = Math.round((cached.activeAgentChars / totalDynChars) * dynamicTokens);
    toolTokens = Math.max(0, dynamicTokens - userTokens - agentTokens);
  } else if (totalDynChars > 0 && totalPrompt > 0) {
    // 刚经历压缩恢复、总 Prompt 小于标称系统基底时，按 20% 动态切片展示对话与工具分布
    const alloc = Math.round(totalPrompt * 0.2);
    userTokens = Math.round((cached.activeUserChars / totalDynChars) * alloc);
    agentTokens = Math.round((cached.activeAgentChars / totalDynChars) * alloc);
    toolTokens = Math.max(0, alloc - userTokens - agentTokens);
  }

  const freeTokens = Math.max(0, effectiveMaxWindow - totalPrompt);
  const breakdown = {
    userMessages: userTokens,
    agentResponses: agentTokens,
    toolCalls: toolTokens,
    systemPrompt: SYSTEM_BASE_TOKENS.systemPrompt,
    systemTools: SYSTEM_BASE_TOKENS.systemTools,
    skills: SYSTEM_BASE_TOKENS.skills,
    subagents: SYSTEM_BASE_TOKENS.subagents,
    freeSpace: freeTokens,
    activePrompt: totalPrompt,
    maxWindow: effectiveMaxWindow,
    systemFiles: ['~/.gemini/GEMINI.md'],
  };

  // 为历史记录的最后一步动态计算实时工具运行状态
  const now = Date.now();
  const history = cached.recentHistory.map((h, idx, arr) => {
    if (idx < arr.length - 1 || h.finishTime || !h.startTimeMs) {
      return {
        ...h,
        isToolRunning: false,
        runningToolName: '',
      };
    }
    const elapsedSec = (now - h.startTimeMs) / 1000;
    const estDur = Math.max(1, Math.round((h.output || 50) / 120));
    if (h.hasTools && elapsedSec < 180) {
      return {
        ...h,
        finishTime: '',
        durationSec: null,
        isToolRunning: true,
        runningToolName: h.firstToolName || 'tool',
      };
    }
    let dur = estDur;
    if (logMtimeMs > h.startTimeMs) {
      const mtimeDur = Math.round((logMtimeMs - h.startTimeMs) / 1000);
      if (mtimeDur >= 1 && mtimeDur <= Math.max(45, estDur * 2.5)) {
        dur = mtimeDur;
      }
    }
    return {
      ...h,
      durationSec: dur,
      finishTime: new Date(h.startTimeMs + dur * 1000).toISOString(),
      isToolRunning: false,
      runningToolName: '',
    };
  });

  const compactionInfo = {
    count: cached.compactionsCount,
    totalReclaimedTokens: cached.totalReclaimedTokens,
    reclaimedTokens: cached.totalReclaimedTokens,
    lastCompaction: cached.lastCompaction,
  };

  const tokPerSec = cached.tps || cached.recentTps || 0;
  const roundedSessionHitRate = Math.round(sessionCacheHitRate * 10) / 10;
  const roundedStepHitRate = Math.round(stepCacheHitRate * 10) / 10;

  return {
    turns: cached.turns,
    steps: cached.steps,
    model: detectedModel,
    detectedModel,
    maxWindow: effectiveMaxWindow,
    inputTokens: input,
    cacheTokens: cache,
    totalPromptTokens: totalPrompt,
    outputTokens: output,
    thinkingTokens: latestThinking,
    responseTokens: latestResponse,
    sessionThinkingTokens: cached.sessionThinkingTokens,
    sessionResponseTokens: cached.sessionResponseTokens,
    totalTokens: totalPrompt + output,
    cacheHitRate: roundedSessionHitRate,
    sessionCacheHitRate: roundedSessionHitRate,
    stepCacheHitRate: roundedStepHitRate,
    sessionCacheGrade: classifyCacheHit(roundedSessionHitRate, cached.sessionCacheTokens),
    stepCacheGrade: classifyCacheHit(roundedStepHitRate, cache),
    sessionInputTokens: cached.sessionInputTokens,
    sessionCacheTokens: cached.sessionCacheTokens,
    sessionOutputTokens: cached.sessionOutputTokens,
    sessionTotalTokens: sessionTotalPrompt + cached.sessionOutputTokens,
    contextPercent: Math.round(contextPercent * 10) / 10,
    tokPerSec,
    tps: cached.tps,
    recentTps: cached.recentTps,
    peakTps: cached.peakTps,
    ttft: cached.ttft,
    recentTtft: cached.recentTtft,
    userTtft: cached.userTtft,
    estimatedCost: cached.sessionCost,
    compactions: compactionInfo,
    compaction: compactionInfo,
    breakdown,
    history,
    _parentIndex: cached.parentIndex,
    _lifecycle: cached.lifecycle,
    _logMtimeMs: logMtimeMs,
  };
}

/**
 * 解析指定 transcript.jsonl（默认命中 mtime+size 缓存，force=true 时强制重读磁盘）
 */
export function parseTranscript(logPath, { maxWindowOverride = 0, force = false } = {}) {
  if (!fs.existsSync(logPath)) return null;

  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return null;
  }

  const cachedEntry = !force ? transcriptCache.get(logPath) : null;
  if (cachedEntry && cachedEntry.mtimeMs === stat.mtimeMs && cachedEntry.size === stat.size) {
    return buildFinalStats(cachedEntry.data, stat.mtimeMs, maxWindowOverride);
  }

  try {
    const parsed = parseTranscriptFromDisk(logPath, stat);
    if (transcriptCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = transcriptCache.keys().next().value;
      transcriptCache.delete(oldestKey);
    }
    transcriptCache.set(logPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data: parsed,
    });
    return buildFinalStats(parsed, stat.mtimeMs, maxWindowOverride);
  } catch {
    // 若文件正处于平台压缩重写瞬间，回退使用旧缓存数据以避免前端跳零
    if (cachedEntry) {
      return buildFinalStats(cachedEntry.data, stat.mtimeMs, maxWindowOverride);
    }
    return null;
  }
}
