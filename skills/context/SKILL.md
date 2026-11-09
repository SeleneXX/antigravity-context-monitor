---
name: context
description: 查看当前会话使用的上下文 Token 消耗、Prompt Cache 命中率 (Cache Hit %)、Turns 与 Steps 详情，并提供侧边栏实时监控面板入口。当用户询问“用了多少上下文”、“当前会话消耗”、“token使用量”或输入 /context 时触发。
---

# 上下文与 Token 使用监控 (`/context`)

该技能用于实时查询当前 Antigravity 会话的上下文使用状况，包括提示词 Token 总量、Prompt Cache 命中比例、执行步数及上下文窗口占用百分比。

## 使用指引

当用户想要了解上下文消耗时：

1. 运行内置的脚本获取当前会话指标：
```bash
node ~/.gemini/config/plugins/context-monitor/skills/context/scripts/get_context.mjs
```

2. 将脚本输出的状态条和侧边栏入口链接展示给用户：
> ⏱️ **<turns> turns · <steps> steps** | 💾 **<tokens> tok · Cache hit <rate>%** | 🟢 **<percent>%** (<tokens> / 1M)  
> [📊 打开侧边栏实时监控面板](sidecar://context-monitor/monitor/)

3. 如果用户正在处理长会话或接近上下文瓶颈，主动建议用户：
   - 使用 `/compact` 指令压缩会话上下文。
   - 打开侧边栏看板实时观察每一步的 Token 增长趋势。
