import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
// eslint-disable-next-line test/no-import-node-test -- Use the built-in runner without adding a dependency.
import { after, before, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { generationMiddleware } from './generation.ts'

let server
let baseUrl

before(async () => {
  server = createServer((req, res) => {
    void generationMiddleware(req, res, () => {
      res.writeHead(404)
      res.end('Not found')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  const closed = once(server, 'close')
  server.close()
  server.closeAllConnections()
  await closed
})

function generate(prompt, options = {}) {
  return fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ prompt }),
    ...options,
  })
}

test('returns deterministic text for valid input and keeps requests independent', async () => {
  const started = performance.now()
  const [
    first,
    second,
    repeated,
  ] = await Promise.all([
    generate('  雨夜钢琴  '),
    generate('旅行短片'),
    generate('雨夜钢琴'),
  ])
  assert.equal(first.status, 200)
  assert.match(first.headers.get('content-type'), /application\/json/)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  const firstBody = await first.json()
  assert.match(firstBody.text, /雨夜钢琴/)
  const secondBody = await second.json()
  assert.match(secondBody.text, /旅行短片/)
  assert.deepEqual(await repeated.json(), firstBody)
  assert.ok(performance.now() - started >= 750)
})

test('slow requests do not block other requests', async () => {
  const started = performance.now()
  let slowFinished = false
  const slow = generate('[slow] 日落海边').then((response) => {
    slowFinished = true
    return response
  })
  const fast = await generate('清晨')
  assert.equal(fast.status, 200)
  assert.equal(slowFinished, false)
  const response = await slow
  assert.equal(response.status, 200)
  const { text } = await response.json()
  assert.match(text, /日落海边/)
  assert.doesNotMatch(text, /\[slow\]/)
  assert.ok(performance.now() - started >= 3900)
})

test('error scenario fails consistently; editing input allows recovery', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generate('[error] 雨夜')
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error.code, 'GENERATION_FAILED')
  }
  const recovered = await generate('雨夜')
  assert.equal(recovered.status, 200)
})

test('validates JSON, prompt boundaries and request body size', async () => {
  for (const body of [
    '{',
    'null',
    '[]',
    '{}',
    '{"prompt":42}',
    '{"prompt":"  "}',
    JSON.stringify({ prompt: '字'.repeat(2001) }),
  ]) {
    const response = await generate('', { body })
    assert.equal(response.status, 400)
    const errorBody = await response.json()
    assert.ok(errorBody.error.message)
  }
  const boundary = await generate('字'.repeat(2000))
  assert.equal(boundary.status, 200)
  const tooLarge = await generate('x'.repeat(17000))
  assert.equal(tooLarge.status, 413)
  const tooLargeBody = await tooLarge.json()
  assert.equal(tooLargeBody.error.code, 'PAYLOAD_TOO_LARGE')
})

test('rejects wrong method and media type, and passes unrelated URLs through', async () => {
  const wrongMethod = await fetch(`${baseUrl}/api/generate`)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')
  const wrongMedia = await generate('test', { headers: { 'Content-Type': 'text/plain' } })
  const unrelated = await fetch(`${baseUrl}/other`)
  const similar = await fetch(`${baseUrl}/api/generate-other`)
  assert.equal(wrongMedia.status, 415)
  assert.equal(unrelated.status, 404)
  assert.equal(similar.status, 404)
})

test('client cancellation does not break subsequent requests', async () => {
  const controller = new AbortController()
  const pending = generate('[slow] cancel', { signal: controller.signal })
  const rejection = assert.rejects(pending, { name: 'AbortError' })
  await setTimeout(100)
  controller.abort()
  await rejection
  const response = await generate('still available')
  assert.equal(response.status, 200)
})
