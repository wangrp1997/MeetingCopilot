import { describe, expect, it } from 'vitest';
import { backgroundReady, classOpening } from '../electron/llm/codexTerminal';
import { isClassroomQuestion } from '../shared/textHeuristics';

const opening = classOpening('chinese');
const turn = (text: string, reply = '', status = 'completed') => ({
  status, items: [{ type: 'userMessage', content: [{ type: 'text', text }] }, { type: 'agentMessage', text: reply }],
});

describe('classroom capture', () => {
  it('waits for the classroom opening and an answered background turn', () => {
    const intro = turn(opening, '请介绍课堂背景。');
    expect(backgroundReady([], opening)).toBe(false);
    expect(backgroundReady([intro], opening)).toBe(false);
    expect(backgroundReady([intro, turn('背景', '正在理解', 'inProgress')], opening)).toBe(false);
    expect(backgroundReady([intro, turn('背景', '', 'interrupted')], opening)).toBe(false);
    expect(backgroundReady([turn('另一节课'), turn('背景', '了解')], opening)).toBe(false);
    expect(backgroundReady([intro, turn('研究题目是睡眠质量。', '了解。')], opening)).toBe(true);
  });
  it('does not send a long classroom explanation just because it exceeds a character limit', () => {
    expect(isClassroomQuestion('今天我们先梳理论文的研究对象和样本范围，接下来回顾现有文献，最后根据已有数据讨论适合这篇论文的研究方法。')).toBe(false);
    expect(isClassroomQuestion('这个样本量够用吗')).toBe(true);
    expect(isClassroomQuestion('这两种方法该怎么选')).toBe(true);
    expect(isClassroomQuestion('Why did we pick this topic')).toBe(true);
  });
});
