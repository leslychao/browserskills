import { createServer } from 'node:http';
import { once } from 'node:events';

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

// Owned media/keyboard surface only; Yang task forms live in yang-fixture.ts.
export async function startTestSite() {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
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
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    response.end('<!doctype html><html><title>Owned media fixture</title><body><p>Browser keyboard and media fixture</p></body></html>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, server,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
