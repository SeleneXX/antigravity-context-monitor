import fs from 'fs';
import path from 'path';
import os from 'os';

const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.gemini/antigravity');
const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');

function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function getActiveTranscript() {
  const specifiedId = process.argv[2] || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  if (specifiedId) {
    const p = path.join(BRAIN_DIR, specifiedId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(p)) return { path: p, id: specifiedId };
  }

  if (!fs.existsSync(BRAIN_DIR)) return null;
  const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
  let latestFile = null;
  let latestMtime = 0;
  let activeId = '';

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logPath = path.join(BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(logPath)) {
      try {
        const firstLine = fs.readFileSync(logPath, 'utf8').split('\n')[0];
        const firstObj = JSON.parse(firstLine);
        // Exclude subagents from main conversation selection
        if (firstObj.source === 'SYSTEM' || firstObj.type === 'SYSTEM_MESSAGE') {
          continue;
        }

        const stat = fs.statSync(logPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestFile = logPath;
          activeId = entry.name;
        }
      } catch (e) {}
    }
  }

  return latestFile ? { path: latestFile, id: activeId } : null;
}

const active = getActiveTranscript();
if (!active) {
  console.log('未找到当前会话记录。');
  process.exit(0);
}

const MODEL_SELECTION_REGEX = /setting [`'"]?Model Selection[`'"]? from .+? to (.+?)(?:\.\s*(?:No need|If reporting)|<\/USER_SETTINGS_CHANGE>|\.\s*$)/i;

const lines = fs.readFileSync(active.path, 'utf8').split('\n');
let turns = 0;
let steps = 0;
let latestPlanner = null;
let totalInput = 0;
let totalCache = 0;
let totalOutput = 0;

let currentModel = 'Gemini 3.8 Flash';
const cliSettings = path.join(APP_DATA_DIR, '..', 'antigravity-cli', 'settings.json');
if (fs.existsSync(cliSettings)) {
  try {
    const s = JSON.parse(fs.readFileSync(cliSettings, 'utf8'));
    if (s.model) currentModel = s.model;
  } catch(e){}
}

let userChars = 0;
let agentChars = 0;
let toolChars = 0;
let sessionThinkingChars = 0;
let sessionContentChars = 0;
let compactionsCount = 0;
let totalReclaimedTokens = 0;
let lastPeakPrompt = 0;
let latestCompaction = null;

for (const line of lines) {
  const raw = line.trim();
  if (!raw) continue;
  try {
    const item = JSON.parse(raw);
    if (item.step_index && item.step_index > steps) steps = item.step_index;
    if (item.type === 'USER_INPUT') {
      turns++;
      userChars += (item.content || '').length;
      if (item.content && item.content.includes('Model Selection')) {
        const m = item.content.match(MODEL_SELECTION_REGEX);
        if (m && m[1]) {
          currentModel = m[1].replace(/\.+$/, '').trim();
        }
      }
    }
    if (item.type === 'PLANNER_RESPONSE') {
      latestPlanner = item;
      const cLen = (item.content || '').length;
      const tLen = (item.thinking || '').length;
      sessionContentChars += cLen;
      sessionThinkingChars += tLen;
      agentChars += cLen + tLen;

      const inTok = item.input_tokens || 0;
      const cTok = item.cache_read_tokens || 0;
      const curPrompt = inTok + cTok;
      if (lastPeakPrompt > 50000 && curPrompt < lastPeakPrompt - 40000) {
        const drop = lastPeakPrompt - curPrompt;
        compactionsCount++;
        totalReclaimedTokens += drop;
        latestCompaction = {
          fromTokens: lastPeakPrompt,
          toTokens: curPrompt,
          reclaimedTokens: drop,
          reductionPercent: Math.round((drop / lastPeakPrompt) * 1000) / 10
        };
      }
      lastPeakPrompt = curPrompt;

      const outTok = item.output_tokens || 0;
      totalInput += inTok;
      totalCache += cTok;
      totalOutput += outTok;
    }
    if (item.type === 'GENERIC') {
      toolChars += (item.content || '').length;
    }
  } catch (e) {}
}

let tps = 0;
let ttft = 0;
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

    // Decode TPS: Strictly deducts TTFT (Prompt Prefill + Network Latency) from the decode window
    if (curr.type === 'PLANNER_RESPONSE' && (next.type === 'GENERIC' || next.type === 'USER_INPUT')) {
      const outTok = curr.output_tokens || 0;
      if (outTok > 10 && curr.created_at && next.created_at) {
        const tCurr = new Date(curr.created_at).getTime();
        const tNext = new Date(next.created_at).getTime();
        const durSec = (tNext - tCurr) / 1000;
        if (durSec >= 1 && (next.type !== 'USER_INPUT' || durSec <= 15)) {
          const uncached = curr.input_tokens || 0;
          const cached = curr.cache_read_tokens || 0;
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
  } catch(e){}
}
if (tpsSamples.length > 0) {
  let totTok = 0, totSec = 0;
  for (const s of tpsSamples) { totTok += s.outTok; totSec += s.durSec; }
  tps = totSec > 0 ? Math.round(totTok / totSec) : 0;
}
if (ttftSamples.length > 0) {
  ttft = Math.round((ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length) * 10) / 10;
}

function getModelMaxWindow(modelName, promptTokens = 0) {
  let limit = 256000;
  if (modelName) {
    const m = String(modelName).toLowerCase();
    if (m.includes('argon') || m.includes('gemini-4') || m.includes('pro')) {
      limit = 1000000;
    } else if (m.includes('opus') || m.includes('sonnet') || m.includes('claude')) {
      limit = 200000;
    } else if (m.includes('oss') || m.includes('gpt')) {
      limit = 128000;
    } else if (m.includes('flash')) {
      limit = 256000;
    }
  }
  if (promptTokens > limit) {
    if (promptTokens > 1000000) {
      limit = 2000000;
    } else {
      limit = 1000000;
    }
  }
  return limit;
}

const detectedModel = currentModel;
const input = latestPlanner?.input_tokens || 0;
const cache = latestPlanner?.cache_read_tokens || 0;
const output = latestPlanner?.output_tokens || 0;
const prompt = input + cache;
const stepHit = prompt > 0 ? ((cache / prompt) * 100).toFixed(1) : '0.0';
const sessionPrompt = totalInput + totalCache;
const sessionHit = sessionPrompt > 0 ? ((totalCache / sessionPrompt) * 100).toFixed(1) : '0.0';
const maxWindow = getModelMaxWindow(detectedModel, prompt);
const pct = ((prompt / maxWindow) * 100).toFixed(1);

// Split thinking vs response tokens
const totChars = sessionThinkingChars + sessionContentChars;
const sessionThinkingTokens = totChars > 0 ? Math.round((sessionThinkingChars / totChars) * totalOutput) : 0;
const sessionResponseTokens = Math.max(0, totalOutput - sessionThinkingTokens);



// Category breakdown (matches agy cli /context)
const systemPromptTokens = 12500;
const systemToolsTokens = 12600;
const skillsTokens = 4300;
const subagentsTokens = 686;
const systemBase = systemPromptTokens + systemToolsTokens + skillsTokens + subagentsTokens;

const totalDynChars = userChars + agentChars + toolChars;
const dynamicTokens = Math.max(0, prompt - systemBase);
const userTokens = totalDynChars > 0 ? Math.round((userChars / totalDynChars) * dynamicTokens) : 0;
const agentTokens = totalDynChars > 0 ? Math.round((agentChars / totalDynChars) * dynamicTokens) : 0;
const toolTokens = Math.max(0, dynamicTokens - userTokens - agentTokens);
const freeTokens = Math.max(0, maxWindow - prompt);

// Subagents discovery
const subagentsMap = new Map();
const subDir = path.join(BRAIN_DIR, active.id, '.system_generated', 'subagents');
if (fs.existsSync(subDir)) {
  try {
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const subData = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
        const sid = subData.conversationId || f.replace('.json', '');
        if (sid && !subagentsMap.has(sid)) {
          subagentsMap.set(sid, {
            id: sid,
            role: subData.subagentDescriptor?.role || 'Subagent Worker',
            typeName: subData.subagentDescriptor?.typeName || 'subagent',
            state: subData.state || 'SUBAGENT_STATE_ALIVE',
            spawnStepIndex: subData.spawnStepIndex || 0
          });
        }
      } catch(e){}
    }
  } catch(e){}
}

