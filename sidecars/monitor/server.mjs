import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || '39821', 10);
const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.gemini/antigravity');
const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');
const SCRATCH_DIR = path.join(APP_DATA_DIR, 'scratch');
const LOG_FILE = path.join(SCRATCH_DIR, 'sidecar_debug.log');

function logDebug(msg) {
  try {
    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
}

logDebug(`Sidecar server starting. PID: ${process.pid}, PORT: ${PORT}, env PORT: ${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT}`);

function getConversations() {
  if (!fs.existsSync(BRAIN_DIR)) return [];
  const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
  const convs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logPath = path.join(BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(logPath)) {
      try {
        const firstLine = fs.readFileSync(logPath, 'utf8').split('\n')[0];
        const firstObj = JSON.parse(firstLine);
        // Exclude subagents from main conversations list
        if (firstObj.source === 'SYSTEM' || firstObj.type === 'SYSTEM_MESSAGE') {
          continue;
        }

        const stat = fs.statSync(logPath);
        convs.push({
          id: entry.name,
          updatedAt: stat.mtimeMs,
          updatedAtIso: stat.mtime.toISOString(),
          size: stat.size,
          logPath
        });
      } catch (e) {}
    }
  }
  convs.sort((a, b) => b.updatedAt - a.updatedAt);
  return convs;
}

const DEFAULT_MAX_WINDOW = 256000;

function estimateTokensFromText(text) {
  if (!text) return 0;
  let ascii = 0, nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    text.charCodeAt(i) < 128 ? ascii++ : nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

const PRICING_TABLE = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.8-flash-lite': { input: 0.35, output: 1.75, cacheRead: 0.035 },
  'gemini-4-argon': { input: 2.0, output: 10.0, cacheRead: 0.20 },
  'claude-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.30 },
  'claude-opus': { input: 15.0, output: 75.0, cacheRead: 1.50 },
  'gpt-oss-120b': { input: 0.09, output: 0.36, cacheRead: 0.0 },
};

function getModelPricing(modelName) {
  if (!modelName) return PRICING_TABLE['gemini-3.8-flash'];
  const m = String(modelName).toLowerCase();
  if (m.includes('flash-lite') || m.includes('flash_lite')) return PRICING_TABLE['gemini-3.8-flash-lite'];
  if (m.includes('flash')) return PRICING_TABLE['gemini-3.8-flash'];
  if (m.includes('opus')) return PRICING_TABLE['claude-opus'];
  if (m.includes('sonnet')) return PRICING_TABLE['claude-sonnet'];
  if (m.includes('oss') || m.includes('gpt')) return PRICING_TABLE['gpt-oss-120b'];
  if (m.includes('argon') || m.includes('pro')) return PRICING_TABLE['gemini-4-argon'];
  return PRICING_TABLE['gemini-3.8-flash'];
}

function calcEstimatedCost(inputTokens, cacheTokens, outputTokens, modelName) {
  const p = getModelPricing(modelName);
  const cost = (inputTokens * p.input + cacheTokens * p.cacheRead + outputTokens * p.output) / 1000000;
  return Math.round(cost * 10000) / 10000;
}

function getModelMaxWindow(modelName, promptTokens = 0) {
  let limit = 256000;
  if (modelName) {
    const m = String(modelName).toLowerCase();
    if (m.includes('argon') || m.includes('gemini-4') || m.includes('pro')) {
      // Antigravity 2.30 中 Argon/Pro 模型物理支持 1M，但平台自动压缩安全阈值定为 512k (512,000)
      limit = 512000;
    } else if (m.includes('opus') || m.includes('sonnet') || m.includes('claude')) {
      // Claude Opus 5.5 / Sonnet 5.5 平台自动压缩安全阈值同为 512k (512,000)
      limit = 512000;
    } else if (m.includes('oss') || m.includes('gpt')) {
      limit = 128000;
    } else if (m.includes('flash')) {
      limit = 256000;
    }
  }
  // 容错动态逃逸：若实际 Prompt 大幅突破已知阈值（例如超过 1.15 倍），再阶梯式扩容
  if (promptTokens > limit * 1.15) {
    if (promptTokens > 1000000) {
      limit = 2000000;
    } else {
      limit = 1000000;
    }
  }
  return limit;
}

const MODEL_SELECTION_REGEX = /setting [`'"]?Model Selection[`'"]? from .+? to (.+?)(?:\.\s*(?:No need|If reporting)|<\/USER_SETTINGS_CHANGE>|\.\s*$)/i;

function detectConversationModel(convId) {
  let model = '';
  if (convId) {
    const p = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(p)) {
      try {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        for (const line of lines) {
          if (line.includes('Model Selection')) {
            const m = line.match(MODEL_SELECTION_REGEX);
            if (m && m[1]) {
              model = m[1].replace(/\.+$/, '').trim();
            }
          }
        }
      } catch (e) {}
    }
  }
  if (model) return model;

  const cliSettings = path.join(APP_DATA_DIR, '..', 'antigravity-cli', 'settings.json');
  if (fs.existsSync(cliSettings)) {
    try {
      const s = JSON.parse(fs.readFileSync(cliSettings, 'utf8'));
      if (s.model) return s.model;
    } catch (e) {}
  }
  return 'Gemini 3.8 Flash';
}

