interface KVNamespace {
  get<T>(key: string, type: 'json'): Promise<T | null>
  put(key: string, value: string): Promise<void>
}

interface Env {
  SYNC_KV: KVNamespace
  SYNC_TOKEN: string
}

interface SyncDocument {
  schemaVersion: 1
  revision: string
  updatedAt: number
  deviceId: string
  data: {
    listData: object
    playInfo: unknown
  }
}

interface IncomingDocument {
  schemaVersion: number
  deviceId: string
  data: {
    listData: object
    playInfo: unknown
  }
}

const MAX_BODY_SIZE = 8 * 1024 * 1024
const SYNC_ID_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
})

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value == 'object' && value != null && !Array.isArray(value)
}

const validateDocument = (value: unknown): value is IncomingDocument => {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  if (typeof value.deviceId != 'string' || value.deviceId.length < 1 || value.deviceId.length > 128) return false
  if (!isRecord(value.data) || !isRecord(value.data.listData)) return false
  return 'playInfo' in value.data
}

const tokensMatch = (actual: string, expected: string) => {
  const encoder = new TextEncoder()
  const actualBytes = encoder.encode(actual)
  const expectedBytes = encoder.encode(expected)
  const length = Math.max(actualBytes.length, expectedBytes.length)
  let difference = actualBytes.length ^ expectedBytes.length
  for (let index = 0; index < length; index++) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0)
  }
  return difference === 0
}

const isAuthorized = (request: Request, env: Env) => {
  if (!env.SYNC_TOKEN) return false
  const authorization = request.headers.get('authorization') ?? ''
  return authorization.startsWith('Bearer ') && tokensMatch(authorization.slice(7), env.SYNC_TOKEN)
}

const getSyncId = (url: URL) => {
  const match = /^\/v1\/sync\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  try {
    const syncId = decodeURIComponent(match[1])
    return SYNC_ID_PATTERN.test(syncId) ? syncId : null
  } catch {
    return null
  }
}

const readRequestBody = async(request: Request) => {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_SIZE) throw new Error('PAYLOAD_TOO_LARGE')
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_SIZE) throw new Error('PAYLOAD_TOO_LARGE')
  return JSON.parse(body) as unknown
}

const handleRequest = async(request: Request, env: Env) => {
  const syncId = getSyncId(new URL(request.url))
  if (!syncId) return json({ error: 'Not found' }, 404)
  if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401)

  const key = `sync:${syncId}`
  if (request.method == 'GET') {
    const document = await env.SYNC_KV.get<SyncDocument>(key, 'json')
    return json({ data: document })
  }

  if (request.method == 'PUT') {
    let incoming: unknown
    try {
      incoming = await readRequestBody(request)
    } catch (error) {
      return error instanceof Error && error.message == 'PAYLOAD_TOO_LARGE'
        ? json({ error: 'Payload too large' }, 413)
        : json({ error: 'Invalid JSON body' }, 400)
    }
    if (!validateDocument(incoming)) return json({ error: 'Invalid sync document' }, 400)

    const document: SyncDocument = {
      schemaVersion: 1,
      revision: crypto.randomUUID(),
      updatedAt: Date.now(),
      deviceId: incoming.deviceId,
      data: incoming.data,
    }
    await env.SYNC_KV.put(key, JSON.stringify(document))
    return json({ data: document })
  }

  return json({ error: 'Method not allowed' }, 405)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env)
    } catch (error) {
      console.error(error)
      return json({ error: 'Internal server error' }, 500)
    }
  },
}