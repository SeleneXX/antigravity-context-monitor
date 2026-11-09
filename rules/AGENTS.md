# Context Awareness & Monitoring Guidelines

1. **上下文感知**：
   - 当用户询问“当前会话使用了多少上下文”、“使用了多少 Token”、“Cache 命中率”或调用 `/context` 时，调用 `node ~/.gemini/config/plugins/context-monitor/skills/context/scripts/get_context.mjs` 获取最新实时统计。
   - 并在回复中提供状态条及侧边栏一键打开链接：`[Context Monitor](sidecar://context-monitor/monitor/)`。

2. **上下文健康维护**：
   - 当当前会话消耗的上下文超过 40% 或步数较多时，适时建议用户使用 `/compact` 指令整理并压缩上下文，以保持响应速度与推理质量。
