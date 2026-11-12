import { getSessionSnapshot } from '../../../core/analyzer.mjs';

function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

const specifiedId = process.argv[2] || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
const snapshot = getSessionSnapshot({ conversationId: specifiedId, force: true });

if (!snapshot) {
  console.log('未找到当前会话记录。');
  process.exit(0);
}

const {
  turns,
  steps,
  detectedModel,
  maxWindow,
  totalPromptTokens: prompt,
  sessionCacheHitRate: sessionHit,
  stepCacheHitRate: stepHit,
  contextPercent: pct,
  tps,
  ttft,
  sessionThinkingTokens,
  sessionResponseTokens,
  compactions,
  breakdown: b,
  subagents = [],
} = snapshot;

let colorIcon = '🟢';
if (pct > 80) colorIcon = '🔴';
else if (pct > 50) colorIcon = '🟡';

const stepHitSuffix = !stepHit ? ' (冷启动/新前缀)' : ` (本步 ${stepHit}%)`;
console.log(
  `⏱️ **${turns} turns · ${steps} steps** | 💾 **${formatNumber(prompt)} tok · Cache hit ${sessionHit}%**${stepHitSuffix} | ${colorIcon} **${pct}%** (${formatNumber(prompt)} / ${formatNumber(maxWindow)})`
);

const tpsTtftStr = tps > 0 ? ` | ⚡ **TPS**: ${tps} tok/s · **TTFT**: ${ttft > 0 ? ttft + 's' : '--'}` : '';
console.log(
  `⚡ **当前模型**: ${detectedModel}${tpsTtftStr} | 🧠 **思考**: ${formatNumber(sessionThinkingTokens)} tok · 💬 **正文**: ${formatNumber(sessionResponseTokens)} tok`
);

if (compactions && compactions.count > 0) {
  const last = compactions.lastCompaction;
  const lastInfo = last
    ? ` (最近一次: 释放 ${formatNumber(last.reclaimedTokens)} tok, -${last.reductionPercent}%)`
    : '';
  console.log(
    `⚡ **平台压缩记录**: 已触发 ${compactions.count} 次自动压缩 · 累计释放 ${formatNumber(compactions.totalReclaimedTokens)} tokens${lastInfo}`
  );
}

if (b) {
  const pctStr = (val) => ((val / maxWindow) * 100).toFixed(1);
  console.log(`\n**Token usage by category (安全阈值 ${maxWindow.toLocaleString()}):**`);
  console.log(`  ◎ User messages: ${formatNumber(b.userMessages)} tokens (${pctStr(b.userMessages)}%)`);
  console.log(`  ◎ Agent responses: ${formatNumber(b.agentResponses)} tokens (${pctStr(b.agentResponses)}%)`);
  console.log(`  ◎ Tool calls & outputs: ${formatNumber(b.toolCalls)} tokens (${pctStr(b.toolCalls)}%)`);
  console.log(`  🗄️ System prompt: ${formatNumber(b.systemPrompt)} tokens (${pctStr(b.systemPrompt)}%)`);
  console.log(`  🗄️ System tools: ${formatNumber(b.systemTools)} tokens (${pctStr(b.systemTools)}%)`);
  console.log(`  🗄️ Skills: ${formatNumber(b.skills)} tokens (${pctStr(b.skills)}%)`);
  console.log(`  🗄️ Subagents (可用声明): ${formatNumber(b.subagents)} tokens (${pctStr(b.subagents)}%)`);
  console.log(`  ◻ Free space: ${formatNumber(b.freeSpace)} (${pctStr(b.freeSpace)}%)`);
}

if (subagents.length > 0) {
  console.log(`\n**🤖 Subagents 集群详情 (${subagents.length} 个子智能体):**`);
  for (const sa of subagents) {
    const detailSuffix = sa.status === 'RUNNING' && sa.statusDetail ? ` · ${sa.statusDetail}` : '';
    const statusTag =
      sa.status === 'RUNNING'
        ? `🔄 RUNNING${detailSuffix}`
        : sa.status === 'DONE'
          ? '✅ DONE'
          : '⏹️ STOPPED';
    const speedStr = sa.tokPerSec > 0 ? ` | ${sa.tokPerSec} tok/s` : '';
    console.log(
      `  • ${sa.role} [${sa.typeName} · ${sa.modelBadge}] (${statusTag}): ${sa.steps} steps${speedStr} | ${formatNumber(sa.totalPromptTokens)} prompt | Cache hit ${sa.cacheHitRate}% | 总吞吐 ${formatNumber(sa.sessionTotalTokens)} tok`
    );
  }
} else {
  console.log(`\n🛡️ **Subagent 隔离态**: 当前会话由主 Agent 独立执行 (暂无子智能体任务)`);
}

console.log(`\n[📊 打开侧边栏实时监控面板](sidecar://context-monitor/monitor/)`);