function parseTranscript(logPath, maxWindow = 256000) {
  if (!fs.existsSync(logPath)) return null;
  let logMtimeMs = 0;
  try {
    logMtimeMs = fs.statSync(logPath).mtimeMs;
  } catch (e) {}

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  let turns = 0;
  let steps = 0;
  let latestPlanner = null;
  let prevPlanner = null;
  const plannerHistory = [];
  const convId = path.basename(path.dirname(path.dirname(path.dirname(logPath))));
  let currentModel = detectConversationModel(convId);
  let sessionCost = 0;
  let sessionInputTokens = 0;
  let sessionCacheTokens = 0;
  let sessionOutputTokens = 0;
  let sessionThinkingTokens = 0;
  let sessionResponseTokens = 0;
  let compactionsCount = 0;
  let totalReclaimedTokens = 0;
  let lastPromptBeforeDrop = 0;
  let lastCompaction = null;
  let userChars = 0;
  let agentChars = 0;
  let toolChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    try {
      const item = JSON.parse(raw);
      if (item.step_index && item.step_index > steps) {
        steps = item.step_index;
      }
      if (item.type === 'USER_INPUT') {
        turns++;
        userChars += (item.content || '').length;
        if (item.content && item.content.includes('Model Selection')) {
          const m = item.content.match(MODEL_SELECTION_REGEX);
          if (m && m[1]) {
            currentModel = m[1].replace(/\.+$/, '').trim();
          }
        }
      } else if (item.type === 'PLANNER_RESPONSE') {
        prevPlanner = latestPlanner;
        latestPlanner = item;
        agentChars += (item.content || '').length + (item.thinking || '').length;
        const input = item.input_tokens || 0;
        const cache = item.cache_read_tokens || 0;
        const output = item.output_tokens || 0;
        sessionInputTokens += input;
        sessionCacheTokens += cache;
        sessionOutputTokens += output;
        const prompt = input + cache;
        const hitRate = prompt > 0 ? (cache / prompt) * 100 : 0;

        const stepCost = calcEstimatedCost(input, cache, output, currentModel);
        sessionCost += stepCost;

        // Split thinking vs response tokens
        const thinkEst = estimateTokensFromText(item.thinking || '');
        const contentEst = estimateTokensFromText(item.content || '') + estimateTokensFromText(JSON.stringify(item.tool_calls || ''));
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

        // Check for compaction drop (> 40k drop from previous peak)
        if (lastPromptBeforeDrop > 50000 && prompt < lastPromptBeforeDrop - 40000) {
          const reclaimed = lastPromptBeforeDrop - prompt;
          compactionsCount++;
          totalReclaimedTokens += reclaimed;
          lastCompaction = {
            stepIndex: item.step_index || 0,
            beforeTokens: lastPromptBeforeDrop,
            afterTokens: prompt,
            reclaimedTokens: reclaimed,
            dropPercent: Math.round((reclaimed / lastPromptBeforeDrop) * 1000) / 10,
            reductionPercent: Math.round((reclaimed / lastPromptBeforeDrop) * 1000) / 10,
            time: item.created_at || ''
          };
        }
        lastPromptBeforeDrop = prompt;

        let finishTime = '';
        let durationSec = null;
        let isToolRunning = false;
        let runningToolName = '';
        const tStart = item.created_at ? new Date(item.created_at).getTime() : 0;
        const hasTools = Boolean(item.tool_calls && item.tool_calls.length > 0);

        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          const rawNext = lines[j]?.trim();
          if (!rawNext) continue;
          try {
            const nextItem = JSON.parse(rawNext);
            if (nextItem.created_at && tStart > 0) {
              const tEnd = new Date(nextItem.created_at).getTime();
              const dur = Math.round((tEnd - tStart) / 1000);
              if (nextItem.type === 'USER_INPUT') {
                const estDur = Math.max(1, Math.round((item.output_tokens || 100) / 120));
                durationSec = (dur >= 1 && dur <= estDur * 1.5) ? dur : estDur;
                finishTime = new Date(tStart + durationSec * 1000).toISOString();
              } else if (dur >= 0) {
                durationSec = dur;
                finishTime = nextItem.created_at;
              }
              break;
            }
          } catch (e) {}
        }

        if (!finishTime && tStart > 0) {
          const elapsedSec = (Date.now() - tStart) / 1000;
          const estDur = Math.max(1, Math.round((item.output_tokens || 50) / 120));

          if (hasTools && elapsedSec < 120) {
            isToolRunning = true;
            runningToolName = item.tool_calls[0]?.name || 'tool';
            finishTime = '';
            durationSec = null;
          } else {
            let dur = estDur;
            if (logMtimeMs > tStart) {
              const mtimeDur = Math.round((logMtimeMs - tStart) / 1000);
              if (mtimeDur >= 1 && mtimeDur <= Math.max(45, estDur * 2.5)) {
                dur = mtimeDur;
              }
            }
            durationSec = dur;
            finishTime = new Date(tStart + durationSec * 1000).toISOString();
          }
        }

        plannerHistory.push({
          step: item.step_index || 0,
          startTime: item.created_at || '',
          finishTime,
          durationSec,
          isToolRunning,
          runningToolName,
          time: item.created_at || '',
          input,
          cache,
          output,
          thinking: stepThinking,
          response: stepResponse,
          isCacheHit: cache > 0,
          tokensSaved: cache,
          totalPrompt: prompt,
          cacheHitRate: Math.round(hitRate * 10) / 10,
          model: currentModel
        });
      } else if (item.type === 'GENERIC') {
        toolChars += (item.content || '').length;
      }
    } catch (e) {}
  }

  const detectedModel = currentModel;
  const estimatedCost = Math.round(sessionCost * 10000) / 10000;

  if (!latestPlanner) {
    return {
      turns,
      steps,
      model: detectedModel,
      detectedModel,
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
      contextPercent: 0,
      tokPerSec: 0,
      estimatedCost: 0,
      compactions: { count: 0, totalReclaimedTokens: 0, lastCompaction: null },
      compaction: { count: 0, totalReclaimedTokens: 0, lastCompaction: null },
      history: []
    };
  }

  const input = latestPlanner.input_tokens || 0;
  const cache = latestPlanner.cache_read_tokens || 0;
  const output = latestPlanner.output_tokens || 0;
  const totalPrompt = input + cache;
  const stepCacheHitRate = totalPrompt > 0 ? (cache / totalPrompt) * 100 : 0;
  const sessionTotalPrompt = sessionInputTokens + sessionCacheTokens;
  const sessionCacheHitRate = sessionTotalPrompt > 0 ? (sessionCacheTokens / sessionTotalPrompt) * 100 : 0;

  // 自适应上下文上限：根据模型与当前实际Prompt动态计算（支持 Antigravity 2.30 的 Argon 1M 窗口）
  const modelLimit = getModelMaxWindow(detectedModel || currentModel, totalPrompt);
  const effectiveMaxWindow = (!maxWindow || maxWindow === 256000 || totalPrompt > maxWindow) ? modelLimit : maxWindow;
  const contextPercent = effectiveMaxWindow > 0 ? (totalPrompt / effectiveMaxWindow) * 100 : 0;

  const lastThinkEst = estimateTokensFromText(latestPlanner.thinking || '');
  const lastContentEst = estimateTokensFromText(latestPlanner.content || '') + estimateTokensFromText(JSON.stringify(latestPlanner.tool_calls || ''));
  let latestThinking = 0;
  let latestResponse = output;
  if (lastThinkEst + lastContentEst > 0 && output > 0) {
    latestThinking = Math.min(output, Math.round((lastThinkEst / (lastThinkEst + lastContentEst)) * output));
    latestResponse = output - latestThinking;
  } else if (lastThinkEst > 0) {
    latestThinking = Math.min(output, lastThinkEst);
    latestResponse = Math.max(0, output - latestThinking);
  }

  const tpsSamples = [];
  const ttftSamples = [];
  const userTtftSamples = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const rawCurr = lines[i]?.trim();
    const rawNext = lines[i + 1]?.trim();
    if (!rawCurr || !rawNext) continue;
    try {
      const curr = JSON.parse(rawCurr);
      const next = JSON.parse(rawNext);

      // TTFT: Record user prompt submission to model response start
      if (next.type === 'PLANNER_RESPONSE' && curr.type === 'USER_INPUT') {
        if (curr.created_at && next.created_at) {
          const diffSec = (new Date(next.created_at).getTime() - new Date(curr.created_at).getTime()) / 1000;
          if (diffSec > 0 && diffSec <= 30) {
            userTtftSamples.push(diffSec);
          }
        }
      }

      // Decode TPS: From PLANNER_RESPONSE to GENERIC (tool call trigger) or USER_INPUT
      // Strictly deducts TTFT (Prompt Prefill + Network Latency) from the decode window
      if (curr.type === 'PLANNER_RESPONSE' && (next.type === 'GENERIC' || next.type === 'USER_INPUT')) {
        const outTok = curr.output_tokens || 0;
        if (outTok > 10 && curr.created_at && next.created_at) {
          const tCurr = new Date(curr.created_at).getTime();
          const tNext = new Date(next.created_at).getTime();
          const durSec = (tNext - tCurr) / 1000;
          if (durSec >= 1 && (next.type !== 'USER_INPUT' || durSec <= 15)) {
            const uncached = curr.input_tokens || 0;
            const cached = curr.cache_read_tokens || 0;
            // Estimated TTFT for this step (network RTT + prefill for cached/uncached prompt tokens)
            const estTtft = Math.min(durSec * 0.65, Math.max(0.5, 0.8 + (uncached / 4000) + (cached / 80000)));
            const decodeSec = Math.max(0.2, durSec - estTtft);
            const stepTps = Math.round(outTok / decodeSec);
            if (stepTps > 0 && stepTps <= 800) {
              tpsSamples.push({ stepTps, outTok, durSec: decodeSec });
              ttftSamples.push(Math.round(estTtft * 10) / 10);
            }
          }
        }
      }
    } catch (e) {}
  }

  let tps = 0;
  let recentTps = 0;
  let peakTps = 0;
  if (tpsSamples.length > 0) {
    let totTok = 0, totSec = 0;
    for (const s of tpsSamples) {
      totTok += s.outTok;
      totSec += s.durSec;
      if (s.stepTps > peakTps) peakTps = s.stepTps;
    }
    tps = totSec > 0 ? Math.round(totTok / totSec) : 0;
    const recent = tpsSamples.slice(-10);
    let rTok = 0, rSec = 0;
    for (const s of recent) {
      rTok += s.outTok;
      rSec += s.durSec;
    }
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
  const tokPerSec = tps || recentTps;

  // Calculate detailed category breakdown (for 256k platform limit)
  const systemPromptTokens = 12500;
  const systemToolsTokens = 12600;
  const skillsTokens = 4300;
  const subagentsTokens = 686;
  const systemBase = systemPromptTokens + systemToolsTokens + skillsTokens + subagentsTokens;

  const totalDynChars = userChars + agentChars + toolChars;
  const dynamicTokens = Math.max(0, totalPrompt - systemBase);
  const userTokens = totalDynChars > 0 ? Math.round((userChars / totalDynChars) * dynamicTokens) : 0;
  const agentTokens = totalDynChars > 0 ? Math.round((agentChars / totalDynChars) * dynamicTokens) : 0;
  const toolTokens = Math.max(0, dynamicTokens - userTokens - agentTokens);
  const freeTokens = Math.max(0, effectiveMaxWindow - totalPrompt);

  const breakdown = {
    userMessages: userTokens,
    agentResponses: agentTokens,
    toolCalls: toolTokens,
    systemPrompt: systemPromptTokens,
    systemTools: systemToolsTokens,
    skills: skillsTokens,
    subagents: subagentsTokens,
    freeSpace: freeTokens,
    activePrompt: totalPrompt,
    maxWindow: effectiveMaxWindow,
    systemFiles: ['~/.gemini/GEMINI.md']
  };

  return {
    turns,
    steps,
    model: detectedModel,
    detectedModel,
    maxWindow: effectiveMaxWindow,
    inputTokens: input,
    cacheTokens: cache,
    totalPromptTokens: totalPrompt,
    outputTokens: output,
    thinkingTokens: latestThinking,
    responseTokens: latestResponse,
    sessionThinkingTokens,
    sessionResponseTokens,
    totalTokens: totalPrompt + output,
    cacheHitRate: Math.round(sessionCacheHitRate * 10) / 10,
    sessionCacheHitRate: Math.round(sessionCacheHitRate * 10) / 10,
    stepCacheHitRate: Math.round(stepCacheHitRate * 10) / 10,
    sessionInputTokens,
    sessionCacheTokens,
    sessionOutputTokens,
    sessionTotalTokens: sessionTotalPrompt + sessionOutputTokens,
    contextPercent: Math.round(contextPercent * 10) / 10,
    tokPerSec,
    tps,
    recentTps,
    peakTps,
    ttft,
    recentTtft,
    userTtft,
    estimatedCost,
    compactions: {
      count: compactionsCount,
      totalReclaimedTokens,
      reclaimedTokens: totalReclaimedTokens,
      lastCompaction
    },
    compaction: {
      count: compactionsCount,
      totalReclaimedTokens,
      reclaimedTokens: totalReclaimedTokens,
      lastCompaction
    },
    breakdown,
    history: plannerHistory.slice(-35)
  };
}

