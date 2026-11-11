// replay 실행 기록(stream-json·대화 기록 jsonl)에서 격리 위반을 찾는다.
//   LEAK-PATH  도구 입력에 실제 작업공간·실제 사용자 설정 경로가 나타남
//   DENIED     권한 규칙에 막힌 도구 호출(우회 시도 흔적)
import fs from 'node:fs';
import path from 'node:path';
import { realPathForms } from './replay.mjs';

const DENY_RE = /permission|denied|not allowed|권한|허용되지|requires approval/i;

/** jsonl 텍스트 한 덩어리에서 위반을 찾는다 */
export function auditText(text, source = '') {
  const forms = realPathForms();
  const needles = [...forms.workspace, ...forms.userClaude].map((s) => s.toLowerCase());
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type === 'tool_use') {
        const input = JSON.stringify(b.input ?? {}).toLowerCase().replace(/\\\\/g, '\\');
        const hit = needles.find((n) => input.includes(n.replace(/\\\\/g, '\\')));
        if (hit) findings.push({ rule: 'LEAK-PATH', source, line: i + 1, tool: b.name, detail: hit });
      }
      if (b.type === 'tool_result' && b.is_error) {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        if (DENY_RE.test(t)) findings.push({ rule: 'DENIED', source, line: i + 1, detail: t.replace(/\s+/g, ' ').slice(0, 160) });
      }
    }
  });
  return findings;
}

/** 실행 기록 파일과 전용 설정 폴더의 대화 기록을 모두 검사한다 */
export function auditRun({ runFile, configDir }) {
  const files = [];
  if (runFile) files.push(runFile);
  const projects = configDir ? path.join(configDir, 'projects') : null;
  if (projects && fs.existsSync(projects)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) files.push(p);
      }
    };
    walk(projects);
  }
  const findings = files.flatMap((f) => auditText(fs.readFileSync(f, 'utf8'), f));
  return { files, findings, valid: findings.length === 0 };
}
