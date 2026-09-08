import { createServer, type Server } from 'node:http';
import { EventEmitter, once } from 'node:events';

export type FixtureMode = 'normal' | 'identical' | 'multi' | 'reject' | 'lost' | 'stale-success' | 'audio' | 'instruction-audio' | 'unsupported-link' | 'no-instruction' | 'image' | 'delayed-submit' | 'swap-on-select';

export function wave(durationSeconds = 0.1, frequency = 440): Buffer {
  const sampleRate = 16_000;
  const count = Math.round(sampleRate * durationSeconds);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / sampleRate)), 44 + i * 2);
  return bytes;
}

export async function startTestSite(mode: FixtureMode = 'normal') {
  const state = { mode, current: 1, submissions: [] as Array<{ taskId: string; optionId: string }>, instruction: 'Read the whole question. Choose exactly one answer.\nExample: sky -> blue.' };
  const events=new EventEmitter();
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if(path==='/selection'){events.emit('selected');response.writeHead(204);response.end();return;}
    if(path==='/redirect'){response.writeHead(302,{Location:'/image.png'});response.end();return;}
    if(path==='/redirect-loop'){response.writeHead(302,{Location:'/redirect-loop'});response.end();return;}
    if(path==='/cross-redirect'){response.writeHead(302,{Location:'http://127.0.0.1:1/private'});response.end();return;}
    if(path==='/bad-redirect'){response.writeHead(302);response.end();return;}
    if(path==='/unavailable'){response.writeHead(404);response.end();return;}
    if(path==='/oversized'){response.writeHead(200,{'Content-Length':21*1024*1024});response.end();return;}
    if(path==='/chunked-huge'){response.writeHead(200,{'Transfer-Encoding':'chunked'});response.end(Buffer.alloc(21*1024*1024));return;}
    if (path === '/audio.wav') { response.writeHead(200, {'Content-Type':'audio/wav'}); response.end(wave()); return; }
    if (path === '/long.wav') { response.writeHead(200, {'Content-Type':'audio/wav'}); response.end(wave(61)); return; }
    if (path === '/bad.wav') { response.writeHead(200, {'Content-Type':'audio/wav'}); response.end('not audio'); return; }
    if (path === '/image.png') {
      response.writeHead(200, {'Content-Type':'image/png'});
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64')); return;
    }
    if (path === '/submit' && request.method === 'POST') {
      let body = ''; for await (const part of request) { body += String(part); if (body.length > 4096) { response.writeHead(413); response.end(); return; } }
      const submission = JSON.parse(body) as {taskId:string;optionId:string};
      if (state.mode === 'reject') { response.writeHead(422, {'Content-Type':'application/json'}); response.end('{}'); return; }
      if (submission.taskId !== `task-${state.current}`) { response.writeHead(409); response.end(); return; }
      state.submissions.push(submission); state.current++;
      if (state.mode === 'lost') { request.socket.destroy(); return; }
      response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({taskId:`task-${state.current}`})); return;
    }
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    const instructions = state.mode === 'no-instruction' ? '' : `<section id="instructions"><h2>Project instructions</h2><p>${state.instruction}</p>${state.mode === 'instruction-audio' ? '<p>Classify the background sound, not the words.</p><audio src="/audio.wav" controls></audio>' : ''}${state.mode === 'unsupported-link' ? '<a href="/full-rules">Read the remaining rules</a>' : ''}</section>`;
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>BrowserSkills owned fixture</title></head><body>
      ${instructions}
      <form id="task" data-project-id="fixture-project" data-task-id="task-${state.current}">
      <h2 id="question">${state.mode === 'identical' ? 'Identical question' : `Question ${state.current}`}</h2>
      ${state.mode === 'image' ? '<img id="image" src="/image.png" alt="test image">' : ''}
      ${state.mode === 'audio' ? '<audio id="audio" src="/audio.wav" controls></audio>' : ''}
      <fieldset><legend>Choose one answer</legend><label><input type="radio" name="answer" value="blue">Blue</label><label><input type="radio" name="answer" value="red">Red</label></fieldset>
      ${state.mode === 'multi' ? '<fieldset><legend>Second question</legend><label><input type="radio" name="second" value="x">X</label><label><input type="radio" name="second" value="y">Y</label></fieldset>' : ''}
      <button id="submit" type="submit" ${state.mode==='delayed-submit'?'style="display:none"':''}>Submit</button></form>
      <p id="success" ${state.mode === 'stale-success' ? '' : 'hidden'}>Sent</p><p id="error" hidden>Validation error</p><p id="complete" hidden>Complete</p>
      <script>
      document.querySelectorAll('input[type="radio"]').forEach(radio=>radio.addEventListener('change',()=>{
        ${state.mode==='swap-on-select'?"document.querySelector('#task').setAttribute('data-task-id','replacement');":''}
        fetch('/selection');
      }));
      document.querySelector('#task').addEventListener('submit', async event => {
        event.preventDefault(); const form = event.currentTarget; const radio = form.querySelector('input:checked'); if (!radio) return;
        try {
          const response = await fetch('/submit', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:form.dataset.taskId,optionId:radio.value})});
          if (!response.ok) { if(response.status === 422) document.querySelector('#error').hidden = false; return; }
          const result = await response.json();
          ${state.mode === 'stale-success' ? '' : `form.dataset.taskId = result.taskId; document.querySelector('#question').textContent = ${state.mode === 'identical' ? "'Identical question'" : "'Question ' + result.taskId.slice(5)"};`}
          radio.checked = false;
        } catch { /* Deliberately uncertain browser state after accepted HTTP POST. */ }
      });
      </script></body></html>`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, state, server, events,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
