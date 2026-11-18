import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { DecisionError, requestDecision } from './decisions.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const localEnv = await readFile(resolve(root, '.env'), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') console.warn('No se pudo leer el archivo .env de SpaceE.');
  return '';
});
const openAIKey = parseEnv(localEnv).OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
let decisionPending = false;

function sendJson(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, {'Content-Type':types['.json'], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
}

async function handleDecision(req, res) {
  const localPort = req.socket.localPort;
  const expectedOrigins = [`http://localhost:${localPort}`, `http://127.0.0.1:${localPort}`];
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Usa POST para solicitar una decisión.' });
  if (!expectedOrigins.includes(req.headers.origin) || !expectedOrigins.includes(`http://${req.headers.host}`)) {
    return sendJson(res, 403, { error: 'La solicitud debe originarse en el juego local.' });
  }
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return sendJson(res, 415, { error: 'La telemetría debe enviarse en JSON.' });
  }
  if (decisionPending) return sendJson(res, 429, { error: 'Ya hay una consulta en curso en este servidor.' });

  decisionPending = true;
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 1024) {
        req.resume();
        return sendJson(res, 413, { error: 'La telemetría supera el tamaño permitido.' });
      }
      chunks.push(chunk);
    }
    let telemetry;
    try {
      telemetry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Telemetría JSON inválida.' });
    }
    const result = await requestDecision(telemetry, { apiKey: openAIKey, signal: controller.signal });
    return sendJson(res, result.error ? 502 : 200, result);
  } catch (error) {
    if (error instanceof DecisionError) return sendJson(res, error.status, { error: error.message });
    return sendJson(res, 500, { error: 'El servidor local no pudo completar la consulta.' });
  } finally {
    decisionPending = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/decisions') return await handleDecision(req, res);
    const file = resolve(root, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + sep) || pathname.split('/').some(part => part.startsWith('.')) || !['.html','.css','.js','.svg','.json'].includes(extname(file))) {
      res.writeHead(403); res.end('Acceso no permitido'); return;
    }
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, {'Content-Type':types[extname(file)], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('No encontrado'); }
});
server.listen(port, '127.0.0.1', () => console.log(`SpaceE disponible en http://localhost:${port}`));
