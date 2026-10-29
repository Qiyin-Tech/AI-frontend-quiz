import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { Buffer } from 'node:buffer'
import { setTimeout } from 'node:timers/promises'

const MAX_BODY_BYTES = 16 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) { return }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message } })
}

export async function generationMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (req.url?.split('?')[0] !== '/api/generate') {
    next()
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    sendError(res, 405, 'METHOD_NOT_ALLOWED', '请使用 POST 请求。')
    return
  }

  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必须是 application/json。')
    return
  }

  const controller = new AbortController()
  const onClose = () => controller.abort()
  res.once('close', onClose)

  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size <= MAX_BODY_BYTES) { chunks.push(buffer) }
      // Consume the remaining request without buffering it so we can return JSON.
    }

    if (size > MAX_BODY_BYTES) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', '请求体不能超过 16 KiB。')
      return
    }

    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      sendError(res, 400, 'INVALID_JSON', '请求体必须是合法 JSON。')
      return
    }

    const prompt = body && typeof body === 'object' && 'prompt' in body ? body.prompt : undefined
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 2000) {
      sendError(res, 400, 'INVALID_PROMPT', 'prompt 必须是去除首尾空白后长度为 1–2000 的字符串。')
      return
    }

    const input = prompt.trim()
    const slow = input.startsWith('[slow]')
    await setTimeout(slow ? 4000 : 800, undefined, { signal: controller.signal })

    if (input.startsWith('[error]')) {
      sendError(res, 503, 'GENERATION_FAILED', '模拟生成失败，请重试或修改输入。')
      return
    }

    const subject = (slow ? input.slice('[slow]'.length).trim() : input) || '你的创作想法'
    sendJson(res, 200, {
      text: `创作主题：${subject}\n\n让这个想法成为一段值得分享的内容。从一个具体的场景开始，描述它的情绪与细节，再用一句简洁的话邀请观众走进故事。\n\n这是本地 mock 返回的固定模板文案，可继续编辑。`,
    })
  } catch {
    if (!controller.signal.aborted) {
      sendError(res, 500, 'INTERNAL_ERROR', '模拟服务处理请求失败。')
    }
  } finally {
    res.off('close', onClose)
  }
}

export function generationMock(): Plugin {
  return {
    name: 'quiz-generation-mock',
    configureServer(server) {
      server.middlewares.use(generationMiddleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(generationMiddleware)
    },
  }
}
