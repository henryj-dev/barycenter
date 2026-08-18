/**
 * SSE 프레임 해독 — `GET /api/v1/events` 의 짝.
 *
 * 브라우저 EventSource 는 Authorization 헤더를 못 붙인다. 그래서 fetch 스트림을
 * 직접 읽는다. 이 파서는 그 바이트를 프레임으로 접는다.
 */
export type SseFrame =
  | { kind: 'event'; event: string; data: unknown; id?: string }
  | { kind: 'comment'; text: string };

export function pullSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  while (true) {
    const split = rest.indexOf('\n\n');
    if (split < 0) break;
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    const frame = parseBlock(block);
    if (frame !== undefined) frames.push(frame);
  }
  return { frames, rest };
}

function parseBlock(block: string): SseFrame | undefined {
  const comments: string[] = [];
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    if (raw.startsWith(':')) {
      comments.push(raw.slice(1).trim());
      continue;
    }
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) {
    return comments.length === 0 ? undefined : { kind: 'comment', text: comments.join(' ') };
  }
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // 서버가 JSON 을 내는 것이 계약이지만, 깨진 한 프레임이 스트림을 죽이면 안 된다.
  }
  return { kind: 'event', event, data, ...(id === undefined ? {} : { id }) };
}