// Fallback scan from main transcript
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  try {
    const item = JSON.parse(line);
    if (item.tool_calls) {
      for (const tc of item.tool_calls) {
        if (tc.name === 'invoke_subagent' && tc.args) {
          let args = tc.args;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch(e){} }
          let subList = args.Subagents || args.subagents;
          if (!subList) {
            if (args.Role || args.role || args.Model || args.model || args.TypeName || args.typeName || args.Prompt || args.prompt) {
              subList = [args];
            } else {
              subList = [];
            }
          } else {
            if (typeof subList === 'string') { try { subList = JSON.parse(subList); } catch(e){} }
            if (!Array.isArray(subList)) subList = [subList];
          }
          for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
            try {
              const nextItem = JSON.parse(lines[j]);
              const text = (nextItem.content || '') + ' ' + JSON.stringify(nextItem);
              const uuids = text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi) || [];
              uuids.forEach((uuid, idx) => {
                if (uuid !== active.id && !subagentsMap.has(uuid)) {
                  const def = subList[idx] || subList[0] || {};
                  subagentsMap.set(uuid, {
                    id: uuid,
                    role: def.Role || def.role || 'Subagent Worker',
                    typeName: def.TypeName || def.typeName || 'subagent'
                  });
                }
              });
            } catch(e){}
          }
        }
      }
    }
  } catch(e){}
}

