import { hash, userEntries, selectTask } from './task-text.mjs';
import { analyzeProgress, progressEscalations } from './progress.mjs';

function explicitProvider(body, text) {
  const model = String(body.model || '').toLowerCase();
  if (/\[kimi\]|使用\s*kimi|use\s+kimi|强制\s*kimi/i.test(text)) return 'kimi';
  if (/\[deepseek\]|使用\s*deepseek|use\s+deepseek|强制\s*deepseek/i.test(text)) return 'deepseek';
  if (model.startsWith('kimi') || model.startsWith('claude-opus') || model.startsWith('claude-fable')) return 'kimi';
  if (model.startsWith('deepseek') || model.startsWith('claude-haiku')) return 'deepseek';
  return null;
}

function benchmarkAdvantages(text) {
  const reasons = [];
  if (/(?:视频理解|分析.*视频|video understanding|analy[sz]e.*video|\.mp4\b|\.mov\b)/i.test(text)) {
    reasons.push('video input is Kimi-only');
  }
  if (/(?:长程|自主完成|(?:端到端|完整)(?:项目|应用|交付)|自动完成|long[- ]horizon|autonomous|(?:complete|end[- ]to[- ]end) (?:project|application|system|delivery|agent))/i.test(text)) {
    reasons.push('long-horizon terminal/agent task (Terminal-Bench advantage)');
  }
  if (/(?:深度研究|复杂调研|多步检索|系统性文献|deep research|multi[- ]step research|literature review|(?:来源|信息源|证据|说法).{0,8}交叉(?:验证|核验)|交叉(?:验证|核验).{0,8}(?:来源|信息源|证据|说法))/i.test(text)) {
    reasons.push('difficult tool-assisted research (HLE advantage)');
  }
  if (/(?:数学证明|竞赛数学|前沿数学|形式化证明|olympiad|frontier ?math|theorem prov|research-grade math)/i.test(text)) {
    reasons.push('advanced mathematics (FrontierMath advantage)');
  }
  if (/(?:复杂视觉|视觉推理|图表推理|复杂图表|visual reasoning|chart reasoning|complex diagram)/i.test(text)) {
    reasons.push('complex visual reasoning (ZeroBench advantage)');
  }
  return reasons;
}

export function classifyRequest(body, options = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const task = selectTask(messages);
  const forced = explicitProvider(body, task.text);
  const firstTask = userEntries(messages)[0]?.text || '';
  const base = {
    conversationKey: hash(`${body.metadata?.user_id || ''}\0${firstTask}`),
    taskKey: hash(task.keyText || task.text), followUp: task.followUp,
  };
  if (forced) return { ...base, provider: forced, reason: 'explicit model selection', source: 'explicit', taskText: task.text, triageCandidate: false };
  const stats = analyzeProgress(messages, task.index);
  const limits = options.limits;
  const reasons = [...benchmarkAdvantages(task.text), ...progressEscalations(stats, limits)];
  return {
    ...base, task, stats,
    provider: reasons.length ? 'kimi' : 'deepseek',
    reason: reasons.join('; ') || 'default: comparable or better benchmark value',
    source: reasons.length ? 'evidence' : 'default',
    taskText: task.text,
    triageCandidate: !reasons.length && task.text.trim().length > 0,
  };
}
