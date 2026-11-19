(function () {
  const POLL_INTERVAL_MS = 1500;
  let statsTab = 'main';
  let lastData = null;
  let initialUiVersion = window.__MONITOR_UI_VERSION__ || null;
  let toastTimer = null;

  function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '';
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    } catch {
      return '';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const CACHE_TIER_CLASSES = [
    'cache-tier-miss',
    'cache-tier-critical',
    'cache-tier-low',
    'cache-tier-moderate',
    'cache-tier-good',
    'cache-tier-optimal',
  ];

  // 与后端 core/models.mjs 保持严格一致的六档缓存命中率分级（优先使用后端下发的 cacheGrade）
  function getCacheTier(ratePercent, cacheTokens = null, serverGrade = null) {
    if (serverGrade && serverGrade.key) {
      return serverGrade;
    }
    const rate = Number(ratePercent) || 0;
    const isZero = cacheTokens !== null && cacheTokens !== undefined ? cacheTokens <= 0 : rate <= 0;
    if (isZero || rate <= 0) return { key: 'miss', label: '未命中', range: '0%' };
    if (rate < 40) return { key: 'critical', label: '极低', range: '0~40%' };
    if (rate < 60) return { key: 'low', label: '偏低', range: '40~60%' };
    if (rate < 80) return { key: 'moderate', label: '一般', range: '60~80%' };
    if (rate < 95) return { key: 'good', label: '良好', range: '80~95%' };
    return { key: 'optimal', label: '极佳', range: '95%+' };
  }

  function applyCacheTierClass(el, tier) {
    if (!el || !tier) return;
    el.classList.remove(...CACHE_TIER_CLASSES);
    el.classList.add(`cache-tier-${tier.key}`);
  }

  function getQueryContext() {
    const params = new URLSearchParams(window.location.search);
    return {
      convId: params.get('conversationId') || params.get('conversation_id') || '',
      token: params.get('token') || '',
    };
  }

  function buildApiUrl(pathname, extraParams = {}) {
    const { convId, token } = getQueryContext();
    const q = new URLSearchParams();
    if (convId) q.set('conversationId', convId);
    if (token) q.set('token', token);
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null && v !== '') {
        q.set(k, String(v));
      }
    }
    const qs = q.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  // 保留网关鉴权参数执行无缓存整页刷新
  function hardReloadPage() {
    const url = new URL(window.location.href);
    url.searchParams.set('_r', String(Date.now()));
    window.location.replace(url.toString());
  }

  function showToast(msg) {
    const el = document.getElementById('refreshToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('visible');
    }, 1800);
  }

  async function fetchStats({ force = false } = {}) {
    try {
      const url = buildApiUrl('/api/stats', force ? { force: '1', _t: Date.now() } : { _t: Date.now() });
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();

      // 若检测到磁盘上的前端模板/样式/脚本已发生修改，自动热重载视图
      if (data.uiVersion) {
        if (!initialUiVersion) {
          initialUiVersion = data.uiVersion;
        } else if (data.uiVersion !== initialUiVersion) {
          hardReloadPage();
          return true;
        }
      }

      lastData = data;
      renderDashboard(data);
      return true;
    } catch (err) {
      console.error('Context Monitor fetch error:', err);
      return false;
    }
  }

  function renderTopBar(data, currentWindow) {
    document.getElementById('barTurns').textContent = data.turns || 0;
    document.getElementById('barSteps').textContent = data.steps || 0;
    const currentSpeed = data.tps || data.streamingTps || data.tokPerSec || 0;
    document.getElementById('barSpeed').textContent = currentSpeed > 0 ? currentSpeed : '--';
    document.getElementById('barTotalTokens').textContent = formatNumber(data.totalPromptTokens || 0);

    const sessionRate = data.sessionCacheHitRate ?? data.cacheHitRate ?? 0;
    const sessionTier = getCacheTier(sessionRate, data.sessionCacheTokens, data.sessionCacheGrade);
    const barHitEl = document.getElementById('barCacheHit');
    barHitEl.textContent = `${sessionRate}%`;
    applyCacheTierClass(barHitEl, sessionTier);

    document.getElementById('barPercent').textContent = `${data.contextPercent || 0}%`;

    const hitTitle = `【主 Agent】累计缓存分级: ${sessionTier.label} (${sessionTier.range}) | 当前活跃 Prompt: ${formatNumber(data.totalPromptTokens || 0)} tok | 安全阈值: ${formatNumber(currentWindow)} | 会话累计吞吐: ${formatNumber(data.sessionTotalTokens || 0)} tok`;
    document.getElementById('barCacheStat')?.setAttribute('title', hitTitle);

    const miniCircum = 56.54;
    const pct = Math.min(100, Math.max(0, data.contextPercent || 0));
    const miniEl = document.getElementById('miniCircle');
    miniEl.style.strokeDashoffset = miniCircum - (pct / 100) * miniCircum;
    miniEl.style.stroke = pct > 80 ? 'var(--accent-red)' : pct > 50 ? 'var(--accent-amber)' : 'var(--accent-green)';
  }

  function renderCompactionBanner(data) {
    const banner = document.getElementById('compactionBanner');
    const textEl = document.getElementById('compactionText');
    const comp = data.compaction || data.compactions;
    if (banner && comp && comp.count > 0) {
      banner.style.display = 'flex';
      const last = comp.lastCompaction;
      const lastInfo = last
        ? ` (最近一次: 释放 ${formatNumber(last.reclaimedTokens || 0)} tok，压缩率 -${last.reductionPercent ?? last.dropPercent ?? 0}%)`
        : '';
      const totalRec = comp.totalReclaimedTokens ?? comp.reclaimedTokens ?? 0;
      textEl.innerHTML = `已检测到 <strong>${comp.count}</strong> 次系统上下文压缩 · 累计释放 <strong>${formatNumber(totalRec)}</strong> tokens${lastInfo}`;
    } else if (banner) {
      banner.style.display = 'none';
    }
  }

  function renderGauge(data, currentWindow) {
    const pct = Math.min(100, Math.max(0, data.contextPercent || 0));
    const bigCircum = 251.32;
    const bigEl = document.getElementById('bigGauge');
    bigEl.style.strokeDashoffset = bigCircum - (pct / 100) * bigCircum;
    bigEl.style.stroke = pct > 80 ? 'var(--accent-red)' : pct > 50 ? 'var(--accent-amber)' : 'var(--accent-blue)';

    document.getElementById('gaugePct').textContent = `${data.contextPercent || 0}%`;
    document.getElementById('promptTokDisplay').textContent = (data.totalPromptTokens || 0).toLocaleString();
    document.getElementById('maxWindowDisplay').textContent = currentWindow.toLocaleString();
    document.getElementById('thresholdLabel').textContent = `平台压缩安全阈值 (${formatNumber(currentWindow)} 满额截断)`;

    const modelName = data.detectedModel || data.model || 'Gemini 3.8 Flash';
    document.getElementById('modelDisplayPill').textContent = `⚡ ${modelName}`;

    const totalPrompt = data.totalPromptTokens || 1;
    const cachePct = ((data.cacheTokens || 0) / totalPrompt) * 100;
    const inputPct = ((data.inputTokens || 0) / totalPrompt) * 100;
    document.getElementById('barCachePart').style.width = `${cachePct}%`;
    document.getElementById('barInputPart').style.width = `${inputPct}%`;
    document.getElementById('legendCache').textContent = formatNumber(data.cacheTokens || 0);
    document.getElementById('legendInput').textContent = formatNumber(data.inputTokens || 0);
  }

  function renderStatsTiles(data, subList) {
    const summary = data.allAgentsSummary || {};
    document.getElementById('statsSubCountBadge').textContent = subList.length;
    if (data.conversationId) {
      document.getElementById('convIdShort').textContent = data.conversationId.slice(0, 8);
    }

    // 主 Agent 视图（累计命中率 + 最新单步命中率同步六档着色）
    const sessionRate = data.sessionCacheHitRate ?? data.cacheHitRate ?? 0;
    const sessionTier = getCacheTier(sessionRate, data.sessionCacheTokens, data.sessionCacheGrade);
    const cardHitEl = document.getElementById('cardHitRate');
    cardHitEl.textContent = `${sessionRate}%`;
    applyCacheTierClass(cardHitEl, sessionTier);
    cardHitEl.setAttribute('title', `累计缓存分级: ${sessionTier.label} (${sessionTier.range})`);

    let stepHitHtml = '';
    if (data.stepCacheHitRate !== undefined) {
      const stepTier = getCacheTier(data.stepCacheHitRate, data.cacheTokens, data.stepCacheGrade);
      const stepLabel =
        stepTier.key === 'miss'
          ? '0% (冷预填充)'
          : `${data.stepCacheHitRate}%`;
      stepHitHtml = ` · 最新步: <span class="cache-tier-${stepTier.key}" style="font-weight:600" title="最新单步分级: ${stepTier.label} (${stepTier.range})">${stepLabel}</span>`;
    }
    document.getElementById('cardHitRateSub').innerHTML = `累计命中: ${formatNumber(data.sessionCacheTokens || 0)} tok${stepHitHtml}`;

    document.getElementById('cardTotalTok').textContent = formatNumber(data.sessionTotalTokens || data.totalTokens || 0);
    document.getElementById('cardSessionThinkBreakdown').textContent = `🧠 思考: ${formatNumber(data.sessionThinkingTokens || 0)} · 💬 正文: ${formatNumber(data.sessionResponseTokens || 0)}`;

    const tpsVal = data.tps || data.streamingTps || data.tokPerSec || 0;
    const medTpsVal = data.recentTps || data.medianTps || tpsVal;
    const peakTpsVal = data.peakTps || medTpsVal || tpsVal;
    document.getElementById('cardTps').textContent = tpsVal > 0 ? `${tpsVal} tok/s` : '--';
    document.getElementById('cardTpsSub').textContent =
      tpsVal > 0
        ? `近5步中位: ${medTpsVal} tok/s · 峰值: ${peakTpsVal} tok/s`
        : '近5步中位: -- · 峰值: --';
    const tileTpsEl = document.getElementById('tileTps');
    if (tileTpsEl) {
      const srcNote = data.speedSource === 'sqlite' ? 'SQLite 原生实测' : (data.speedSource === 'estimated' ? '日志时间戳估算' : '暂无样本');
      tileTpsEl.setAttribute(
        'title',
        `最新纯流式: ${tpsVal} tok/s | 近5步中位: ${medTpsVal} tok/s | 历史峰值: ${peakTpsVal} tok/s | 全程流式均值: ${data.sessionAvgTps || tpsVal} tok/s | 数据源: ${srcNote}`
      );
    }

    document.getElementById('cardTtft').textContent = data.ttft > 0 ? `${data.ttft}s` : '--';
    const rTtft = data.recentTtft > 0 ? `${data.recentTtft}s` : '--';
    const uTtft = data.userTtft > 0 ? `${data.userTtft}s` : '--';
    document.getElementById('cardTtftSub').textContent = `近5步中位: ${rTtft} · 用户响应: ${uTtft}`;
    const tileTtftEl = document.getElementById('tileTtft');
    if (tileTtftEl) {
      tileTtftEl.setAttribute(
        'title',
        `最新单步首字延迟: ${data.ttft > 0 ? data.ttft + 's' : '--'} | 近5步中位数: ${rTtft} | 用户提问后首字: ${uTtft}`
      );
    }

    // 全量汇总视图
    const allRate = summary.combinedCacheHitRate ?? data.cacheHitRate ?? 0;
    const allCacheTok = summary.combinedCacheTokens ?? data.sessionCacheTokens ?? 0;
    const allTier = getCacheTier(allRate, allCacheTok, summary.combinedCacheGrade);
    const cardAllHitEl = document.getElementById('cardAllHitRate');
    cardAllHitEl.textContent = `${allRate}%`;
    applyCacheTierClass(cardAllHitEl, allTier);
    cardAllHitEl.setAttribute('title', `全量综合缓存分级: ${allTier.label} (${allTier.range})`);
    document.getElementById('cardAllHitRateSub').textContent = `全量命中: ${formatNumber(allCacheTok)} tok · 含全部 Subagents`;
    document.getElementById('cardAllTotalTok').textContent = formatNumber(summary.combinedSessionTokens || data.sessionTotalTokens || 0);
    document.getElementById('cardAllOutputBreakdown').textContent = `🧠 思考: ${formatNumber(summary.combinedThinkingTokens || data.sessionThinkingTokens || 0)} · 💬 正文: ${formatNumber(summary.combinedResponseTokens || data.sessionResponseTokens || 0)}`;

    const allTpsVal = summary.combinedTps || summary.combinedTokPerSec || tpsVal;
    const allPeakVal = summary.combinedPeakTps || peakTpsVal || allTpsVal;
    document.getElementById('cardAllTps').textContent = allTpsVal > 0 ? `${allTpsVal} tok/s` : '--';
    document.getElementById('cardAllTpsSub').textContent = `集群峰值: ${allPeakVal > 0 ? allPeakVal + ' tok/s' : '--'} · 主 + ${summary.subagentsCount ?? subList.length} 个 Subagents`;

    const allTtftVal = summary.combinedTtft > 0 ? `${summary.combinedTtft}s` : data.ttft > 0 ? `${data.ttft}s` : '--';
    document.getElementById('cardAllTtft').textContent = allTtftVal;

    document.getElementById('statsMainView').style.display = statsTab === 'all' ? 'none' : 'grid';
    document.getElementById('statsAllView').style.display = statsTab === 'all' ? 'grid' : 'none';
  }

  function renderSubagents(subList) {
    const runningCount = subList.filter((s) => s.status === 'RUNNING').length;
    const waitingCount = subList.filter((s) => s.status === 'WAITING').length;
    const headerBadge = document.getElementById('subagentsHeaderBadge');
    const stateNotes = [];
    if (runningCount > 0) stateNotes.push(`${runningCount} 运行中`);
    if (waitingCount > 0) stateNotes.push(`${waitingCount} 待命`);
    headerBadge.textContent =
      stateNotes.length > 0 ? `${subList.length} 个子智能体 (${stateNotes.join(' · ')})` : `${subList.length} 个子智能体`;

    const container = document.getElementById('subagentsContent');
    if (!subList || subList.length === 0) {
      container.innerHTML = `
        <div class="subagent-empty">
          <div class="subagent-empty-icon">🛡️</div>
          <div class="subagent-empty-title">当前会话未唤起 Subagent / Workflow / Swarm</div>
          <div class="subagent-empty-desc">
            所有任务均在主 Agent 上下文中完成。当唤起 <code>invoke_subagent</code>、<code>run_workflow</code> 或启用 <code>Swarm Mode</code> 时，各子智能体与 Worker 的独立 Token 消耗、看板待命态与真实模型层级将在此实时呈现。
          </div>
        </div>
      `;
      return;
    }

    // 保持滚动条纵向位置，避免 1.5 秒定时轮询重绘导致滚动跳回顶部
    const prevScrollTop = container.scrollTop;

    const cardsHtml = subList
      .map((sa) => {
        let statusClass = 'done';
        let statusText = 'DONE';
        let cardExtraClass = '';
        if (sa.status === 'RUNNING') {
          statusClass = 'running';
          statusText = sa.statusDetail ? `RUNNING · ${sa.statusDetail}` : 'RUNNING';
          cardExtraClass = 'running';
        } else if (sa.status === 'WAITING') {
          statusClass = 'waiting';
          statusText = sa.statusDetail ? `WAITING · ${sa.statusDetail}` : 'WAITING · 看板待命';
        } else if (sa.status === 'STOPPED') {
          statusClass = 'stopped';
          statusText = sa.statusDetail && sa.statusDetail !== '已中止' ? `STOPPED · ${sa.statusDetail}` : 'STOPPED';
        }

        const speedVal = sa.tps || sa.tokPerSec || 0;
        const speedHtml = speedVal > 0 ? `${speedVal} tok/s` : '--';
        const ttftHtml = sa.ttft > 0 ? ` <span style="font-size:10px;color:var(--accent-blue)">(${sa.ttft}s)</span>` : '';
        const speedTitle = speedVal > 0
          ? `最新纯流式: ${speedVal} tok/s · 近5步中位: ${sa.medianTps || speedVal} tok/s · 峰值: ${sa.peakTps || speedVal} tok/s`
          : '暂无速度样本';
        const saRate = sa.cacheHitRate || 0;
        const saTier = getCacheTier(saRate, sa.sessionCacheTokens, sa.cacheGrade);
        const wsTagHtml =
          sa.workspaceMode && sa.workspaceMode !== 'inherit'
            ? `<span class="workspace-tag">${escapeHtml(sa.workspaceMode)}</span>`
            : '';
        const wfTagHtml = sa.isWorkflow
          ? `<span class="workflow-tag" title="${escapeHtml(sa.workflowDescription || 'Dynamic Workflow Agent')}">WORKFLOW</span>`
          : '';
        const roleIcon = sa.isSwarm ? '🐝' : sa.isWorkflow ? '🔀' : '🤖';

        return `
          <div class="subagent-card ${cardExtraClass}">
            <div class="subagent-header">
              <div class="subagent-title">
                <span>${roleIcon} ${escapeHtml(sa.role || 'Subagent Worker')}</span>
                ${wfTagHtml}
                <span class="type-tag">${escapeHtml(sa.typeName || 'subagent')}</span>
                ${wsTagHtml}
                <span class="model-tag model-${escapeHtml(sa.modelKey || 'flash')}">${escapeHtml(sa.modelBadge || sa.model || '⚡ Flash')}</span>
              </div>
              <span class="status-tag ${statusClass}">${escapeHtml(statusText)}</span>
            </div>
            <div class="subagent-metrics">
              <div class="subagent-metric-item">
                <span class="metric-lbl">执行步骤</span>
                <span class="metric-val">${sa.steps || 0} steps</span>
              </div>
              <div class="subagent-metric-item">
                <span class="metric-lbl">活跃 Prompt</span>
                <span class="metric-val">${formatNumber(sa.totalPromptTokens || 0)}</span>
              </div>
              <div class="subagent-metric-item" title="缓存分级: ${escapeHtml(saTier.label)} (${escapeHtml(saTier.range)}) · 累计命中 ${formatNumber(sa.sessionCacheTokens || 0)} tok">
                <span class="metric-lbl">Cache 命中率</span>
                <span class="metric-val cache-tier-${saTier.key}">${saRate}%</span>
              </div>
              <div class="subagent-metric-item">
                <span class="metric-lbl">思考 / 正文</span>
                <span class="metric-val" style="color:#c0caf5">🧠${formatNumber(sa.sessionThinkingTokens || 0)} / 💬${formatNumber(sa.sessionResponseTokens || 0)}</span>
              </div>
              <div class="subagent-metric-item" title="${escapeHtml(speedTitle)}">
                <span class="metric-lbl">生成速度 · TTFT</span>
                <span class="metric-val" style="color:var(--accent-purple)">${speedHtml}${ttftHtml}</span>
              </div>
              <div class="subagent-metric-item">
                <span class="metric-lbl">累计 Token</span>
                <span class="metric-val">${formatNumber(sa.sessionTotalTokens || sa.totalTokens || 0)}</span>
              </div>
            </div>
            <div class="subagent-meta">
              <span>UUID: ${escapeHtml((sa.id || '').slice(0, 8))}...${escapeHtml((sa.id || '').slice(-4))}</span>
              <span>模型层级: <strong style="color:#c0caf5">${escapeHtml(sa.modelBadge || sa.model || '⚡ Flash')}</strong>${sa.modelDesc ? ` <span style="color:var(--text-muted)">(${escapeHtml(sa.modelDesc)})</span>` : ''}</span>
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `<div class="subagent-list">${cardsHtml}</div>`;
    container.scrollTop = prevScrollTop;
  }

  function renderBreakdown(data, currentWindow) {
    const b = data.breakdown;
    if (!b) return;

    const total = data.totalPromptTokens || 0;
    const max = b.maxWindow || currentWindow || 256000;
    const pct = ((total / max) * 100).toFixed(1);
    document.getElementById('breakdownModelBadge').textContent = `${formatNumber(total)} / ${formatNumber(max)} (${pct}%)`;

    const dotVal = max / 200;
    document.getElementById('matrixTitle').textContent = `Context Usage Map (点阵图 · 200格 · 每格 ${formatNumber(Math.round(dotVal))} tok / 0.5%)`;

    const fmtPct = (v) => ((v / max) * 100).toFixed(1);
    document.getElementById('catUser').textContent = `${formatNumber(b.userMessages)} tokens (${fmtPct(b.userMessages)}%)`;
    document.getElementById('catAgent').textContent = `${formatNumber(b.agentResponses)} tokens (${fmtPct(b.agentResponses)}%)`;
    document.getElementById('catTools').textContent = `${formatNumber(b.toolCalls)} tokens (${fmtPct(b.toolCalls)}%)`;
    document.getElementById('catSysPrompt').textContent = `${formatNumber(b.systemPrompt)} tokens (${fmtPct(b.systemPrompt)}%)`;
    document.getElementById('catSysTools').textContent = `${formatNumber(b.systemTools)} tokens (${fmtPct(b.systemTools)}%)`;
    document.getElementById('catSkills').textContent = `${formatNumber(b.skills)} tokens (${fmtPct(b.skills)}%)`;
    document.getElementById('catSubagents').textContent = `${formatNumber(b.subagents)} tokens (${fmtPct(b.subagents)}%)`;
    document.getElementById('catFree').textContent = `${formatNumber(b.freeSpace)} (${fmtPct(b.freeSpace)}%)`;

    const segments = [
      { count: Math.round(b.userMessages / dotVal), color: '#7aa2f7', title: `User messages: ${formatNumber(b.userMessages)}` },
      { count: Math.round(b.agentResponses / dotVal), color: '#9ece6a', title: `Agent responses: ${formatNumber(b.agentResponses)}` },
      { count: Math.round(b.toolCalls / dotVal), color: '#e0af68', title: `Tool calls & outputs: ${formatNumber(b.toolCalls)}` },
      { count: Math.max(1, Math.round(b.systemPrompt / dotVal)), color: '#bb9af7', title: `System prompt: ${formatNumber(b.systemPrompt)}` },
      { count: Math.max(1, Math.round(b.systemTools / dotVal)), color: '#7dcfff', title: `System tools: ${formatNumber(b.systemTools)}` },
      { count: Math.round(b.skills / dotVal), color: '#f7768e', title: `Skills: ${formatNumber(b.skills)}` },
      { count: Math.round(b.subagents / dotVal), color: '#ff9e64', title: `Subagents: ${formatNumber(b.subagents)}` },
    ];

    const dotTypes = [];
    for (const seg of segments) {
      for (let i = 0; i < seg.count && dotTypes.length < 200; i++) {
        dotTypes.push(seg);
      }
    }

    let dotsHtml = '';
    for (let i = 0; i < 200; i++) {
      if (i < dotTypes.length) {
        dotsHtml += `<div class="dot-square" style="background:${dotTypes[i].color}" title="${escapeHtml(dotTypes[i].title)}"></div>`;
      } else {
        dotsHtml += `<div class="dot-square" style="background:#20222e;border:1px solid #2d3040" title="Free space"></div>`;
      }
    }
    document.getElementById('dotMatrix').innerHTML = dotsHtml;
  }

  function renderHistory(history) {
    const historyBody = document.getElementById('historyBody');
    if (!history || history.length === 0) {
      historyBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:12px;color:#666">暂无历史记录</td></tr>';
      return;
    }

    historyBody.innerHTML = history
      .slice()
      .reverse()
      .map((item) => {
        const startTimeStr = formatTime(item.startTime || item.time);
        const finishTimeStr = formatTime(item.finishTime);
        let timeCell = '';

        if (startTimeStr && finishTimeStr) {
          const dur = item.durationSec != null && item.durationSec >= 0 ? `${item.durationSec}s` : '';
          const ttftPart = item.ttftSec !== null && item.ttftSec !== undefined ? `TTFT ${item.ttftSec}s` : '';
          const subMeta = [dur ? `耗时 ${dur}` : '', ttftPart].filter(Boolean).join(' · ');
          timeCell = `
            <div style="display:flex;flex-direction:column;gap:1px;">
              <span style="color:#c0caf5;font-family:monospace;font-size:11px;white-space:nowrap;">${startTimeStr} → ${finishTimeStr}</span>
              ${subMeta ? `<span style="color:var(--text-muted);font-size:9.5px;">${subMeta}</span>` : ''}
            </div>
          `;
        } else if (item.isToolRunning) {
          const tName = item.runningToolName ? ` (${escapeHtml(item.runningToolName)})` : '';
          timeCell = `
            <div style="display:flex;flex-direction:column;gap:1px;">
              <span style="color:#c0caf5;font-family:monospace;font-size:11px;white-space:nowrap;">${startTimeStr} → 执行中</span>
              <span style="color:var(--accent-blue);font-size:9.5px;">⚙️ 工具运行中${tName}...</span>
            </div>
          `;
        } else if (startTimeStr) {
          timeCell = `
            <div style="display:flex;flex-direction:column;gap:1px;">
              <span style="color:#c0caf5;font-family:monospace;font-size:11px;white-space:nowrap;">${startTimeStr} → 已完成</span>
              <span style="color:var(--accent-green);font-size:9.5px;">已完成</span>
            </div>
          `;
        } else {
          timeCell = `<span style="color:var(--text-muted);font-size:11px;">--</span>`;
        }

        const tier = getCacheTier(item.cacheHitRate, item.cache, item.cacheGrade);
        const tierTip = `缓存分级: ${escapeHtml(tier.label)} (${escapeHtml(tier.range)}) · 命中 ${formatNumber(item.cache || 0)} / 新输入 ${formatNumber(item.input || 0)}`;
        const hitBadge = `<span class="cache-badge cache-tier-${tier.key}" title="${tierTip}"><span class="cache-badge-dot"></span>${tier.key === 'miss' ? 'MISS' : 'HIT'}</span>`;

        const thinkTok = item.thinking || 0;
        const respTok = item.response || 0;
        const stepSpeedTip =
          item.streamingTps > 0
            ? `纯流式: ${item.streamingTps} tok/s${item.streamingSec ? ` · 流式耗时 ${item.streamingSec}s` : ''}${item.ttftSec !== null && item.ttftSec !== undefined ? ` · TTFT ${item.ttftSec}s` : ''}`
            : '';
        const stepSpeedHtml =
          item.streamingTps > 0
            ? ` <span class="step-speed-badge" title="${escapeHtml(stepSpeedTip)}">⚡${item.streamingTps}</span>`
            : '';

        return `
          <tr>
            <td><span class="step-badge">#${item.step}</span></td>
            <td>${timeCell}</td>
            <td><strong>${(item.totalPrompt || 0).toLocaleString()}</strong></td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;" title="${tierTip}">
                ${hitBadge}
                <span class="cache-tier-${tier.key}" style="font-weight:600;">${item.cacheHitRate}%</span>
                <span style="color:var(--text-muted);font-size:10px;">(${formatNumber(item.cache || 0)})</span>
              </div>
            </td>
            <td>
              <div style="display:flex;flex-direction:column;gap:1px;">
                <span style="color:#c0caf5;font-weight:600;font-family:monospace;">${(item.output || 0).toLocaleString()}${stepSpeedHtml}</span>
                <span style="color:var(--text-muted);font-size:9.5px;">🧠 ${formatNumber(thinkTok)} · 💬 ${formatNumber(respTok)}</span>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  function renderDashboard(data) {
    if (!data) return;
    const currentWindow = data.maxWindow || 256000;
    const subList = data.subagents || [];

    renderTopBar(data, currentWindow);
    renderCompactionBanner(data);
    renderGauge(data, currentWindow);
    renderStatsTiles(data, subList);
    renderSubagents(subList);
    renderBreakdown(data, currentWindow);
    renderHistory(data.history || []);
  }

  // 统计详情 Tab 切换
  document.getElementById('tabStatsMain')?.addEventListener('click', () => {
    statsTab = 'main';
    document.getElementById('tabStatsMain').classList.add('active');
    document.getElementById('tabStatsAll').classList.remove('active');
    if (lastData) renderDashboard(lastData);
  });

  document.getElementById('tabStatsAll')?.addEventListener('click', () => {
    statsTab = 'all';
    document.getElementById('tabStatsAll').classList.add('active');
    document.getElementById('tabStatsMain').classList.remove('active');
    if (lastData) renderDashboard(lastData);
  });

  // 右上角强制刷新：触发后端热重载与缓存清空，若静态文件变更或按住 Shift 则整页刷新
  document.getElementById('refreshBtn')?.addEventListener('click', async (ev) => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spin-anim');
    try {
      const reloadRes = await fetch(buildApiUrl('/api/reload', { _t: Date.now() }), {
        method: 'POST',
        cache: 'no-store',
      });
      if (ev.shiftKey) {
        hardReloadPage();
        return;
      }
      if (reloadRes.ok) {
        const reloadInfo = await reloadRes.json();
        if (reloadInfo.uiVersion && initialUiVersion && reloadInfo.uiVersion !== initialUiVersion) {
          hardReloadPage();
          return;
        }
      }
      const ok = await fetchStats({ force: true });
      showToast(ok ? '✓ 已强刷同步' : '刷新重试中');
    } catch {
      hardReloadPage();
    } finally {
      setTimeout(() => btn.classList.remove('spin-anim'), 450);
    }
  });

  fetchStats({ force: false });
  setInterval(() => fetchStats({ force: false }), POLL_INTERVAL_MS);

  // ============================================================================
  // 个人中心 Popup：全局历史 Token 账本、52 周热力图、模型测速榜与订阅回本核算
  // ============================================================================
  const ledgerState = {
    open: false,
    loading: false,
    data: null,
    source: 'all',
    tab: 'activity',
    chartMode: 'weekly',
    yearScope: 'rolling',
    speedMetric: 'streamingTps',
    selectedModelKey: '',
    billingPeriod: 'month',
  };

  let cfgToastTimer = null;
  let popoverHideTimer = null;

  function formatLocalYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseYmdLocal(ymd) {
    const [y, m, d] = String(ymd || '').split('-').map(Number);
    if (!y || !m || !d) return new Date();
    return new Date(y, m - 1, d);
  }

  function addDays(dateObj, offset) {
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate() + offset);
  }

  function formatCostPair(usdVal, usdToCny) {
    const usd = Number(usdVal) || 0;
    const cny = usd * (Number(usdToCny) || 7.25);
    return {
      usdStr: `$${usd.toFixed(2)}`,
      cnyStr: `¥${cny.toFixed(2)}`,
    };
  }

  function getActiveView() {
    if (!ledgerState.data?.views) return null;
    return ledgerState.data.views[ledgerState.source] || ledgerState.data.views.all;
  }

  function getActiveThemeColors() {
    const themes = ledgerState.data?.heatmapThemes || {};
    const key = ledgerState.data?.settings?.heatmapTheme || 'emerald';
    return themes[key]?.colors || ['#1e202b', '#0e4429', '#006d32', '#26a641', '#39d353'];
  }

  function showLedgerPopover(anchorEl, html) {
    const pop = document.getElementById('ledgerPopover');
    if (!pop || !anchorEl) return;
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    pop.innerHTML = html;
    pop.classList.add('visible');
    pop.setAttribute('aria-hidden', 'false');

    const rect = anchorEl.getBoundingClientRect();
    const popW = pop.offsetWidth || 200;
    const popH = pop.offsetHeight || 84;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - popW / 2, window.innerWidth - popW - 8));
    let top = rect.top - popH - 8;
    if (top < 8) {
      top = Math.min(window.innerHeight - popH - 8, rect.bottom + 8);
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function hideLedgerPopover(delay = 0) {
    const pop = document.getElementById('ledgerPopover');
    if (!pop) return;
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    if (delay > 0) {
      popoverHideTimer = setTimeout(() => {
        pop.classList.remove('visible');
        pop.setAttribute('aria-hidden', 'true');
      }, delay);
    } else {
      pop.classList.remove('visible');
      pop.setAttribute('aria-hidden', 'true');
    }
  }

  function computeHeatmapDates(yearScope, todayKey) {
    const today = parseYmdLocal(todayKey);
    if (yearScope && /^\d{4}$/.test(yearScope)) {
      const y = Number(yearScope);
      const jan1 = new Date(y, 0, 1);
      const dec31 = new Date(y, 11, 31);
      const startSunday = addDays(jan1, -jan1.getDay());
      const endSaturday = addDays(dec31, 6 - dec31.getDay());
      const days = [];
      for (let d = startSunday; d.getTime() <= endSaturday.getTime(); d = addDays(d, 1)) {
        days.push({
          date: d,
          key: formatLocalYmd(d),
          inTargetYear: d.getFullYear() === y,
          isFuture: d.getTime() > today.getTime(),
          isToday: formatLocalYmd(d) === todayKey,
        });
      }
      return { days, today, startDate: startSunday, endDate: endSaturday };
    }

    // 默认滚动最近 52 周：对齐到本周六，往前 364 天
    const endSaturday = addDays(today, 6 - today.getDay());
    const startSunday = addDays(endSaturday, -(52 * 7 - 1));
    const days = [];
    for (let i = 0; i < 52 * 7; i++) {
      const d = addDays(startSunday, i);
      const key = formatLocalYmd(d);
      days.push({
        date: d,
        key,
        inTargetYear: true,
        isFuture: d.getTime() > today.getTime(),
        isToday: key === todayKey,
      });
    }
    return { days, today, startDate: startSunday, endDate: endSaturday };
  }

  function computeHeatmapThresholds(values) {
    const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (positive.length === 0) return [1, 2, 3];
    if (positive.length < 4) {
      const maxVal = positive[positive.length - 1];
      return [maxVal * 0.25, maxVal * 0.5, maxVal * 0.75];
    }
    const q = (p) => positive[Math.min(positive.length - 1, Math.floor((positive.length - 1) * p))];
    return [q(0.25), q(0.55), q(0.8)];
  }

  function getHeatmapLevel(tokens, thresholds) {
    if (!tokens || tokens <= 0) return 0;
    if (tokens <= thresholds[0]) return 1;
    if (tokens <= thresholds[1]) return 2;
    if (tokens <= thresholds[2]) return 3;
    return 4;
  }

  function renderLedgerKpis(view) {
    const s = view?.summary || {};
    const usdToCny = ledgerState.data?.settings?.usdToCny || 7.25;
    document.getElementById('kpiGrandTotal').textContent = formatNumber(s.grandTotalTokens || 0);
    document.getElementById('kpiGrandSub').textContent = `输入 ${formatNumber(s.totalInputTokens || 0)} · 缓存 ${formatNumber(s.totalCacheTokens || 0)} · 输出 ${formatNumber(s.totalOutputTokens || 0)}`;

    document.getElementById('kpiTodayVal').textContent = `今日 ${formatNumber(s.todayTokens || 0)}`;
    document.getElementById('kpiMonthWeekSub').textContent = `本月 ${formatNumber(s.monthTokens || 0)} · 本周 ${formatNumber(s.weekTokens || 0)}`;

    document.getElementById('kpiActiveDays').textContent = `${s.activeDays || 0} 天`;
    document.getElementById('kpiFirstUseSub').textContent = `始于 ${s.firstUseDate || '--'} · 陪伴 ${s.companionDays || 0} 天 · ${s.totalConversations || 0} 会话`;

    const mCost = formatCostPair(s.monthCostUSD || 0, usdToCny);
    const tCost = formatCostPair(s.totalCostUSD || 0, usdToCny);
    document.getElementById('kpiMonthCost').textContent = mCost.usdStr;
    document.getElementById('kpiCostSub').textContent = `≈ ${mCost.cnyStr} · 累计 ${tCost.usdStr}`;
  }

  function renderHeatmap(view) {
    const colsBox = document.getElementById('heatmapCols');
    const monthsBox = document.getElementById('heatmapMonths');
    const scrollWrap = document.getElementById('heatmapScrollWrap');
    const yearSelect = document.getElementById('ledgerYearSelect');
    if (!colsBox || !monthsBox || !view) return;

    // 更新可选年份列表
    const availYears = view.availableYears || [];
    const curScope = ledgerState.yearScope;
    const expectedOpts = ['rolling', ...availYears];
    const currentOpts = Array.from(yearSelect.options).map((o) => o.value);
    if (expectedOpts.join(',') !== currentOpts.join(',')) {
      yearSelect.innerHTML = `<option value="rolling">最近 52 周</option>` +
        availYears.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)} 全年</option>`).join('');
    }
    if (expectedOpts.includes(curScope)) yearSelect.value = curScope;
    else {
      ledgerState.yearScope = 'rolling';
      yearSelect.value = 'rolling';
    }

    const colors = getActiveThemeColors();
    const activeTheme = ledgerState.data?.settings?.heatmapTheme || 'emerald';
    document.querySelectorAll('#heatmapThemeDots .theme-dot').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === activeTheme);
    });
    document.querySelectorAll('#heatmapLegend .hm-legend-cell').forEach((cell) => {
      const lvl = Number(cell.dataset.lvl || 0);
      cell.style.backgroundColor = colors[lvl] || colors[0];
    });

    const todayKey = ledgerState.data?.todayKey || formatLocalYmd(new Date());
    const dailyMap = view.dailyMap || {};
    const { days } = computeHeatmapDates(ledgerState.yearScope, todayKey);
    const totalWeeks = Math.ceil(days.length / 7);

    const winValues = [];
    let rangeTokens = 0;
    let rangeActiveDays = 0;
    for (const item of days) {
      if (!item.inTargetYear || item.isFuture) continue;
      const rec = dailyMap[item.key];
      const tok = rec?.total || 0;
      if (tok > 0) {
        winValues.push(tok);
        rangeTokens += tok;
        rangeActiveDays++;
      }
    }
    const thresholds = computeHeatmapThresholds(winValues);
    const scopeTitle = ledgerState.yearScope === 'rolling' ? '最近 52 周' : `${ledgerState.yearScope} 年`;
    document.getElementById('heatmapSummaryText').textContent =
      `${scopeTitle}共 ${formatNumber(rangeTokens)} Tokens · ${rangeActiveDays} 个活跃日`;

    colsBox.replaceChildren();
    monthsBox.replaceChildren();
    const monthWidthPx = totalWeeks * 13;
    monthsBox.style.minWidth = `${monthWidthPx}px`;
    colsBox.style.minWidth = `${monthWidthPx}px`;

    const usdToCny = ledgerState.data?.settings?.usdToCny || 7.25;
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    let lastMonth = -1;
    let lastMonthCol = -10;

    for (let c = 0; c < totalWeeks; c++) {
      const col = document.createElement('div');
      col.className = 'hm-week-col';
      const slice = days.slice(c * 7, (c + 1) * 7);

      const firstInSlice = slice.find((x) => x.inTargetYear) || slice[0];
      if (firstInSlice) {
        const mNum = firstInSlice.date.getMonth() + 1;
        if (mNum !== lastMonth && c - lastMonthCol >= 3 && totalWeeks - c >= 2) {
          const lbl = document.createElement('span');
          lbl.className = 'hm-month-lbl';
          lbl.style.left = `${c * 13}px`;
          lbl.textContent = `${mNum}月`;
          monthsBox.appendChild(lbl);
          lastMonth = mNum;
          lastMonthCol = c;
        }
      }

      for (const item of slice) {
        const cell = document.createElement('div');
        const rec = dailyMap[item.key];
        const tok = rec?.total || 0;
        const lvl = item.isFuture ? 0 : getHeatmapLevel(tok, thresholds);
        cell.className = `hm-cell${item.isToday ? ' is-today' : ''}${item.isFuture ? ' is-future' : ''}`;
        if (!item.inTargetYear) cell.style.opacity = '0.35';
        cell.style.backgroundColor = colors[lvl] || colors[0];

        const onShow = () => {
          const wk = weekNames[item.date.getDay()];
          const badge = item.isToday ? ' · 今天' : (item.key === view.summary?.firstUseDate ? ' · 首次启用' : '');
          const cost = formatCostPair(rec?.costUSD || 0, usdToCny);
          const costPart = rec && rec.costUSD > 0 ? ` · ≈ ${cost.usdStr} (${cost.cnyStr})` : '';
          const html = `
            <div class="pop-date">${escapeHtml(item.key)} (${wk}${badge})</div>
            <div class="pop-main">${tok > 0 ? `${formatNumber(tok)} Tokens${costPart}` : (item.isFuture ? '未来日期' : '0 Tokens')}</div>
            ${rec ? `
              <div class="pop-grid">
                <span>输入: ${formatNumber(rec.input || 0)}</span>
                <span>缓存: ${formatNumber(rec.cache || 0)}</span>
                <span>输出: ${formatNumber(rec.output || 0)}</span>
                <span>调用: ${(rec.steps || 0).toLocaleString()} 步</span>
              </div>
            ` : ''}
          `;
          showLedgerPopover(cell, html);
        };
        cell.addEventListener('mouseenter', onShow);
        cell.addEventListener('mouseleave', () => hideLedgerPopover(60));
        cell.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onShow();
        });
        col.appendChild(cell);
      }
      colsBox.appendChild(col);
    }

    if (scrollWrap && ledgerState.yearScope === 'rolling') {
      requestAnimationFrame(() => {
        scrollWrap.scrollLeft = scrollWrap.scrollWidth;
      });
    }
  }

  function renderChartSubPanel(view) {
    const box = document.getElementById('ledgerChartBody');
    if (!box || !view) return;

    const mode = ledgerState.chartMode;
    document.querySelectorAll('#chartModeGroup .ledger-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const colors = getActiveThemeColors();
    const usdToCny = ledgerState.data?.settings?.usdToCny || 7.25;
    const todayKey = ledgerState.data?.todayKey || formatLocalYmd(new Date());
    const dailyMap = view.dailyMap || {};

    if (mode === 'weekly') {
      const { days } = computeHeatmapDates(ledgerState.yearScope, todayKey);
      const totalWeeks = Math.ceil(days.length / 7);
      const weeks = [];
      let maxWeek = 1;
      for (let c = 0; c < totalWeeks; c++) {
        const slice = days.slice(c * 7, (c + 1) * 7);
        let sum = 0;
        let cost = 0;
        let steps = 0;
        for (const item of slice) {
          const rec = dailyMap[item.key];
          if (rec) {
            sum += rec.total || 0;
            cost += rec.costUSD || 0;
            steps += rec.steps || 0;
          }
        }
        if (sum > maxWeek) maxWeek = sum;
        weeks.push({ start: slice[0].key, end: slice[slice.length - 1].key, sum, cost, steps });
      }
      const thresholds = computeHeatmapThresholds(weeks.map((w) => w.sum));
      const colsHtml = weeks
        .map((w, idx) => {
          const pct = w.sum > 0 ? Math.max(4, Math.round((w.sum / maxWeek) * 100)) : 2;
          const lvl = getHeatmapLevel(w.sum, thresholds);
          const bg = w.sum > 0 ? colors[lvl] : colors[0];
          return `<div class="weekly-bar-col" data-widx="${idx}"><div class="weekly-bar-fill" style="height:${pct}%;background:${bg}"></div></div>`;
        })
        .join('');
      box.innerHTML = `<div class="weekly-scroll-wrap" id="weeklyScrollWrap"><div class="weekly-bars-wrap">${colsHtml}</div></div>`;
      box.querySelectorAll('.weekly-bar-col').forEach((colEl) => {
        const w = weeks[Number(colEl.dataset.widx)];
        const onShow = () => {
          const pair = formatCostPair(w.cost, usdToCny);
          showLedgerPopover(
            colEl,
            `<div class="pop-date">${escapeHtml(w.start)} ~ ${escapeHtml(w.end)}</div>
             <div class="pop-main">${formatNumber(w.sum)} Tokens · ≈ ${pair.usdStr} (${pair.cnyStr})</div>
             <div class="pop-grid"><span>调用步数: ${w.steps.toLocaleString()}</span><span>日均: ${formatNumber(Math.round(w.sum / 7))}</span></div>`
          );
        };
        colEl.addEventListener('mouseenter', onShow);
        colEl.addEventListener('mouseleave', () => hideLedgerPopover(60));
        colEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onShow();
        });
      });
      const wsWrap = document.getElementById('weeklyScrollWrap');
      if (wsWrap && ledgerState.yearScope === 'rolling') {
        requestAnimationFrame(() => {
          wsWrap.scrollLeft = wsWrap.scrollWidth;
        });
      }
      return;
    }

    if (mode === 'monthly') {
      const list = view.monthlyList || [];
      if (!list.length) {
        box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">暂无月度统计数据</div>';
        return;
      }
      const maxM = Math.max(1, ...list.map((m) => m.total || 0));
      box.innerHTML = `<div class="monthly-list">${list
        .map((m) => {
          const pct = Math.max(2, Math.round((m.total / maxM) * 100));
          const cost = formatCostPair(m.costUSD, usdToCny);
          return `
            <div class="monthly-row">
              <strong style="color:#d6d9e4;font-family:monospace">${escapeHtml(m.month)}</strong>
              <div>
                <div class="monthly-track"><div class="monthly-fill" style="width:${pct}%"></div></div>
                <div style="font-size:9.5px;color:var(--text-muted);margin-top:3px;">
                  活跃 ${m.activeDays} 天 · 缓存命中 ${m.cacheHitRate}% · ${m.steps.toLocaleString()} 步
                </div>
              </div>
              <div style="text-align:right;font-feature-settings:'tnum'">
                <div style="font-weight:700;color:#e5e8f3">${formatNumber(m.total)}</div>
                <div style="font-size:9.5px;color:#fbbf24">${cost.usdStr} (${cost.cnyStr})</div>
              </div>
            </div>
          `;
        })
        .join('')}</div>`;
      return;
    }

    if (mode === 'yearly') {
      const list = view.yearlyList || [];
      if (!list.length) {
        box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">暂无年度统计数据</div>';
        return;
      }
      box.innerHTML = `<div class="yearly-bubbles">${list
        .map((y) => {
          const cost = formatCostPair(y.costUSD, usdToCny);
          return `
            <div class="year-card">
              <div class="year-card-head">
                <span>${escapeHtml(y.year)} 年</span>
                <span style="font-size:10px;color:var(--accent-blue)">活跃 ${y.activeDays} 天</span>
              </div>
              <div class="year-card-val">${formatNumber(y.total)} Tokens</div>
              <div class="year-card-meta">等值 ${cost.usdStr} (${cost.cnyStr}) · 缓存命中 ${y.cacheHitRate}%</div>
              <div class="year-card-meta">总步数: ${y.steps.toLocaleString()} · 输出: ${formatNumber(y.output)}</div>
            </div>
          `;
        })
        .join('')}</div>`;
      return;
    }

    if (mode === 'cumulative') {
      box.innerHTML = `<div class="cum-canvas-wrap"><canvas id="ledgerCumCanvas"></canvas></div>`;
      requestAnimationFrame(() => drawCumulativeCanvas(view));
    }
  }

  function drawCumulativeCanvas(view) {
    const cvs = document.getElementById('ledgerCumCanvas');
    if (!cvs || !cvs.getContext) return;
    const rect = cvs.getBoundingClientRect();
    const width = rect.width || 620;
    const height = rect.height || 138;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = width * dpr;
    cvs.height = height * dpr;

    const ctx = cvs.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const todayKey = ledgerState.data?.todayKey || formatLocalYmd(new Date());
    const { days } = computeHeatmapDates(ledgerState.yearScope, todayKey);
    const dailyMap = view.dailyMap || {};
    const startKey = days[0]?.key || '';

    let running = 0;
    for (const [k, rec] of Object.entries(dailyMap)) {
      if (k < startKey && rec?.total > 0) running += rec.total;
    }

    const points = [];
    for (const item of days) {
      if (item.isFuture) continue;
      const rec = dailyMap[item.key];
      if (rec?.total) running += rec.total;
      points.push({ key: item.key, val: running });
    }
    if (!points.length) return;

    const padX = 12;
    const padTop = 18;
    const padBot = 20;
    const plotW = Math.max(10, width - padX * 2);
    const plotH = Math.max(10, height - padTop - padBot);
    const maxVal = Math.max(1, points[points.length - 1].val);

    // 淡色网格线
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 2; g++) {
      const gy = padTop + (plotH * g) / 2;
      ctx.beginPath();
      ctx.moveTo(padX, gy);
      ctx.lineTo(width - padX, gy);
      ctx.stroke();
    }

    const colors = getActiveThemeColors();
    const accent = colors[4] || '#34d399';
    const grad = ctx.createLinearGradient(0, padTop, 0, height - padBot);
    grad.addColorStop(0, 'rgba(52, 211, 153, 0.34)');
    grad.addColorStop(1, 'rgba(52, 211, 153, 0.02)');

    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? padX + plotW / 2 : padX + (idx / (points.length - 1)) * plotW;
      const y = padTop + plotH - (pt.val / maxVal) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.lineTo(padX + plotW, padTop + plotH);
    ctx.lineTo(padX, padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 标注起止日期与累计峰值
    ctx.fillStyle = '#8b8e9f';
    ctx.font = '10px sans-serif';
    ctx.fillText(points[0].key, padX, height - 5);
    const endLabel = points[points.length - 1].key;
    const endW = ctx.measureText(endLabel).width;
    ctx.fillText(endLabel, width - padX - endW, height - 5);

    ctx.fillStyle = '#e6e9f2';
    ctx.font = '600 10.5px sans-serif';
    const topLbl = `累计 ${formatNumber(maxVal)}`;
    const topW = ctx.measureText(topLbl).width;
    ctx.fillText(topLbl, width - padX - topW, 13);
  }

  function renderSpeedTab(view) {
    const rankBox = document.getElementById('speedRankList');
    if (!rankBox || !view) return;

    const metric = ledgerState.speedMetric;
    document.querySelectorAll('#speedMetricGroup .ledger-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.metric === metric);
    });

    const list = (view.speedBenchmarks || []).slice();
    if (!list.length) {
      rankBox.innerHTML = '<div style="text-align:center;padding:28px;color:var(--text-muted)">暂无 SQLite 实测速度样本</div>';
      document.getElementById('speedTrendCard').style.display = 'none';
      return;
    }
    document.getElementById('speedTrendCard').style.display = 'block';

    const metricConfig = {
      streamingTps: { field: 'medianStreamingTps', seriesKey: 'streamingTps', unit: ' tok/s', higherBetter: true, label: '纯流式 TPS', refPrefix: '中位' },
      p75StreamingTps: { field: 'p75StreamingTps', seriesKey: 'streamingTps', unit: ' tok/s', higherBetter: true, label: 'P75 峰值 TPS', refPrefix: 'P75' },
      ttftSec: { field: 'medianTtftSec', seriesKey: 'ttftSec', unit: 's', higherBetter: false, label: '首字延迟 TTFT', refPrefix: '中位' },
      durationSec: { field: 'medianDurationSec', seriesKey: 'durationSec', unit: 's', higherBetter: false, label: '单次总耗时', refPrefix: '中位' },
    }[metric] || { field: 'medianStreamingTps', seriesKey: 'streamingTps', unit: ' tok/s', higherBetter: true, label: '纯流式 TPS', refPrefix: '中位' };

    const validItems = list.filter((item) => item[metricConfig.field] !== null && item[metricConfig.field] > 0);
    validItems.sort((a, b) =>
      metricConfig.higherBetter
        ? b[metricConfig.field] - a[metricConfig.field]
        : a[metricConfig.field] - b[metricConfig.field]
    );
    const noValItems = list.filter((item) => item[metricConfig.field] === null || item[metricConfig.field] <= 0);
    const ordered = [...validItems, ...noValItems];

    if (!ledgerState.selectedModelKey || !ordered.some((x) => x.modelKey === ledgerState.selectedModelKey)) {
      ledgerState.selectedModelKey = ordered[0].modelKey;
    }

    const maxVal = Math.max(0.01, ...validItems.map((x) => x[metricConfig.field]));

    rankBox.innerHTML = ordered
      .map((item) => {
        const val = item[metricConfig.field];
        const hasVal = val !== null && val > 0;
        const barPct = hasVal ? Math.max(6, Math.round((val / maxVal) * 100)) : 0;
        const selected = item.modelKey === ledgerState.selectedModelKey;
        const lowWarn = item.lowSampleWarning ? '<span class="low-sample-badge">样本偏少 (&lt;3)</span>' : '';

        const subParts = [];
        if (metric !== 'streamingTps' && item.medianStreamingTps > 0) subParts.push(`纯流式 ${item.medianStreamingTps} tok/s`);
        if (metric !== 'p75StreamingTps' && item.p75StreamingTps > 0) subParts.push(`P75峰值 ${item.p75StreamingTps} tok/s`);
        if (metric !== 'ttftSec' && item.medianTtftSec !== null) subParts.push(`TTFT ${item.medianTtftSec}s`);
        if (metric !== 'durationSec' && item.medianDurationSec !== null) subParts.push(`总耗时 ${item.medianDurationSec}s`);

        return `
          <div class="speed-rank-row ${selected ? 'selected' : ''}" data-model="${escapeHtml(item.modelKey)}">
            <div class="speed-row-top">
              <div class="speed-model-meta">
                <span class="speed-model-name">${escapeHtml(item.modelLabel)}</span>
                <span class="sample-count-badge">${item.sampleCount} 次</span>
                ${lowWarn}
              </div>
              <span class="speed-metric-main">${hasVal ? `${val}${metricConfig.unit}` : '--'}</span>
            </div>
            <div class="speed-bar-track"><div class="speed-bar-fill" style="width:${barPct}%"></div></div>
            <div class="speed-row-sub">${escapeHtml(subParts.join(' · ') || '暂无更多辅助指标')}</div>
          </div>
        `;
      })
      .join('');

    rankBox.querySelectorAll('.speed-rank-row').forEach((row) => {
      row.addEventListener('click', () => {
        ledgerState.selectedModelKey = row.dataset.model;
        renderSpeedTab(view);
      });
    });

    const selectedItem = ordered.find((x) => x.modelKey === ledgerState.selectedModelKey) || ordered[0];
    document.getElementById('speedTrendTitle').textContent = `${selectedItem.modelLabel} · ${metricConfig.label} 趋势`;
    document.getElementById('speedTrendSub').textContent = `展示最近 ${selectedItem.recentSeries.length} 条实测记录 · 虚线为近 ${selectedItem.sampleCount} 次${metricConfig.refPrefix}值`;
    requestAnimationFrame(() => drawSpeedTrendCanvas(selectedItem, metricConfig));
  }

  function drawSpeedTrendCanvas(item, metricConfig) {
    const cvs = document.getElementById('speedTrendCanvas');
    if (!cvs || !cvs.getContext || !item) return;
    const rect = cvs.getBoundingClientRect();
    const width = rect.width || 620;
    const height = rect.height || 138;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = width * dpr;
    cvs.height = height * dpr;

    const ctx = cvs.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const seriesKey = metricConfig.seriesKey || ledgerState.speedMetric;
    const series = (item.recentSeries || []).filter((pt) => pt[seriesKey] !== null && pt[seriesKey] > 0);
    if (!series.length) {
      ctx.fillStyle = '#8b8e9f';
      ctx.font = '12px sans-serif';
      ctx.fillText('该模型暂无此指标有效历史折线点', 16, height / 2);
      return;
    }

    const vals = series.map((pt) => Number(pt[seriesKey]));
    const maxVal = Math.max(0.1, ...vals) * 1.15;
    const minVal = 0;

    const padX = 14;
    const padTop = 18;
    const padBot = 20;
    const plotW = Math.max(10, width - padX * 2);
    const plotH = Math.max(10, height - padTop - padBot);

    const medVal = Number(item[metricConfig.field] || 0);
    if (medVal > 0) {
      const medY = padTop + plotH - ((medVal - minVal) / (maxVal - minVal)) * plotH;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
      ctx.beginPath();
      ctx.moveTo(padX, medY);
      ctx.lineTo(width - padX, medY);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#facc15';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${metricConfig.refPrefix || '中位'} ${medVal}${metricConfig.unit}`, padX, Math.max(11, medY - 4));
    }

    ctx.beginPath();
    const coords = vals.map((v, idx) => {
      const x = vals.length === 1 ? padX + plotW / 2 : padX + (idx / (vals.length - 1)) * plotW;
      const y = padTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      return { x, y };
    });
    ctx.strokeStyle = '#4ea8de';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#9d4edd';
    for (const c of coords) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#8b8e9f';
    ctx.font = '10px sans-serif';
    ctx.fillText(series[0].date || '', padX, height - 5);
    const endDate = series[series.length - 1].date || '';
    ctx.fillText(endDate, width - padX - ctx.measureText(endDate).width, height - 5);
  }

  function renderBillingTab(view) {
    if (!ledgerState.data || !view) return;
    const settings = ledgerState.data.settings || {};
    const presets = ledgerState.data.presets || [];
    const currencies = ledgerState.data.currencies || {};

    const presetSel = document.getElementById('cfgPreset');
    if (presetSel) {
      const expectedPresetIds = presets.map((p) => p.id).join(',');
      const currentPresetIds = Array.from(presetSel.options).map((o) => o.value).join(',');
      if (expectedPresetIds && currentPresetIds !== expectedPresetIds) {
        presetSel.innerHTML = presets
          .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
          .join('');
      }
      presetSel.value = presets.some((p) => p.id === settings.presetId)
        ? settings.presetId
        : 'pro_monthly';
    }

    const curSel = document.getElementById('cfgCurrency');
    if (curSel && curSel.options.length === 0) {
      curSel.innerHTML = Object.values(currencies)
        .map((c) => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} (${escapeHtml(c.symbol)})</option>`)
        .join('');
    }
    if (curSel) curSel.value = settings.currency || 'USD';

    const priceInput = document.getElementById('cfgMonthlyPrice');
    if (priceInput && document.activeElement !== priceInput) {
      priceInput.value = settings.monthlyPrice ?? 19.99;
    }
    const rateInput = document.getElementById('cfgUsdToCny');
    if (rateInput && document.activeElement !== rateInput) {
      rateInput.value = settings.usdToCny ?? 7.25;
    }

    // 根据当前激活视角（全部 / 桌面端 / CLI）与全局汇率计算回本数据
    const usdToCny = Number(settings.usdToCny) || 7.25;
    const curCode = settings.currency || 'USD';
    const curMeta = currencies[curCode] || { symbol: '$', ratesPerUsd: 1 };
    const ratePerUsd = curCode === 'CNY' ? usdToCny : curMeta.ratesPerUsd || 1;
    const monthlyPaidOriginal = Number(settings.monthlyPrice) || 0;
    const monthlyPaidUSD = ratePerUsd > 0 ? monthlyPaidOriginal / ratePerUsd : monthlyPaidOriginal;
    const monthlyPaidCNY = monthlyPaidUSD * usdToCny;

    const sum = view.summary || {};
    const monthApiUSD = Number(sum.monthCostUSD || 0);
    const monthApiCNY = monthApiUSD * usdToCny;
    const allApiUSD = Number(sum.totalCostUSD || 0);
    const allApiCNY = allApiUSD * usdToCny;

    const roiBox = document.getElementById('roiSummaryBox');
    if (roiBox) {
      let badgeHtml = '';
      let pct = 100;
      let fillColor = 'var(--accent-green)';

      if (monthlyPaidUSD <= 0) {
        badgeHtml = `<span class="roi-badge-big positive">🎁 免费权益 · 本月净赚 $${monthApiUSD.toFixed(2)} (¥${monthApiCNY.toFixed(2)})</span>`;
        pct = 100;
      } else {
        const ratio = (monthApiUSD / monthlyPaidUSD) * 100;
        pct = Math.min(100, Math.max(2, Math.round(ratio)));
        const diffUSD = monthApiUSD - monthlyPaidUSD;
        const diffCNY = monthApiCNY - monthlyPaidCNY;
        if (diffUSD >= 0) {
          badgeHtml = `<span class="roi-badge-big positive">🚀 已回本 ${ratio.toFixed(1)}% · 净省 $${diffUSD.toFixed(2)} (¥${diffCNY.toFixed(2)})</span>`;
        } else {
          fillColor = 'var(--accent-amber)';
          badgeHtml = `<span class="roi-badge-big pending">⏳ 本月回本进度 ${ratio.toFixed(1)}% · 还差 $${Math.abs(diffUSD).toFixed(2)} (¥${Math.abs(diffCNY).toFixed(2)})</span>`;
        }
      }

      roiBox.innerHTML = `
        <div class="roi-headline">
          ${badgeHtml}
          <span style="font-size:11px;color:#cfd2dc;">本月 API 等值: <strong>$${monthApiUSD.toFixed(2)}</strong> (¥${monthApiCNY.toFixed(2)})</span>
        </div>
        <div class="roi-progress-track">
          <div class="roi-progress-fill" style="width:${pct}%;background:${fillColor}"></div>
        </div>
        <div class="roi-sub-line">
          <span>月付订阅折算: ${escapeHtml(curMeta.symbol)}${monthlyPaidOriginal.toFixed(2)} ≈ $${monthlyPaidUSD.toFixed(2)} (¥${monthlyPaidCNY.toFixed(2)})</span>
          <span>历史总计等效: $${allApiUSD.toFixed(2)} (¥${allApiCNY.toFixed(2)})</span>
        </div>
      `;
    }

    // 渲染分模型账单明细
    const period = ledgerState.billingPeriod;
    document.querySelectorAll('#billingPeriodGroup .ledger-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.period === period);
    });

    const models = (view.modelBreakdown || [])
      .map((m) => ({
        ...m,
        costUSD: period === 'month' ? m.monthCostUSD : m.allTimeCostUSD,
        showTokens: period === 'month' ? m.monthTotalTokens : m.total,
        showSteps: period === 'month' ? m.monthSteps : m.steps,
      }))
      .filter((m) => m.showSteps > 0 || m.showTokens > 0)
      .sort((a, b) => b.costUSD - a.costUSD || b.showTokens - a.showTokens);

    const wrap = document.getElementById('billingModelTableWrap');
    if (!models.length) {
      wrap.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">该周期暂无模型消费记录</div>';
      return;
    }

    wrap.innerHTML = `
      <table class="billing-table">
        <thead>
          <tr>
            <th>模型名称 &amp; 单价 ($/1M)</th>
            <th>步数</th>
            <th>总用量</th>
            <th>Cache 命中</th>
            <th style="text-align:right">等效金额</th>
          </tr>
        </thead>
        <tbody>
          ${models
            .map((m) => {
              const pair = formatCostPair(m.costUSD, usdToCny);
              const r = m.rates || { input: 0, cacheRead: 0, output: 0 };
              return `
                <tr>
                  <td>
                    <div style="font-weight:600;color:#e4e7f2">${escapeHtml(m.modelLabel)}</div>
                    <div class="billing-rate-sub">入$${r.input} / 缓$${r.cacheRead} / 出$${r.output}</div>
                  </td>
                  <td>${(m.showSteps || 0).toLocaleString()}</td>
                  <td>${formatNumber(m.showTokens || 0)}</td>
                  <td>${m.cacheHitRate}%</td>
                  <td style="text-align:right;font-feature-settings:'tnum'">
                    <div style="font-weight:700;color:#fbbf24">${pair.usdStr}</div>
                    <div class="billing-rate-sub">${pair.cnyStr}</div>
                  </td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    `;
  }

  function renderLedgerPopup() {
    if (!ledgerState.open) return;
    const loadingEl = document.getElementById('ledgerLoadingState');
    const panes = {
      activity: document.getElementById('ledgerTabActivity'),
      speed: document.getElementById('ledgerTabSpeed'),
      billing: document.getElementById('ledgerTabBilling'),
    };

    if (ledgerState.loading && !ledgerState.data) {
      if (loadingEl) loadingEl.style.display = 'flex';
      Object.values(panes).forEach((el) => { if (el) el.style.display = 'none'; });
      return;
    }
    if (loadingEl) loadingEl.style.display = 'none';

    for (const [k, el] of Object.entries(panes)) {
      if (el) el.style.display = k === ledgerState.tab ? 'flex' : 'none';
    }

    document.querySelectorAll('#ledgerSourceGroup .ledger-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === ledgerState.source);
    });
    document.querySelectorAll('#ledgerNavTabs .ledger-nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === ledgerState.tab);
    });

    const stats = ledgerState.data?.scanStats;
    const metaEl = document.getElementById('ledgerScanMeta');
    if (metaEl && stats) {
      metaEl.textContent = `桌面 ${stats.desktopCount} 会话 · CLI ${stats.cliCount} 会话 · 耗时 ${stats.durationMs}ms (缓存命中 ${stats.cacheHits})`;
    }

    const view = getActiveView();
    if (!view) return;

    if (ledgerState.tab === 'activity') {
      renderLedgerKpis(view);
      renderHeatmap(view);
      renderChartSubPanel(view);
    } else if (ledgerState.tab === 'speed') {
      renderSpeedTab(view);
    } else if (ledgerState.tab === 'billing') {
      renderBillingTab(view);
    }
  }

  async function fetchLedger({ force = false } = {}) {
    ledgerState.loading = true;
    renderLedgerPopup();
    try {
      const url = buildApiUrl('/api/ledger', force ? { force: '1', _t: Date.now() } : { _t: Date.now() });
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load ledger');
      ledgerState.data = await res.json();
    } catch (err) {
      console.error('Ledger fetch error:', err);
    } finally {
      ledgerState.loading = false;
      renderLedgerPopup();
    }
  }

  async function saveLedgerCfg(patch) {
    try {
      const res = await fetch(buildApiUrl('/api/ledger/settings', { _t: Date.now() }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return;
      const result = await res.json();
      if (result.ledger) {
        ledgerState.data = result.ledger;
        renderLedgerPopup();
      }
      const toastEl = document.getElementById('cfgSaveToast');
      if (toastEl) {
        toastEl.classList.add('visible');
        if (cfgToastTimer) clearTimeout(cfgToastTimer);
        cfgToastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1600);
      }
    } catch (err) {
      console.error('Save ledger settings error:', err);
    }
  }

  function openLedgerPopup() {
    ledgerState.open = true;
    const overlay = document.getElementById('ledgerModalOverlay');
    if (overlay) {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
    }
    fetchLedger({ force: false });
  }

  function closeLedgerPopup() {
    ledgerState.open = false;
    hideLedgerPopover();
    const overlay = document.getElementById('ledgerModalOverlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  document.getElementById('openLedgerBtn')?.addEventListener('click', openLedgerPopup);
  document.getElementById('closeLedgerBtn')?.addEventListener('click', closeLedgerPopup);
  document.getElementById('ledgerModalOverlay')?.addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeLedgerPopup();
    else hideLedgerPopover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ledgerState.open) closeLedgerPopup();
  });

  document.getElementById('ledgerRefreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('ledgerRefreshBtn');
    btn.classList.add('spin-anim');
    try {
      await fetchLedger({ force: true });
    } finally {
      setTimeout(() => btn.classList.remove('spin-anim'), 450);
    }
  });

  document.getElementById('ledgerSourceGroup')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ledger-seg-btn');
    if (!btn?.dataset.source) return;
    ledgerState.source = btn.dataset.source;
    hideLedgerPopover();
    renderLedgerPopup();
  });

  document.getElementById('ledgerNavTabs')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ledger-nav-tab');
    if (!btn?.dataset.tab) return;
    ledgerState.tab = btn.dataset.tab;
    hideLedgerPopover();
    renderLedgerPopup();
  });

  document.getElementById('ledgerYearSelect')?.addEventListener('change', (ev) => {
    ledgerState.yearScope = ev.target.value;
    hideLedgerPopover();
    renderLedgerPopup();
  });

  document.getElementById('heatmapThemeDots')?.addEventListener('click', (ev) => {
    const dot = ev.target.closest('.theme-dot');
    if (!dot?.dataset.theme) return;
    if (ledgerState.data?.settings) {
      ledgerState.data.settings.heatmapTheme = dot.dataset.theme;
      renderLedgerPopup();
    }
    saveLedgerCfg({ heatmapTheme: dot.dataset.theme });
  });

  document.getElementById('chartModeGroup')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ledger-seg-btn');
    if (!btn?.dataset.mode) return;
    ledgerState.chartMode = btn.dataset.mode;
    hideLedgerPopover();
    renderChartSubPanel(getActiveView());
  });

  document.getElementById('speedMetricGroup')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ledger-seg-btn');
    if (!btn?.dataset.metric) return;
    ledgerState.speedMetric = btn.dataset.metric;
    renderSpeedTab(getActiveView());
  });

  document.getElementById('billingPeriodGroup')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ledger-seg-btn');
    if (!btn?.dataset.period) return;
    ledgerState.billingPeriod = btn.dataset.period;
    renderBillingTab(getActiveView());
  });

  document.getElementById('cfgPreset')?.addEventListener('change', (ev) => {
    const presetId = ev.target.value;
    const preset = (ledgerState.data?.presets || []).find((p) => p.id === presetId);
    if (preset && preset.id !== 'custom') {
      document.getElementById('cfgMonthlyPrice').value = preset.monthlyPrice;
      document.getElementById('cfgCurrency').value = preset.currency;
      saveLedgerCfg({
        presetId: preset.id,
        monthlyPrice: preset.monthlyPrice,
        currency: preset.currency,
      });
    } else {
      saveLedgerCfg({ presetId });
    }
  });

  document.getElementById('saveLedgerCfgBtn')?.addEventListener('click', () => {
    saveLedgerCfg({
      presetId: document.getElementById('cfgPreset')?.value,
      monthlyPrice: Number(document.getElementById('cfgMonthlyPrice')?.value),
      currency: document.getElementById('cfgCurrency')?.value,
      usdToCny: Number(document.getElementById('cfgUsdToCny')?.value),
    });
  });

  // 在侧边栏宽度调整时同步重绘可见 Canvas 避免模糊或错位
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!ledgerState.open) return;
    hideLedgerPopover();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const view = getActiveView();
      if (!view) return;
      if (ledgerState.tab === 'activity' && ledgerState.chartMode === 'cumulative') {
        drawCumulativeCanvas(view);
      } else if (ledgerState.tab === 'speed') {
        renderSpeedTab(view);
      }
    }, 120);
  });
})();
