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
    const currentSpeed = data.tps || data.tokPerSec || 0;
    document.getElementById('barSpeed').textContent = currentSpeed > 0 ? currentSpeed : '--';
    document.getElementById('barTotalTokens').textContent = formatNumber(data.totalPromptTokens || 0);
    document.getElementById('barCacheHit').textContent = `${data.sessionCacheHitRate ?? data.cacheHitRate ?? 0}%`;
    document.getElementById('barPercent').textContent = `${data.contextPercent || 0}%`;

    const hitTitle = `【主 Agent】当前活跃 Prompt: ${formatNumber(data.totalPromptTokens || 0)} tok | 安全阈值: ${formatNumber(currentWindow)} | 会话累计吞吐: ${formatNumber(data.sessionTotalTokens || 0)} tok`;
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

    // 主 Agent 视图
    document.getElementById('cardHitRate').textContent = `${data.sessionCacheHitRate ?? data.cacheHitRate ?? 0}%`;
    const stepHitText =
      data.stepCacheHitRate !== undefined
        ? data.stepCacheHitRate === 0
          ? '最新步: 0% (冷预填充)'
          : `最新步: ${data.stepCacheHitRate}%`
        : '';
    document.getElementById('cardHitRateSub').textContent = `累计命中: ${formatNumber(data.sessionCacheTokens || 0)} tok · ${stepHitText}`;

    document.getElementById('cardTotalTok').textContent = formatNumber(data.sessionTotalTokens || data.totalTokens || 0);
    document.getElementById('cardSessionThinkBreakdown').textContent = `🧠 思考: ${formatNumber(data.sessionThinkingTokens || 0)} · 💬 正文: ${formatNumber(data.sessionResponseTokens || 0)}`;

    const tpsVal = data.tps || data.tokPerSec || 0;
    document.getElementById('cardTps').textContent = `${tpsVal} tok/s`;
    document.getElementById('cardTpsSub').textContent = `近期: ${data.recentTps || tpsVal} tok/s · 峰值: ${data.peakTps || tpsVal} tok/s`;

    document.getElementById('cardTtft').textContent = data.ttft > 0 ? `${data.ttft}s` : '--';
    const rTtft = data.recentTtft > 0 ? `${data.recentTtft}s` : '--';
    const uTtft = data.userTtft > 0 ? `${data.userTtft}s` : '--';
    document.getElementById('cardTtftSub').textContent = `近期: ${rTtft} · 用户响应: ${uTtft}`;

    // 全量汇总视图
    document.getElementById('cardAllHitRate').textContent = `${summary.combinedCacheHitRate ?? data.cacheHitRate ?? 0}%`;
    document.getElementById('cardAllHitRateSub').textContent = `全量命中: ${formatNumber(summary.combinedCacheTokens || data.sessionCacheTokens || 0)} tok · 含全部 Subagents`;
    document.getElementById('cardAllTotalTok').textContent = formatNumber(summary.combinedSessionTokens || data.sessionTotalTokens || 0);
    document.getElementById('cardAllOutputBreakdown').textContent = `🧠 思考: ${formatNumber(summary.combinedThinkingTokens || data.sessionThinkingTokens || 0)} · 💬 正文: ${formatNumber(summary.combinedResponseTokens || data.sessionResponseTokens || 0)}`;

    const allTpsVal = summary.combinedTps || summary.combinedTokPerSec || tpsVal;
    document.getElementById('cardAllTps').textContent = `${allTpsVal} tok/s`;
    document.getElementById('cardAllTpsSub').textContent = `主 Agent + ${summary.subagentsCount ?? subList.length} 个 Subagents 协同速率`;

    const allTtftVal = summary.combinedTtft > 0 ? `${summary.combinedTtft}s` : data.ttft > 0 ? `${data.ttft}s` : '--';
    document.getElementById('cardAllTtft').textContent = allTtftVal;

    document.getElementById('statsMainView').style.display = statsTab === 'all' ? 'none' : 'grid';
    document.getElementById('statsAllView').style.display = statsTab === 'all' ? 'grid' : 'none';
  }

  function renderSubagents(subList) {
    const runningCount = subList.filter((s) => s.status === 'RUNNING').length;
    const headerBadge = document.getElementById('subagentsHeaderBadge');
    headerBadge.textContent =
      runningCount > 0 ? `${subList.length} 个子智能体 (${runningCount} 运行中)` : `${subList.length} 个子智能体`;

    const container = document.getElementById('subagentsContent');
    if (!subList || subList.length === 0) {
      container.innerHTML = `
        <div class="subagent-empty">
          <div class="subagent-empty-icon">🛡️</div>
          <div class="subagent-empty-title">当前会话未唤起 Subagent</div>
          <div class="subagent-empty-desc">
            所有任务均在主 Agent 上下文中完成。当唤起 <code>invoke_subagent</code> 时，各子智能体的独立 Token 消耗、后台任务等待态与 Cache 命中率将在此实时呈现。
          </div>
        </div>
      `;
      return;
    }

    const cardsHtml = subList
      .map((sa) => {
        let statusClass = 'done';
        let statusText = 'DONE';
        let cardExtraClass = '';
        if (sa.status === 'RUNNING') {
          statusClass = 'running';
          statusText = sa.statusDetail ? `RUNNING · ${sa.statusDetail}` : 'RUNNING';
          cardExtraClass = 'running';
        } else if (sa.status === 'STOPPED') {
          statusClass = 'stopped';
          statusText = 'STOPPED';
        }

        const speedVal = sa.tps || sa.tokPerSec || 0;
        const speedHtml = speedVal > 0 ? `${speedVal} tok/s` : '--';
        const ttftHtml = sa.ttft > 0 ? ` <span style="font-size:10px;color:var(--accent-blue)">(${sa.ttft}s)</span>` : '';

        return `
          <div class="subagent-card ${cardExtraClass}">
            <div class="subagent-header">
              <div class="subagent-title">
                <span>🤖 ${escapeHtml(sa.role || 'Subagent Worker')}</span>
                <span class="type-tag">${escapeHtml(sa.typeName || 'subagent')}</span>
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
              <div class="subagent-metric-item">
                <span class="metric-lbl">Cache 命中率</span>
                <span class="metric-val" style="color:var(--accent-green)">${sa.cacheHitRate || 0}%</span>
              </div>
              <div class="subagent-metric-item">
                <span class="metric-lbl">思考 / 正文</span>
                <span class="metric-val" style="color:#c0caf5">🧠${formatNumber(sa.sessionThinkingTokens || 0)} / 💬${formatNumber(sa.sessionResponseTokens || 0)}</span>
              </div>
              <div class="subagent-metric-item">
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
          timeCell = `
            <div style="display:flex;flex-direction:column;gap:1px;">
              <span style="color:#c0caf5;font-family:monospace;font-size:11px;white-space:nowrap;">${startTimeStr} → ${finishTimeStr}</span>
              ${dur ? `<span style="color:var(--text-muted);font-size:9.5px;">耗时 ${dur}</span>` : ''}
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

        const hitBadge = item.isCacheHit
          ? `<span style="background:rgba(82,183,136,0.15);color:var(--accent-green);border:1px solid rgba(82,183,136,0.3);padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;">🟢 HIT</span>`
          : `<span style="background:rgba(142,146,166,0.15);color:#8a8f98;border:1px solid rgba(142,146,166,0.25);padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500;">⚪ MISS</span>`;

        const thinkTok = item.thinking || 0;
        const respTok = item.response || 0;

        return `
          <tr>
            <td><span class="step-badge">#${item.step}</span></td>
            <td>${timeCell}</td>
            <td><strong>${(item.totalPrompt || 0).toLocaleString()}</strong></td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;">
                ${hitBadge}
                <span style="color:${item.isCacheHit ? 'var(--accent-green)' : '#8a8f98'};font-weight:500;">${item.cacheHitRate}%</span>
                <span style="color:var(--text-muted);font-size:10px;">(${formatNumber(item.cache || 0)})</span>
              </div>
            </td>
            <td>
              <div style="display:flex;flex-direction:column;gap:1px;">
                <span style="color:#c0caf5;font-weight:600;font-family:monospace;">${(item.output || 0).toLocaleString()}</span>
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
})();
