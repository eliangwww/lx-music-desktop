import { randomUUID } from 'node:crypto'
import { DATA_KEYS, STORE_NAMES } from '@common/constants'
import { httpFetch } from '@main/utils/request'
import getStore from '@main/utils/store'
import { getLocalListData, registerListActionEvent, setLocalListData } from './listEvent'

interface CloudDocument {
  schemaVersion: 1
  revision: string
  updatedAt: number
  deviceId: string
  data: {
    listData: LX.Sync.List.ListData
    playInfo: LX.Player.SavedPlayInfo | null
  }
}

interface CloudResponse {
  data: CloudDocument | null
}

interface CloudMeta {
  syncId: string
  revision: string
  updatedAt: number
}

const LIST_PUSH_DELAY = 2000
const PLAYBACK_PUSH_DELAY = 120000
const PULL_INTERVAL = 300000
const META_KEY = 'cloudSyncMeta'
const DEVICE_ID_KEY = 'cloudSyncDeviceId'

let enabled = false
let dirty = false
let syncing: Promise<LX.Sync.CloudStatus> | null = null
let pushTimer: NodeJS.Timeout | null = null
let pullTimer: NodeJS.Timeout | null = null
let unregisterListEvent: (() => void) | null = null
let status: LX.Sync.CloudStatus = {
  enabled: false,
  syncing: false,
  message: '',
  lastSyncTime: 0,
}

const getSyncStore = () => getStore(STORE_NAMES.SYNC)

const getDeviceId = () => {
  const store = getSyncStore()
  let deviceId = store.get<string>(DEVICE_ID_KEY)
  if (!deviceId) {
    deviceId = randomUUID()
    store.set(DEVICE_ID_KEY, deviceId)
  }
  return deviceId
}

const getMeta = () => getSyncStore().get<CloudMeta | undefined>(META_KEY)

const saveMeta = (document: CloudDocument) => {
  getSyncStore().set(META_KEY, {
    syncId: global.lx.appSetting['sync.cloud.syncId'],
    revision: document.revision,
    updatedAt: document.updatedAt,
  } satisfies CloudMeta)
}

const getConfig = () => ({
  endpoint: global.lx.appSetting['sync.cloud.endpoint'].trim().replace(/\/$/, ''),
  syncId: global.lx.appSetting['sync.cloud.syncId'].trim(),
  token: global.lx.appSetting['sync.cloud.token'],
})

const getRequestUrl = () => {
  const config = getConfig()
  if (!config.endpoint || !config.syncId || !config.token) throw new Error('请先填写 Worker 地址、同步 ID 和访问令牌')
  const url = new URL(config.endpoint)
  if (url.protocol != 'https:' && url.hostname != 'localhost' && url.hostname != '127.0.0.1') {
    throw new Error('Worker 地址必须使用 HTTPS')
  }
  return `${config.endpoint}/v1/sync/${encodeURIComponent(config.syncId)}`
}

const request = async(method: 'GET' | 'PUT', document?: Omit<CloudDocument, 'revision' | 'updatedAt'>) => {
  const response = await httpFetch<CloudResponse>(getRequestUrl(), {
    method,
    headers: {
      Authorization: `Bearer ${getConfig().token}`,
    },
    json: document as unknown as Record<string, unknown>,
    timeout: 20000,
    retryNum: 1,
  })
  if (response.statusCode != null && response.statusCode >= 400) {
    const message = typeof response.body == 'object' && response.body != null && 'error' in response.body
      ? String(response.body.error)
      : `HTTP ${response.statusCode}`
    throw new Error(message)
  }
  return response.body
}

const getLocalDocument = async(): Promise<Omit<CloudDocument, 'revision' | 'updatedAt'>> => ({
  schemaVersion: 1,
  deviceId: getDeviceId(),
  data: {
    listData: await getLocalListData(),
    playInfo: getStore(STORE_NAMES.DATA).get<LX.Player.SavedPlayInfo | null>(DATA_KEYS.playInfo) ?? null,
  },
})

const applyRemoteDocument = async(document: CloudDocument) => {
  if (document.schemaVersion != 1) throw new Error('不支持的云端数据版本')
  await setLocalListData(document.data.listData)
  getStore(STORE_NAMES.DATA).set(DATA_KEYS.playInfo, document.data.playInfo)
  saveMeta(document)
}

const pushLocal = async() => {
  const response = await request('PUT', await getLocalDocument())
  if (!response.data) throw new Error('云端未返回同步数据')
  dirty = false
  saveMeta(response.data)
}

const pullRemote = async() => {
  const response = await request('GET')
  if (!response.data) {
    await pushLocal()
    return
  }
  const meta = getMeta()
  if (meta?.syncId != getConfig().syncId || response.data.updatedAt > meta.updatedAt) {
    await applyRemoteDocument(response.data)
  }
}

export const syncCloudNow = async(forcePush = false): Promise<LX.Sync.CloudStatus> => {
  if (syncing) return syncing
  syncing = (async() => {
    status = { ...status, enabled, syncing: true, message: '' }
    try {
      const meta = getMeta()
      if (forcePush || (dirty && meta?.syncId == getConfig().syncId)) await pushLocal()
      else await pullRemote()
      Object.assign(status, { enabled, syncing: false, message: '', lastSyncTime: Date.now() })
    } catch (err) {
      Object.assign(status, {
        enabled,
        syncing: false,
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return status
  })().finally(() => {
    syncing = null
  })
  return syncing
}

export const notifyCloudSyncDataChanged = (delay = PLAYBACK_PUSH_DELAY) => {
  if (!enabled) return
  dirty = true
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void syncCloudNow()
  }, delay)
}

export const stopCloudSync = () => {
  enabled = false
  status = { ...status, enabled: false, syncing: false }
  if (pushTimer) clearTimeout(pushTimer)
  if (pullTimer) clearInterval(pullTimer)
  pushTimer = null
  pullTimer = null
  unregisterListEvent?.()
  unregisterListEvent = null
}

export const startCloudSync = () => {
  stopCloudSync()
  enabled = true
  status = { ...status, enabled: true }
  unregisterListEvent = registerListActionEvent(() => {
    notifyCloudSyncDataChanged(LIST_PUSH_DELAY)
  })
  pullTimer = setInterval(() => {
    void syncCloudNow()
  }, PULL_INTERVAL)
  void syncCloudNow()
}

export const getCloudStatus = () => status

export const initCloudSync = () => {
  global.lx.event_app.on('app_inited', () => {
    if (global.lx.appSetting['sync.enable'] && global.lx.appSetting['sync.mode'] == 'cloud') startCloudSync()
  })
  global.lx.event_app.on('updated_config', keys => {
    if (!keys.some(key => key == 'sync.enable' || key == 'sync.mode' || key.startsWith('sync.cloud.'))) return
    if (global.lx.appSetting['sync.enable'] && global.lx.appSetting['sync.mode'] == 'cloud') startCloudSync()
    else stopCloudSync()
  })
  global.lx.event_app.on('main_window_close', stopCloudSync)
}