// Also scan sender messages from tool outputs or system messages
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  try {
    const item = JSON.parse(line);
    if (item.content && typeof item.content === 'string') {
      const m = item.content.match(/sender=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (m && m[1] && m[1] !== active.id && !subagentsMap.has(m[1])) {
        subagentsMap.set(m[1], { id: m[1], role: 'Subagent Worker', typeName: 'subagent' });
      }
    }
  } catch(e){}
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

  const mLower = String(rawModel).toLowerCase();
  let modelName = 'Flash';
  let modelBadge = '⚡ Flash';

  if (mLower === 'pro' || mLower.includes('argon')) {
    modelName = 'Pro';
    modelBadge = '🧠 Pro';
  } else if (mLower === 'inherit') {
    modelName = 'Inherit';
    modelBadge = '🔗 Inherit';
  } else if (mLower === 'flash_lite') {
    modelName = 'Flash Lite';
    modelBadge = '🪶 Flash Lite';
  } else if (mLower.includes('claude') || mLower.includes('sonnet') || mLower.includes('opus')) {
    modelName = rawModel;
    modelBadge = `✨ ${rawModel}`;
  }

  return { role, typeName, model: modelName, modelBadge, rawModel };
}

const subagentsList = [];
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

      const subStat = fs.statSync(subLog);
      const subLines = fs.readFileSync(subLog, 'utf8').trim().split('\n').filter(Boolean);
      let subSteps = 0, subInput = 0, subCache = 0, subOutput = 0;
      let subSessInput = 0, subSessCache = 0, subSessOutput = 0;
      let subHasSentMessage = false;
      const genSteps = [];

      for (let i = 0; i < subLines.length; i++) {
        try {
          const sit = JSON.parse(subLines[i]);
          if (sit.type === 'PLANNER_RESPONSE') {
            subSteps++;
            subInput = sit.input_tokens || 0;
            subCache = sit.cache_read_tokens || 0;
            subOutput = sit.output_tokens || 0;
            subSessInput += subInput;
            subSessCache += subCache;
            subSessOutput += subOutput;
            if (sit.tool_calls && sit.tool_calls.some(tc => tc.name === 'send_message')) {
              subHasSentMessage = true;
            }

            // Measure generation duration to next step (deducting TTFT for pure decode TPS)
            if (i < subLines.length - 1) {
              const nextSit = JSON.parse(subLines[i + 1]);
              if (sit.created_at && nextSit.created_at && (sit.output_tokens || 0) > 20) {
                const dur = (new Date(nextSit.created_at).getTime() - new Date(sit.created_at).getTime()) / 1000;
                if (dur >= 1 && dur <= 180) {
                  const subUncached = sit.input_tokens || 0;
                  const subCached = sit.cache_read_tokens || 0;
                  const estTtft = Math.min(dur * 0.65, Math.max(0.5, 0.8 + (subUncached / 4000) + (subCached / 80000)));
                  const decodeDur = Math.max(0.2, dur - estTtft);
                  genSteps.push({ outTok: sit.output_tokens, dur: decodeDur });
                }
              }
            }
          }
        } catch(e){}
      }

      let subTokPerSec = 0;
      if (genSteps.length > 0) {
        const win = genSteps.slice(-10);
        const winTok = win.reduce((sum, s) => sum + s.outTok, 0);
        const winDur = win.reduce((sum, s) => sum + s.dur, 0);
        if (winDur > 0) subTokPerSec = Math.round(winTok / winDur);
      }

      const subPrompt = subInput + subCache;
      const subSessTotal = subSessInput + subSessCache + subSessOutput;
      const subHitRate = (subSessInput + subSessCache) > 0 
        ? Math.round((subSessCache / (subSessInput + subSessCache)) * 1000) / 10 
        : 0;

      let descriptorState = (meta.state || '').toUpperCase();
      const subDescFile = path.join(BRAIN_DIR, active.id, '.system_generated', 'subagents', `${id}.json`);
      if (fs.existsSync(subDescFile)) {
        try {
          const sd = JSON.parse(fs.readFileSync(subDescFile, 'utf8'));
          if (sd.state === 'SUBAGENT_STATE_KILLED') descriptorState = 'SUBAGENT_STATE_KILLED';
        } catch(e){}
      }

      let status = 'DONE';
      if (descriptorState === 'SUBAGENT_STATE_KILLED') {
        status = 'STOPPED';
      } else {
        const firstItem = subLines.length > 0 ? JSON.parse(subLines[0]) : {};
        const lastItem = subLines.length > 0 ? JSON.parse(subLines[subLines.length - 1]) : {};
        const subSpawnTime = firstItem.created_at ? new Date(firstItem.created_at).getTime() : subStat.birthtimeMs;
        const subLastActiveTime = lastItem.created_at ? new Date(lastItem.created_at).getTime() : subStat.mtimeMs;
        const inactiveDuration = Math.max(0, Date.now() - subLastActiveTime);
        const modifiedRecently = inactiveDuration < 180000;

        let subSendMessageTime = 0;
        let subLastReceivedTime = 0;
        for (let j = subLines.length - 1; j >= 0; j--) {
          try {
            const it = JSON.parse(subLines[j]);
            if (!subSendMessageTime && it.tool_calls && it.tool_calls.some(tc => tc.name === 'send_message')) {
              if (it.created_at) subSendMessageTime = new Date(it.created_at).getTime();
            }
            if (!subLastReceivedTime && it.type === 'SYSTEM_MESSAGE' && it.content && it.content.includes(`sender=${active.id}`)) {
              if (it.created_at) subLastReceivedTime = new Date(it.created_at).getTime();
            }
            if (subSendMessageTime && subLastReceivedTime) break;
          } catch(e){}
        }

        let parentKillTime = 0;
        let parentDispatchTime = subSpawnTime;
        let parentReplyTime = 0;

        try {
          const mainLines = fs.readFileSync(active.path, 'utf8').trim().split('\n');
          for (const ml of mainLines) {
            try {
              const item = JSON.parse(ml);
              const t = item.created_at ? new Date(item.created_at).getTime() : 0;
              if (item.tool_calls) {
                for (const tc of item.tool_calls) {
                  if (tc.name === 'manage_subagents') {
                    const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
                    const action = (args.Action || args.action || '').toLowerCase();
                    if (action === 'kill_all') {
                      if (t > parentKillTime) parentKillTime = t;
                    } else if (action === 'kill') {
                      const idsStr = JSON.stringify(args.ConversationIds || args.conversationIds || args.ConversationId || args.conversationId || '');
                      if (idsStr.includes(id)) {
                        if (t > parentKillTime) parentKillTime = t;
                      }
                    }
                  }
                  if (tc.name === 'send_message') {
                    const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
                    const rec = String(args.Recipient || args.recipient || '').replace(/^["']|["']$/g, '').trim();
                    if (rec === id || rec.includes(id)) {
                      if (t > parentDispatchTime) parentDispatchTime = t;
                    }
                  }
                }
              }
              if (item.content && typeof item.content === 'string') {
                if (item.content.includes('sender=' + id)) {
                  if (t > parentReplyTime) parentReplyTime = t;
                }
                if (item.content.includes('All your subagents and background tasks have been stopped')) {
                  if (t > parentKillTime) parentKillTime = t;
                }
              }
            } catch(e){}
          }
        } catch(e){}

        const hasPendingWork = (parentDispatchTime > parentReplyTime && parentReplyTime > 0) ||
                              (subLastReceivedTime > subSendMessageTime && subSendMessageTime > 0);

        if (parentKillTime >= subSpawnTime && subLastActiveTime <= parentKillTime + 5000 && parentDispatchTime <= parentKillTime) {
          status = 'STOPPED';
        } else if (hasPendingWork || (subHasSentMessage && subLastActiveTime > subSendMessageTime + 2000 && modifiedRecently)) {
          status = inactiveDuration < 300000 ? 'RUNNING' : 'STOPPED';
        } else if (subHasSentMessage && !hasPendingWork && subLastActiveTime <= subSendMessageTime + 2000) {
          status = 'DONE';
        } else if (subHasSentMessage) {
          status = 'DONE';
        } else if (modifiedRecently) {
          status = 'RUNNING';
        } else if ((lastItem.type === 'GENERIC' || lastItem.type === 'PLANNER_RESPONSE') && inactiveDuration < 300000) {
          status = 'RUNNING';
        } else {
          status = 'STOPPED';
        }
      }

      const resolved = resolveSubagentMetadata(id, active.id, meta);

      subagentsList.push({
        id,
        role: resolved.role,
        typeName: resolved.typeName,
        modelBadge: resolved.modelBadge,
        modelName: resolved.model,
        status,
        steps: subSteps,
        tokPerSec: subTokPerSec,
        prompt: subPrompt,
        hitRate: subHitRate,
        totalTokens: subSessTotal
      });
    } catch(e){}
  }
}

