#!/usr/bin/env node
// ═══════════════════════════════════════════════════
// 笔友 MCP 服务器 (Penpal)
// 让小机通过 QQ 邮箱交笔友：发邮件、收邮件、读邮件
//
// MCP 接入: http://localhost:3457/mcp
// ═══════════════════════════════════════════════════

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

const PORT = parseInt(process.env.PORT || '3457', 10);
const BASE_PATH = process.env.BASE_PATH || ''; // nginx 代理前缀，如 /penpal

// ═══════════════════════════════════════
//  SMTP 发件器
// ═══════════════════════════════════════
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.qq.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

// ═══════════════════════════════════════
//  IMAP 收件器
// ═══════════════════════════════════════
function createImapClient() {
  return new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.qq.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: process.env.IMAP_USER || '',
      pass: process.env.IMAP_PASS || '',
    },
    logger: false,
  });
}

// ═══════════════════════════════════════
//  创建 MCP 服务器
// ═══════════════════════════════════════
function createMcpServer() {
  const server = new McpServer({
    name: 'penpal',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  server.tool(
    'send_email',
    '发送一封邮件给笔友。to: 收件人邮箱, subject: 主题, body: 正文（支持纯文本和简单HTML）',
    {
      to:      z.string().describe('收件人邮箱地址'),
      subject: z.string().describe('邮件主题'),
      body:    z.string().describe('邮件正文，支持纯文本'),
    },
    async (params) => {
      try {
        const info = await transporter.sendMail({
          from: `"笔友小机" <${process.env.SMTP_USER}>`,
          to: params.to,
          subject: params.subject,
          text: params.body,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: '邮件已发送 ✅',
              messageId: info.messageId,
              to: params.to,
              subject: params.subject,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `发送失败: ${e.message}` }, null, 2) }],
        };
      }
    }
  );

  server.tool(
    'list_emails',
    '列出收件箱中的邮件。limit: 返回数量（默认10），folder: 文件夹（默认INBOX）',
    {
      limit:  z.number().optional().describe('返回邮件数量，默认 10'),
      folder: z.string().optional().describe('文件夹名，默认 INBOX'),
    },
    async (params) => {
      const client = createImapClient();
      try {
        await client.connect();
        const lock = await client.getMailboxLock(params.folder || 'INBOX');
        try {
          const limit = params.limit || 10;
          const messages = [];
          const status = await client.mailboxOpen(params.folder || 'INBOX');
          const end = status.exists;
          const start = Math.max(1, end - limit + 1);

          for await (const msg of client.fetch(`${start}:${end}`, {
            envelope: true,
            flags: true,
            uid: true,
          })) {
            const isSeen = msg.flags?.has?.('\\Seen') ?? !msg.flags?.includes?.('\\Seen') ?? false;
            messages.unshift({
              uid: msg.uid,
              subject: msg.envelope.subject || '(无主题)',
              from: msg.envelope.from?.[0]?.address || '未知',
              fromName: msg.envelope.from?.[0]?.name || '',
              date: msg.envelope.date?.toISOString() || '',
              seen: isSeen,
            });
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                folder: params.folder || 'INBOX',
                total: status.exists,
                count: messages.length,
                emails: messages,
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `读取失败: ${e.message}` }) }],
        };
      } finally {
        await client.logout().catch(() => {});
      }
    }
  );

  server.tool(
    'read_email',
    '读取指定邮件的完整内容。uid: 邮件UID（从 list_emails 获取）',
    {
      uid: z.number().describe('邮件 UID'),
    },
    async (params) => {
      const client = createImapClient();
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          const msgs = [];
          for await (const msg of client.fetch({ uid: params.uid }, {
            source: true,
            envelope: true,
            uid: true,
          })) {
            let body = '';
            if (msg.source) {
              const src = Buffer.from(msg.source).toString('utf-8');
              const srcLF = src.replace(/\r\n/g, '\n');

              // 解析 MIME part 的辅助函数
              const decodePart = (headers, rawBody) => {
                const enc = (headers.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1]?.toLowerCase();
                let text = rawBody.replace(/\r/g, '').trim();
                if (enc === 'base64') {
                  try { text = Buffer.from(text.replace(/[\s\n]/g, ''), 'base64').toString('utf-8'); } catch {}
                } else if (enc === 'quoted-printable') {
                  text = text.replace(/=\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                }
                return text;
              };

              // 方式 1: MIME boundary 切分（QQ邮箱 / Gmail multipart）
              const bm = srcLF.match(/boundary="?([^"\n]+?)"?\n/i);
              const boundary = bm?.[1];
              if (boundary) {
                const parts = srcLF.split('--' + boundary);
                for (const part of parts) {
                  const headerEnd = part.indexOf('\n\n');
                  if (headerEnd < 0) continue;
                  const headers = part.substring(0, headerEnd);
                  const rawBody = part.substring(headerEnd + 2);
                  // 优先取 text/plain，跳过 text/html 和 multipart/alternative
                  if (headers.includes('text/plain') && !headers.includes('text/html')) {
                    body = decodePart(headers, rawBody);
                    if (body) break;
                  }
                }
                // fallback: 取第一个能解析出正文的 text/html
                if (!body) {
                  for (const part of parts) {
                    const headerEnd = part.indexOf('\n\n');
                    if (headerEnd < 0) continue;
                    const headers = part.substring(0, headerEnd);
                    if (headers.includes('text/html') && !headers.includes('multipart/alternative')) {
                      let html = decodePart(headers, part.substring(headerEnd + 2));
                      if (html) {
                        body = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                          .replace(/\s+/g, ' ').trim();
                        if (body) break;
                      }
                    }
                  }
                }
              }

              // 方式 2: 非 multipart（纯 text/plain）
              if (!body) {
                const re = /Content-Type:\s*text\/plain[\s\S]*?(?:Content-Transfer-Encoding:\s*(\S+))?[\s\S]*?\n\n([\s\S]*?)(?:\n--[A-Za-z0-9]|$)/i;
                const m = srcLF.match(re);
                if (m) {
                  body = decodePart('Content-Transfer-Encoding: ' + (m[1] || '7bit'), m[2] || '');
                }
              }

              // 方式 3: 最后兜底——全文 base64
              if (!body) {
                const allB64 = srcLF.match(/Content-Transfer-Encoding:\s*base64\n\n([A-Za-z0-9+/=\s]+)/i);
                if (allB64?.[1]) {
                  try { body = Buffer.from(allB64[1].replace(/[\s\n]/g, ''), 'base64').toString('utf-8'); } catch {}
                }
              }

              if (body && body.length > 5000) body = body.substring(0, 5000) + '\n\n[... 内容过长，已截断 ...]';
            }

            msgs.push({
              uid: msg.uid,
              subject: msg.envelope.subject || '(无主题)',
              from: msg.envelope.from?.[0]?.address || '未知',
              fromName: msg.envelope.from?.[0]?.name || '',
              date: msg.envelope.date?.toISOString() || '',
              to: msg.envelope.to?.map(t => t.address).join(', ') || '',
              body: body || '(无法解析正文)',
            });
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                email: msgs[0] || null,
                hint: msgs.length === 0 ? '未找到该邮件' : null,
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `读取失败: ${e.message}` }) }],
        };
      } finally {
        await client.logout().catch(() => {});
      }
    }
  );

  server.tool(
    'search_emails',
    '按关键词搜索邮件。query: 搜索词（在主题和发件人中匹配）',
    {
      query: z.string().describe('搜索关键词'),
      limit: z.number().optional().describe('返回数量，默认 20'),
    },
    async (params) => {
      const client = createImapClient();
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          const messages = [];
          const query = params.query || '';
          // IMAP 搜索：主题 OR 发件人
          const searchQuery = {
            or: [
              { subject: query },
              { from: query },
              { body: query },
            ],
          };

          for await (const msg of client.fetch(searchQuery, {
            envelope: true,
            uid: true,
          }, { limit: params.limit || 20 })) {
            messages.push({
              uid: msg.uid,
              subject: msg.envelope.subject || '(无主题)',
              from: msg.envelope.from?.[0]?.address || '未知',
              fromName: msg.envelope.from?.[0]?.name || '',
              date: msg.envelope.date?.toISOString() || '',
            });
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                query,
                count: messages.length,
                emails: messages,
                hint: messages.length === 0 ? `没有找到和「${query}」相关的邮件` : null,
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `搜索失败: ${e.message}` }) }],
        };
      } finally {
        await client.logout().catch(() => {});
      }
    }
  );

  return server;
}

// ═══════════════════════════════════════
//  HTTP 应用
// ═══════════════════════════════════════
const app = createMcpExpressApp({ host: '0.0.0.0' });

const transports = {};

app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId]) {
      const existing = transports[sessionId];
      if (existing instanceof StreamableHTTPServerTransport) {
        transport = existing;
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad transport' }, id: null });
        return;
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sid) => { transports[sid] = transport; },
      });
      transport.onclose = () => { const sid = transport.sessionId; if (sid) delete transports[sid]; };
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No session' }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[penpal] MCP 错误:', e.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport(BASE_PATH + '/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => { delete transports[transport.sessionId]; });
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
});

// POST 路由不需要 BASE_PATH（nginx 代理时会自动剥离前缀）
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport instanceof SSEServerTransport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).json({ error: 'No transport' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
✉️  笔友 (Penpal) MCP 已启动
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MCP 接入:  http://localhost:${PORT}/mcp
  SSE 兼容:  http://localhost:${PORT}/sse
  邮箱:      ${process.env.SMTP_USER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

process.on('SIGINT', async () => {
  for (const sid in transports) {
    try { await transports[sid].close(); } catch {}
    delete transports[sid];
  }
  process.exit(0);
});
