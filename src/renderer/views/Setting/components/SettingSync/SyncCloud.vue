<template lang="pug">
dd
  h3 {{ $t('setting__sync_cloud_mode') }}
  .p.small {{ $t('setting__sync_cloud_scope') }}
  .p
    .p.small {{ $t('setting__sync_cloud_endpoint') }}
    base-input(:class="$style.input" :model-value="appSetting['sync.cloud.endpoint']" :disabled="sync.enable" placeholder="https://lx-sync.example.workers.dev" @update:model-value="setEndpoint")
  .p
    .p.small {{ $t('setting__sync_cloud_sync_id') }}
    base-input(:class="$style.input" :model-value="appSetting['sync.cloud.syncId']" :disabled="sync.enable" placeholder="my-music" @update:model-value="setSyncId")
  .p
    .p.small {{ $t('setting__sync_cloud_token') }}
    base-input(:class="$style.input" :model-value="appSetting['sync.cloud.token']" :disabled="sync.enable" type="password" @update:model-value="setToken")
  .p.small {{ statusText }}
  .p(:class="$style.actions")
    base-btn(min :disabled="status.syncing || !configured" @click="handleSync(false)") {{ $t('setting__sync_cloud_pull') }}
    base-btn(min :disabled="status.syncing || !configured" @click="handleSync(true)") {{ $t('setting__sync_cloud_push') }}
</template>

<script>
import { computed, onMounted, reactive } from '@common/utils/vueTools'
import { sync } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { getCloudSyncStatus, syncCloudNow } from '@renderer/utils/ipc'
import { debounce } from '@common/utils/common'
import { useI18n } from '@renderer/plugins/i18n'

export default {
  name: 'SettingSyncCloud',
  setup() {
    const t = useI18n()
    const status = reactive({ enabled: false, syncing: false, message: '', lastSyncTime: 0 })
    const configured = computed(() => Boolean(
      appSetting['sync.cloud.endpoint'] && appSetting['sync.cloud.syncId'] && appSetting['sync.cloud.token'],
    ))
    const statusText = computed(() => {
      if (status.syncing) return t('setting__sync_cloud_syncing')
      if (status.message) return t('setting__sync_cloud_error', { message: status.message })
      if (status.lastSyncTime) return t('setting__sync_cloud_last_sync', { time: new Date(status.lastSyncTime).toLocaleString() })
      return t('setting__sync_cloud_not_synced')
    })
    const applyStatus = newStatus => Object.assign(status, newStatus)
    const handleSync = async(forcePush) => {
      status.syncing = true
      applyStatus(await syncCloudNow(forcePush))
    }
    onMounted(async() => {
      applyStatus(await getCloudSyncStatus())
    })
    return {
      appSetting,
      sync,
      status,
      configured,
      statusText,
      handleSync,
      setEndpoint: debounce(value => {
        updateSetting({ 'sync.cloud.endpoint': value.trim() })
      }, 500),
      setSyncId: debounce(value => {
        updateSetting({ 'sync.cloud.syncId': value.trim() })
      }, 500),
      setToken: debounce(value => {
        updateSetting({ 'sync.cloud.token': value })
      }, 500),
    }
  },
}
</script>

<style lang="less" module>
.input {
  min-width: 380px;
  max-width: 100%;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