// Two-tier sort: RUNNING subagents first, then DONE/STOPPED, preserving intrinsic order within each tier
subagentsList.forEach((item, idx) => { item._order = idx; });
subagentsList.sort((a, b) => {
  const getPriority = (s) => (s === 'RUNNING' ? 0 : (s === 'DONE' ? 1 : 2));
  const pDiff = getPriority(a.status) - getPriority(b.status);
  if (pDiff !== 0) return pDiff;
  if (a.spawnStepIndex !== undefined && b.spawnStepIndex !== undefined && a.spawnStepIndex !== b.spawnStepIndex) {
    return a.spawnStepIndex - b.spawnStepIndex;
  }
  return (a._order || 0) - (b._order || 0);
});

let colorIcon = '🟢';
if (parseFloat(pct) > 80) colorIcon = '🔴';
else if (parseFloat(pct) > 50) colorIcon = '🟡';

const stepHitSuffix = stepHit === '0.0' ? ' (冷启动/新前缀)' : ` (本步 ${stepHit}%)`;
console.log(`⏱️ **${turns} turns · ${steps} steps** | 💾 **${formatNumber(prompt)} tok · Cache hit ${sessionHit}%**${stepHitSuffix} | ${colorIcon} **${pct}%** (${formatNumber(prompt)} / ${formatNumber(maxWindow)})`);
const tpsTtftStr = tps > 0 ? ` | ⚡ **TPS**: ${tps} tok/s · **TTFT**: ${ttft > 0 ? ttft + 's' : '--'}` : '';
console.log(`⚡ **当前模型**: ${detectedModel}${tpsTtftStr} | 🧠 **思考**: ${formatNumber(sessionThinkingTokens)} tok · 💬 **正文**: ${formatNumber(sessionResponseTokens)} tok`);

