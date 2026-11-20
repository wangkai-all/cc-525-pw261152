import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.ts';
import { AppError } from './errors.ts';
import { RevisionService } from './service.ts';
import type { Clock } from './util.ts';
import type { Role } from './types.ts';
import type { ChangeInput } from './domain.ts';
import { systemClock } from './util.ts';

const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  analyst: '分析师',
  reviewer: '复核人',
  viewer: '只读访客',
};

interface Session {
  userId: string;
  createdAt: string;
}

export interface AppContext {
  service: RevisionService;
  sessions: Map<string, Session>;
}

export function createApp(store: Store, clock: Clock = systemClock): {
  server: Server;
  ctx: AppContext;
} {
  const service = new RevisionService(store, clock);
  const sessions = new Map<string, Session>();
  const ctx: AppContext = { service, sessions };

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((err: unknown) => {
      if (err instanceof AppError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        console.error(err);
        sendJson(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
      }
    });
  });

  return { server, ctx };
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path.startsWith('/api/')) return handleApi(req, res, ctx, url);
  return serveStatic(res, path);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  url: URL,
): Promise<void> {
  const { service, sessions } = ctx;
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = method === 'GET' || method === 'HEAD' ? null : await readJson(req);

  // Public endpoint: switch user (demo-grade authentication).
  if (segments[1] === 'sessions' && method === 'POST') {
    const userId = body?.userId;
    const user = service.authenticate(userId);
    const sessionId = cryptoRandomId();
    sessions.set(sessionId, { userId: user.id, createdAt: new Date().toISOString() });
    sendJson(res, 201, {
      sessionId,
      user: { ...user, roleLabel: ROLE_LABEL[user.role] },
    });
    return;
  }

  if (segments[1] === 'sessions' && method === 'DELETE') {
    const sid = req.headers['x-session-id'];
    if (typeof sid === 'string') sessions.delete(sid);
    sendJson(res, 200, { ok: true });
    return;
  }

  const sid = req.headers['x-session-id'];
  const session = typeof sid === 'string' ? sessions.get(sid) : undefined;
  const user = service.authenticate(session?.userId);

  const route = segments.slice(1).join('/');

  // ---- meta ----
  if (route === 'me' && method === 'GET') {
    sendJson(res, 200, { ...user, roleLabel: ROLE_LABEL[user.role] });
    return;
  }
  if (route === 'users' && method === 'GET') {
    sendJson(res, 200, service.db.users.map((u) => ({ ...u, roleLabel: ROLE_LABEL[u.role] })));
    return;
  }
  if (route === 'metrics' && method === 'GET') {
    sendJson(res, 200, service.db.metrics);
    return;
  }
  if (route === 'source-data' && method === 'GET') {
    sendJson(res, 200, service.db.sourceData);
    return;
  }
  if (route === 'audit' && method === 'GET') {
    sendJson(res, 200, service.listAudit(user));
    return;
  }

  // ---- reports / versions ----
  if (route === 'reports' && method === 'GET') {
    sendJson(res, 200, service.listReports(user));
    return;
  }
  if (segments[1] === 'reports' && segments[3] === undefined && method === 'GET') {
    sendJson(res, 200, service.getReport(user, segments[2]!));
    return;
  }
  if (segments[1] === 'versions' && segments[3] === undefined && method === 'GET') {
    sendJson(res, 200, service.getVersion(user, segments[2]!));
    return;
  }
  if (segments[1] === 'reports' && segments[3] === 'rollback' && method === 'POST') {
    const version = service.rollback(
      user,
      segments[2]!,
      String(body?.targetVersionId ?? ''),
      String(body?.reason ?? ''),
    );
    sendJson(res, 201, version);
    return;
  }

  // ---- change analysis & revision creation ----
  if (route === 'changes/preview' && method === 'POST') {
    sendJson(res, 200, service.previewChange(user, body as ChangeInput));
    return;
  }
  if (route === 'revisions' && method === 'POST') {
    const revs = service.createRevisions(user, body as ChangeInput);
    sendJson(res, 201, revs.map((r) => service.getRevision(user, r.id)));
    return;
  }
  if (route === 'revisions' && method === 'GET') {
    sendJson(
      res,
      200,
      service.listRevisions(user, {
        status: url.searchParams.get('status') ?? undefined,
        reportId: url.searchParams.get('reportId') ?? undefined,
      }),
    );
    return;
  }
  if (segments[1] === 'revisions' && segments[3] === undefined && method === 'GET') {
    sendJson(res, 200, service.getRevision(user, segments[2]!));
    return;
  }
  if (segments[1] === 'revisions' && segments[3] === 'submit' && method === 'POST') {
    sendJson(res, 200, service.submitRevision(user, segments[2]!));
    return;
  }
  if (segments[1] === 'revisions' && segments[3] === 'cancel' && method === 'POST') {
    sendJson(res, 200, service.cancelRevision(user, segments[2]!, body?.comment));
    return;
  }
  if (segments[1] === 'revisions' && segments[3] === 'publish' && method === 'POST') {
    sendJson(res, 201, service.publishRevision(user, segments[2]!));
    return;
  }
  if (segments[1] === 'revisions' && segments[3] === 'remind' && method === 'POST') {
    sendJson(res, 200, service.remindReviewers(user, segments[2]!));
    return;
  }

  // ---- review tasks ----
  if (route === 'review-tasks' && method === 'GET') {
    sendJson(
      res,
      200,
      service.listReviewTasks(user, {
        status: url.searchParams.get('status') ?? undefined,
      }),
    );
    return;
  }
  if (segments[1] === 'review-tasks' && segments[3] === 'decision' && method === 'POST') {
    const decision = body?.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    sendJson(res, 200, service.decideReview(user, segments[2]!, decision, body?.comment));
    return;
  }

  // ---- notifications ----
  if (route === 'notifications' && method === 'GET') {
    sendJson(res, 200, service.listNotifications(user));
    return;
  }

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `接口 ${url.pathname} 不存在` } });
}

function cryptoRandomId(): string {
  // Node 24 global crypto; no external dependency needed.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const STATIC_DIR = join(dirname(), '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const safe = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(STATIC_DIR, safe);
  if (!filePath.startsWith(STATIC_DIR)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '路径非法' } });
    return;
  }
  try {
    const content = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA fallback
    try {
      const index = await readFile(join(STATIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(index);
    } catch {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
    }
  }
}

function dirname(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

// Start directly (`node src/server.ts`); tests import createApp instead.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (invokedDirectly) {
  const { createJsonStore } = await import('./store.ts');
  const dataFile = process.env.DATA_FILE ?? join(dirname(), '..', 'data', 'db.json');
  const store = createJsonStore(dataFile);
  const { server } = createApp(store);
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`报表修订流程服务已启动: http://localhost:${port}（数据文件 ${dataFile}）`);
  });
}