function getSubagentLiveStatus(mainConvId, subId, mainLogPath, subLogPath, meta = {}) {
  if (!fs.existsSync(subLogPath)) {
    return 'STOPPED';
  }

  try {
    const subStat = fs.statSync(subLogPath);
    const now = Date.now();

    // 1. Check descriptor (.system_generated/subagents/<subId>.json)
    let descriptorKilled = false;
    const subDescDir = path.join(BRAIN_DIR, mainConvId, '.system_generated', 'subagents');
    const subDescFile = path.join(subDescDir, `${subId}.json`);
    if (fs.existsSync(subDescFile)) {
      try {
        const subData = JSON.parse(fs.readFileSync(subDescFile, 'utf8'));
        if (subData.state === 'SUBAGENT_STATE_KILLED') descriptorKilled = true;
      } catch (e) {}
    }

    // 2. Read subagent transcript
    const subLines = fs.readFileSync(subLogPath, 'utf8').trim().split('\n').filter(Boolean);
    if (subLines.length === 0) return 'STOPPED';

    const firstItem = JSON.parse(subLines[0]);
    const lastItem = JSON.parse(subLines[subLines.length - 1]);
    const subSpawnTime = firstItem.created_at ? new Date(firstItem.created_at).getTime() : subStat.birthtimeMs;
    const subLastActiveTime = lastItem.created_at ? new Date(lastItem.created_at).getTime() : subStat.mtimeMs;
    const inactiveDuration = Math.max(0, now - subLastActiveTime);
    const modifiedRecently = inactiveDuration < 180000; // 3 min

    // 3. Check if subagent ever called send_message and when, and check for incoming messages from parent
    let subHasSentMessage = false;
    let subSendMessageTime = 0;
    let subLastReceivedTime = 0;
    for (let i = subLines.length - 1; i >= 0; i--) {
      try {
        const it = JSON.parse(subLines[i]);
        if (!subHasSentMessage && it.tool_calls && it.tool_calls.some(tc => tc.name === 'send_message')) {
          subHasSentMessage = true;
          if (it.created_at) subSendMessageTime = new Date(it.created_at).getTime();
        }
        if (!subLastReceivedTime && it.type === 'SYSTEM_MESSAGE' && it.content && it.content.includes(`sender=${mainConvId}`)) {
          if (it.created_at) subLastReceivedTime = new Date(it.created_at).getTime();
        }
        if (subHasSentMessage && subLastReceivedTime) break;
      } catch (e) {}
    }

    // 4. Scan parent log for kills, server restarts, and follow-up dispatches
    let parentKillTime = 0;
    let parentDispatchTime = subSpawnTime;
    let parentReplyTime = 0;
    let parentReceivedReply = false;

    if (fs.existsSync(mainLogPath)) {
      try {
        const mainLines = fs.readFileSync(mainLogPath, 'utf8').trim().split('\n').filter(Boolean);
        for (const ml of mainLines) {
          try {
            const item = JSON.parse(ml);
            const t = item.created_at ? new Date(item.created_at).getTime() : 0;
            if (item.tool_calls) {
              for (const tc of item.tool_calls) {
                if (tc.name === 'send_message') {
                  const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
                  const rec = String(args.Recipient || args.recipient || '').replace(/^["']|["']$/g, '').trim();
                  if (rec === subId || rec.includes(subId)) {
                    if (t > parentDispatchTime) parentDispatchTime = t;
                  }
                }
                if (tc.name === 'manage_subagents') {
                  const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
                  const action = (args.Action || args.action || '').toLowerCase();
                  if (action === 'kill_all') {
                    if (t > parentKillTime) parentKillTime = t;
                  } else if (action === 'kill') {
                    const idsStr = JSON.stringify(args.ConversationIds || args.conversationIds || args.ConversationId || args.conversationId || '');
                    if (idsStr.includes(subId)) {
                      if (t > parentKillTime) parentKillTime = t;
                    }
                  }
                }
                if (tc.name === 'manage_task') {
                  const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
                  if ((args.Action || args.action || '').toLowerCase() === 'kill') {
                    const tid = String(args.TaskId || args.taskId || '');
                    if (tid.includes(subId)) {
                      if (t > parentKillTime) parentKillTime = t;
                    }
                  }
                }
              }
            }
            if (item.content && typeof item.content === 'string') {
              if (item.content.includes('sender=' + subId)) {
                parentReceivedReply = true;
                if (t > parentReplyTime) parentReplyTime = t;
              }
              if (item.content.includes('All your subagents and background tasks have been stopped')) {
                if (t > parentKillTime) parentKillTime = t;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    const hasPendingWork = (parentDispatchTime > parentReplyTime && parentReplyTime > 0) ||
                          (subLastReceivedTime > subSendMessageTime && subSendMessageTime > 0);

    const hasActiveTools = Boolean(lastItem.tool_calls && lastItem.tool_calls.length > 0);
    const isGeneric = lastItem.type === 'GENERIC';
    const isPlanner = lastItem.type === 'PLANNER_RESPONSE';

    // 5. Active execution check (tool calls executing or model decoding next turn)
    if ((hasActiveTools && inactiveDuration < 180000) || (isGeneric && inactiveDuration < 120000)) {
      return 'RUNNING';
    }

    // If parent dispatched follow-up work and subagent is actively working
    if (hasPendingWork && inactiveDuration < 120000) {
      return 'RUNNING';
    }

    // 6. Instant completion check: message delivered back or parent confirmed receipt
    if ((subHasSentMessage || parentReceivedReply) && !hasPendingWork) {
      return 'DONE';
    }

    // 7. Explicit termination check (killed while still working)
    if (descriptorKilled) {
      return 'STOPPED';
    }
    if (parentKillTime >= subSpawnTime && parentDispatchTime <= parentKillTime) {
      return 'STOPPED';
    }

    // 8. Turn finished with no further tool calls
    if (isPlanner && !hasActiveTools) {
      return inactiveDuration >= 10000 ? 'DONE' : 'RUNNING';
    }

    // Recent activity within 30s
    if (inactiveDuration < 30000) {
      return 'RUNNING';
    }

    return 'STOPPED';
  } catch (err) {
    return 'DONE';
  }
}

const invokeCallsCache = new Map();

function getInvokeSubagentCalls(cid) {
  if (!cid) return [];

  const pFull = path.join(BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
  const pLog = path.join(BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript.jsonl');
  const targetFile = fs.existsSync(pFull) ? pFull : (fs.existsSync(pLog) ? pLog : null);
  if (!targetFile) return [];

  try {
    const mtime = fs.statSync(targetFile).mtimeMs;
    const cached = invokeCallsCache.get(cid);
    if (cached && cached.mtime === mtime) {
      return cached.calls;
    }

    const calls = [];
    const lines = fs.readFileSync(targetFile, 'utf8').split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('invoke_subagent')) continue;
      try {
        const item = JSON.parse(lines[i]);
        if (!item || !item.tool_calls) continue;
        for (const tc of item.tool_calls) {
          if (tc.name === 'invoke_subagent' && tc.args) {
            let subs = tc.args.Subagents || tc.args.subagents;
            if (!subs) {
              if (tc.args.Role || tc.args.role || tc.args.Model || tc.args.model || tc.args.TypeName || tc.args.typeName || tc.args.Prompt || tc.args.prompt) {
                subs = [tc.args];
              } else {
                subs = [];
              }
            } else {
              if (typeof subs === 'string') {
                try { subs = JSON.parse(subs); } catch (e) {}
              }
              if (!Array.isArray(subs)) subs = [subs];
            }

            // Scan subsequent lines for returned conversation IDs
            const returnedUuids = [];
            for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
              const matches = lines[j].match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
              if (matches) {
                for (const u of matches) {
                  if (!returnedUuids.includes(u) && u !== cid) returnedUuids.push(u);
                }
              }
            }

            subs.forEach((s, idx) => {
              calls.push({
                role: (s.Role || s.role || '').trim(),
                typeName: (s.TypeName || s.typeName || '').trim(),
                model: (s.Model || s.model || '').trim(),
                prompt: s.Prompt || s.prompt || '',
                uuid: returnedUuids[idx] || null,
                stepIndex: item.step_index
              });
            });
          }
        }
      } catch (e) {}
    }

    invokeCallsCache.set(cid, { mtime, calls });
    return calls;
  } catch (err) {
    return [];
  }
}

function resolveSubagentMetadata(subId, mainConvId, fallbackMeta = {}) {
  let role = fallbackMeta.role || 'Subagent Worker';
  let typeName = fallbackMeta.typeName || 'subagent';
  let rawModel = fallbackMeta.model || 'inherit';
  let parentId = mainConvId;

  // 1. Authoritative check: .system_generated/subagents/<subId>.json
  const subDescFile = path.join(BRAIN_DIR, mainConvId, '.system_generated', 'subagents', `${subId}.json`);
  if (fs.existsSync(subDescFile)) {
    try {
      const sd = JSON.parse(fs.readFileSync(subDescFile, 'utf8'));
      if (sd.subagentDescriptor?.role) role = sd.subagentDescriptor.role;
      if (sd.subagentDescriptor?.typeName) typeName = sd.subagentDescriptor.typeName;
      if (sd.subagentDescriptor?.model) rawModel = sd.subagentDescriptor.model;
    } catch (e) {}
  }

  // 2. Discover parent ID from subagent transcript if available
  const subLog = path.join(BRAIN_DIR, subId, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(subLog)) {
    try {
      const firstLine = fs.readFileSync(subLog, 'utf8').split('\n')[0];
      const obj = JSON.parse(firstLine);
      const m = (obj.content || '').match(/sender=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (m && m[1]) parentId = m[1];
    } catch (e) {}
  }

  // 3. If rawModel is inherit or role is default 'Subagent Worker', look up invoke_subagent in parent transcript(s)
  if (rawModel === 'inherit' || role === 'Subagent Worker') {
    const parentsToSearch = [parentId];
    if (mainConvId && !parentsToSearch.includes(mainConvId)) parentsToSearch.push(mainConvId);

    for (const pid of parentsToSearch) {
      const calls = getInvokeSubagentCalls(pid);
      if (!calls || calls.length === 0) continue;

      // Priority 1: Match by exact UUID returned by tool
      let match = calls.find(c => c.uuid && c.uuid.toLowerCase() === subId.toLowerCase());

      // Priority 2: Match by exact Role (case-insensitive) if role is known
      if (!match && role && role !== 'Subagent Worker') {
        match = calls.find(c => c.role.toLowerCase() === role.toLowerCase());
      }

      // Priority 3: Match by initial prompt snippet in subagent transcript
      if (!match && fs.existsSync(subLog)) {
        try {
          const firstLine = fs.readFileSync(subLog, 'utf8').split('\n')[0];
          const obj = JSON.parse(firstLine);
          const content = obj.content || '';
          if (content) {
            match = calls.find(c => c.prompt && content.includes(c.prompt.slice(0, 50)));
          }
        } catch (e) {}
      }

      if (match) {
        if (match.role && role === 'Subagent Worker') role = match.role;
        if (match.typeName && typeName === 'subagent') typeName = match.typeName;
        if (match.model) rawModel = match.model;
        break;
      }
    }
  }

  // Three standard model tiers requested by user: pro, flash, inherit
  const mLower = String(rawModel).toLowerCase();
  let modelName = 'Flash';
  let modelKey = 'flash';
  let modelBadge = '⚡ Flash';
  let modelDesc = '快速执行 · 如 Gemini 3.8 Flash';

  if (mLower === 'pro' || mLower.includes('argon')) {
    modelName = 'Pro';
    modelKey = 'pro';
    modelBadge = '🧠 Pro';
    modelDesc = '旗舰推理 · 如 Gemini 4 Argon';
  } else if (mLower === 'inherit') {
    modelName = 'Inherit';
    modelKey = 'inherit';
    modelBadge = '🔗 Inherit';
    const parentDetected = detectConversationModel(parentId);
    modelDesc = `继承主会话 · ${parentDetected}`;
  } else if (mLower === 'flash_lite') {
    modelName = 'Flash Lite';
    modelKey = 'flash_lite';
    modelBadge = '🪶 Flash Lite';
    modelDesc = '超轻量模型';
  } else if (mLower.includes('claude') || mLower.includes('sonnet') || mLower.includes('opus')) {
    modelName = rawModel;
    modelKey = 'pro';
    modelBadge = `✨ ${rawModel}`;
    modelDesc = rawModel;
  } else if (mLower.includes('gpt')) {
    modelName = rawModel;
    modelKey = 'flash';
    modelBadge = `🤖 ${rawModel}`;
    modelDesc = rawModel;
  }

  return { role, typeName, model: modelName, modelKey, modelBadge, modelDesc, rawModel, parentId };
}

function getSubagentsForConversation(mainConvId, maxWindow = 256000) {
  const mainLogPath = path.join(BRAIN_DIR, mainConvId, '.system_generated', 'logs', 'transcript.jsonl');
  const subagentsMap = new Map();

  // 1. Authoritative discovery: scan .system_generated/subagents/
  const subDir = path.join(BRAIN_DIR, mainConvId, '.system_generated', 'subagents');
  if (fs.existsSync(subDir)) {
    try {
      const files = fs.readdirSync(subDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const subData = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
          const sid = subData.conversationId || f.replace('.json', '');
          if (sid && !subagentsMap.has(sid)) {
            subagentsMap.set(sid, {
              id: sid,
              role: subData.subagentDescriptor?.role || 'Subagent Worker',
              typeName: subData.subagentDescriptor?.typeName || 'subagent',
              model: subData.subagentDescriptor?.model || 'inherit',
              state: subData.state || 'SUBAGENT_STATE_ALIVE',
              spawnStepIndex: subData.spawnStepIndex || 0
            });
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 2. Fallback / supplement: scan main transcript
  if (fs.existsSync(mainLogPath)) {
    try {
      const lines = fs.readFileSync(mainLogPath, 'utf8').trim().split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (item.tool_calls) {
            for (const tc of item.tool_calls) {
              if (tc.name === 'invoke_subagent' && tc.args) {
                let args = tc.args;
                if (typeof args === 'string') {
                  try { args = JSON.parse(args); } catch (e) {}
                }
                let subList = args.Subagents || args.subagents;
                if (!subList) {
                  if (args.Role || args.role || args.Model || args.model || args.TypeName || args.typeName || args.Prompt || args.prompt) {
                    subList = [args];
                  } else {
                    subList = [];
                  }
                } else {
                  if (typeof subList === 'string') {
                    try { subList = JSON.parse(subList); } catch (e) {}
                  }
                  if (!Array.isArray(subList)) subList = [subList];
                }
                for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                  try {
                    const nextItem = JSON.parse(lines[j]);
                    const text = (nextItem.content || '') + ' ' + JSON.stringify(nextItem);
                    const uuids = text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi) || [];
                    uuids.forEach((uuid, idx) => {
                      if (uuid !== mainConvId && !subagentsMap.has(uuid)) {
                        const def = subList[idx] || subList[0] || {};
                        subagentsMap.set(uuid, {
                          id: uuid,
                          role: def.Role || def.role || 'Subagent Worker',
                          typeName: def.TypeName || def.typeName || 'subagent',
                          model: def.Model || def.model || 'inherit',
                          spawnStepIndex: item.step_index || 0
                        });
                      }
                    });
                  } catch (e) {}
                }
              }
              if (tc.name === 'send_message' && tc.args) {
                let args = tc.args;
                if (typeof args === 'string') {
                  try { args = JSON.parse(args); } catch (e) {}
                }
                const rec = args.Recipient || args.recipient;
                if (rec && rec !== mainConvId && !subagentsMap.has(rec)) {
                  subagentsMap.set(rec, {
                    id: rec,
                    role: 'Subagent Worker',
                    typeName: 'subagent',
                    spawnStepIndex: item.step_index || 0
                  });
                }
              }
            }
          }
          if (item.content && typeof item.content === 'string') {
            const m = item.content.match(/sender=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (m && m[1] && m[1] !== mainConvId && !subagentsMap.has(m[1])) {
              subagentsMap.set(m[1], {
                id: m[1],
                role: 'Subagent Worker',
                typeName: 'subagent',
                spawnStepIndex: item.step_index || 0
              });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  const result = [];
  for (const [id, meta] of subagentsMap.entries()) {
    const subLog = path.join(BRAIN_DIR, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(subLog)) {
      try {
        // Verify it is a true subagent, not a top-level conversation
        const firstLine = fs.readFileSync(subLog, 'utf8').split('\n')[0];
        const firstObj = JSON.parse(firstLine);
        if (firstObj.source === 'USER_EXPLICIT' || firstObj.type === 'USER_INPUT') {
          continue;
        }

        const stats = parseTranscript(subLog, maxWindow);
        if (stats) {
          const liveStatus = getSubagentLiveStatus(mainConvId, id, mainLogPath, subLog, meta);
          const resolved = resolveSubagentMetadata(id, mainConvId, meta);
          result.push({
            id,
            role: resolved.role !== 'Subagent Worker' ? resolved.role : (meta.role || resolved.role),
            typeName: resolved.typeName !== 'subagent' ? resolved.typeName : (meta.typeName || resolved.typeName),
            model: resolved.model,
            modelKey: resolved.modelKey,
            modelBadge: resolved.modelBadge,
            modelDesc: resolved.modelDesc,
            rawModel: resolved.rawModel,
            spawnStepIndex: meta.spawnStepIndex || 0,
            steps: stats.steps,
            turns: stats.turns,
            status: liveStatus,
            tokPerSec: stats.tokPerSec || 0,
            tps: stats.tps || stats.tokPerSec || 0,
            recentTps: stats.recentTps || 0,
            ttft: stats.ttft || 0,
            recentTtft: stats.recentTtft || 0,
            inputTokens: stats.inputTokens,
            cacheTokens: stats.cacheTokens,
            totalPromptTokens: stats.totalPromptTokens,
            outputTokens: stats.outputTokens,
            thinkingTokens: stats.thinkingTokens,
            responseTokens: stats.responseTokens,
            sessionThinkingTokens: stats.sessionThinkingTokens,
            sessionResponseTokens: stats.sessionResponseTokens,
            totalTokens: stats.totalTokens,
            cacheHitRate: stats.cacheHitRate,
            sessionInputTokens: stats.sessionInputTokens,
            sessionCacheTokens: stats.sessionCacheTokens,
            sessionTotalTokens: stats.sessionTotalTokens,
            compactions: stats.compactions
          });
        }
      } catch (e) {}
    }
  }

  // Two-tier sort: RUNNING subagents first, then DONE/STOPPED, preserving intrinsic order within each tier
  result.forEach((item, idx) => { item._order = idx; });
  result.sort((a, b) => {
    const getPriority = (s) => (s === 'RUNNING' ? 0 : (s === 'DONE' ? 1 : 2));
    const pDiff = getPriority(a.status) - getPriority(b.status);
    if (pDiff !== 0) return pDiff;
    if (a.spawnStepIndex !== undefined && b.spawnStepIndex !== undefined && a.spawnStepIndex !== b.spawnStepIndex) {
      return a.spawnStepIndex - b.spawnStepIndex;
    }
    return (a._order || 0) - (b._order || 0);
  });

  return result;
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  logDebug(`Incoming request: ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/conversations') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConversations()));
    return;
  }

  if (pathname === '/api/stats') {
    const convs = getConversations();
    let targetId = reqUrl.searchParams.get('conversationId') ||
                   reqUrl.searchParams.get('conversation_id') ||
                   process.env.ANTIGRAVITY_CONVERSATION_ID;
    let target = null;
    if (targetId) {
      target = convs.find(c => c.id === targetId);
    }
    if (!target && convs.length > 0) {
      target = convs[0];
    }

    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No conversations found' }));
      return;
    }

    const reqMaxWindow = reqUrl.searchParams.get('max_window') ? parseInt(reqUrl.searchParams.get('max_window'), 10) : 0;
    const stats = parseTranscript(target.logPath, reqMaxWindow);
    const activeMaxWindow = stats?.maxWindow || 256000;
    const subagents = getSubagentsForConversation(target.id, reqMaxWindow || activeMaxWindow);

    let combinedTotalPrompt = stats.totalPromptTokens;
    let combinedOutputTokens = stats.outputTokens;
    let combinedThinkingTokens = stats.sessionThinkingTokens || 0;
    let combinedResponseTokens = stats.sessionResponseTokens || 0;
    let combinedSteps = stats.steps;
    let combinedSessionTokens = stats.sessionTotalTokens;
    let combinedInputTotal = stats.sessionInputTokens;
    let combinedCacheTotal = stats.sessionCacheTokens;
    let combinedCompactions = (stats.compactions?.count || 0);
    let combinedReclaimedTokens = (stats.compactions?.totalReclaimedTokens || 0);

    for (const sa of subagents) {
      combinedTotalPrompt += sa.totalPromptTokens || 0;
      combinedOutputTokens += sa.outputTokens || 0;
      combinedThinkingTokens += sa.sessionThinkingTokens || 0;
      combinedResponseTokens += sa.sessionResponseTokens || 0;
      combinedSteps += sa.steps || 0;
      combinedSessionTokens += sa.sessionTotalTokens || 0;
      combinedInputTotal += sa.sessionInputTokens || 0;
      combinedCacheTotal += sa.sessionCacheTokens || 0;
      combinedCompactions += (sa.compactions?.count || 0);
      combinedReclaimedTokens += (sa.compactions?.totalReclaimedTokens || 0);
    }

    const combinedAllPrompt = combinedInputTotal + combinedCacheTotal;
    const combinedCacheHitRate = combinedAllPrompt > 0 
      ? Math.round((combinedCacheTotal / combinedAllPrompt) * 1000) / 10 
      : stats.cacheHitRate;
    const combinedContextPercent = activeMaxWindow > 0 
      ? Math.round((combinedTotalPrompt / activeMaxWindow) * 1000) / 10 
      : 0;

    let speedSum = (stats.tps || stats.tokPerSec || 0);
    let speedCount = (stats.tps || stats.tokPerSec) > 0 ? 1 : 0;
    for (const sa of subagents) {
      const sTps = sa.tps || sa.tokPerSec || 0;
      if (sTps > 0) {
        speedSum += sTps;
        speedCount++;
      }
    }
    const combinedTps = speedCount > 0 ? Math.round(speedSum / speedCount) : (stats.tps || stats.tokPerSec || 0);

    let ttftSum = stats.ttft || 0;
    let ttftCount = stats.ttft > 0 ? 1 : 0;
    for (const sa of subagents) {
      if (sa.ttft > 0) {
        ttftSum += sa.ttft;
        ttftCount++;
      }
    }
    const combinedTtft = ttftCount > 0 ? Math.round((ttftSum / ttftCount) * 10) / 10 : (stats.ttft || 0);

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
      combinedReclaimedTokens
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      conversationId: target.id,
      updatedAt: target.updatedAtIso,
      ...stats,
      maxWindow: activeMaxWindow,
      subagents,
      allAgentsSummary
    }));
    return;
  }

  // Serve static UI for root and fallback
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Context Monitor Server Running</h1>');
  }
});

server.on('error', (err) => {
  logDebug(`Server error: ${err.message}`);
  console.error('Server error:', err);
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  logDebug(`Listening successfully on http://127.0.0.1:${actualPort}`);
  console.log(`Context Monitor listening on http://127.0.0.1:${actualPort}`);
});