if (compactionsCount > 0) {
  const lastInfo = latestCompaction ? ` (最近一次: 释放 ${formatNumber(latestCompaction.reclaimedTokens)} tok, -${latestCompaction.reductionPercent}%)` : '';
  console.log(`⚡ **平台压缩记录**: 已触发 ${compactionsCount} 次自动压缩 · 累计释放 ${formatNumber(totalReclaimedTokens)} tokens${lastInfo}`);
}

console.log(`\n**Token usage by category (安全阈值 ${maxWindow.toLocaleString()}):**`);
console.log(`  ◎ User messages: ${formatNumber(userTokens)} tokens (${((userTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  ◎ Agent responses: ${formatNumber(agentTokens)} tokens (${((agentTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  ◎ Tool calls & outputs: ${formatNumber(toolTokens)} tokens (${((toolTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  🗄️ System prompt: 12.5k tokens (${((systemPromptTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  🗄️ System tools: 12.6k tokens (${((systemToolsTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  🗄️ Skills: 4.3k tokens (${((skillsTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  🗄️ Subagents (可用声明): 686 tokens (${((subagentsTokens / maxWindow) * 100).toFixed(1)}%)`);
console.log(`  ◻ Free space: ${formatNumber(freeTokens)} (${((freeTokens / maxWindow) * 100).toFixed(1)}%)`);

if (subagentsList.length > 0) {
  console.log(`\n**🤖 Subagents 集群详情 (${subagentsList.length} 个子智能体):**`);
  for (const sa of subagentsList) {
    const statusTag = sa.status === 'RUNNING' ? '🔄 RUNNING' : (sa.status === 'DONE' ? '✅ DONE' : '⏹️ STOPPED');
    const speedStr = sa.tokPerSec > 0 ? ` | ${sa.tokPerSec} tok/s` : '';
    console.log(`  • ${sa.role} [${sa.typeName} · ${sa.modelBadge}] (${statusTag}): ${sa.steps} steps${speedStr} | ${formatNumber(sa.prompt)} prompt | Cache hit ${sa.hitRate}% | 总吞吐 ${formatNumber(sa.totalTokens)} tok`);
  }
} else {
  console.log(`\n🛡️ **Subagent 隔离态**: 当前会话由主 Agent 独立执行 (暂无子智能体任务)`);
}

console.log(`\n[📊 打开侧边栏实时监控面板](sidecar://context-monitor/monitor/)`);
