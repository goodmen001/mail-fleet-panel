<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:server-network"/>已接入站点</div>
      <div style="margin-bottom:14px">
        <el-button type="primary" @click="addShow = true" v-if="isAdmin">接入站点</el-button>
        <el-button @click="checkAll">全部体检</el-button>
      </div>
      <el-table :data="sites" style="width:100%">
        <el-table-column prop="name" label="名称" width="160"/>
        <el-table-column prop="base_url" label="地址" min-width="220"/>
        <el-table-column prop="admin_email" label="管理员" width="200"/>
        <el-table-column label="状态" width="100">
          <template #default="{row}">
            <el-tag :type="row.status === 'online' ? 'success' : row.status === 'offline' ? 'danger' : 'info'" effect="dark" size="small">
              {{ row.status === 'online' ? '在线' : row.status === 'offline' ? '离线' : '未知' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240">
          <template #default="{row}">
            <el-button size="small" type="primary" @click="openConsole(row)">进入控制台</el-button>
            <el-button size="small" @click="check(row)">体检</el-button>
            <el-button size="small" type="danger" @click="del(row)" v-if="isAdmin">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="tech-card" v-if="consoleSite" style="margin-top:20px">
      <div class="tech-title">
        <Icon icon="mdi:monitor-dashboard"/>
        {{ consoleSite.name }} 控制台
        <el-tag size="small" effect="dark" type="success" style="margin-left:8px">原版界面内嵌</el-tag>
        <el-button size="small" style="margin-left:auto" @click="consoleSite = null">关闭</el-button>
      </div>
      <div class="iframe-wrap" v-loading="iframeLoading">
        <iframe v-if="iframeUrl" :src="iframeUrl" class="console-frame" allow="clipboard-write"></iframe>
      </div>
      <p class="tip" v-if="iframeTip">{{ iframeTip }}</p>
    </div>

    <el-dialog v-model="addShow" title="接入 cloud-mail 站点" width="480">
      <el-form label-width="100px">
        <el-form-item label="名称"><el-input v-model="form.name" placeholder="例如：主力站"/></el-form-item>
        <el-form-item label="站点地址"><el-input v-model="form.baseUrl" placeholder="https://mail.example.com"/></el-form-item>
        <el-form-item label="管理员邮箱"><el-input v-model="form.adminEmail" placeholder="admin@example.com"/></el-form-item>
        <el-form-item label="管理员密码"><el-input v-model="form.adminPassword" type="password" show-password/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addShow = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="add">接入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const sites = ref([])
const addShow = ref(false)
const saving = ref(false)
const consoleSite = ref(null)
const iframeUrl = ref('')
const iframeLoading = ref(false)
const iframeTip = ref('')
const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
const isAdmin = computed(() => me.role === 'admin')

const form = ref({ name: '', baseUrl: '', adminEmail: '', adminPassword: '' })

async function load() {
  const { data } = await axios.get('/site/list')
  sites.value = data.data
}

async function add() {
  saving.value = true
  try {
    await axios.post('/site/add', form.value)
    ElMessage.success('已接入')
    addShow.value = false
    form.value = { name: '', baseUrl: '', adminEmail: '', adminPassword: '' }
    load()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '接入失败')
  } finally { saving.value = false }
}

async function check(row) {
  const { data } = await axios.post(`/site/check/${row.siteId}`)
  row.status = data.data.status
  ElMessage.info(row.status === 'online' ? '在线' : '离线')
}

async function checkAll() {
  await Promise.all(sites.value.map(async s => {
    try {
      const { data } = await axios.post(`/site/check/${s.siteId}`)
      s.status = data.data.status
    } catch { s.status = 'offline' }
  }))
  ElMessage.success('体检完成')
}

async function openConsole(row) {
  consoleSite.value = row
  iframeLoading.value = true
  iframeTip.value = ''
  iframeUrl.value = ''
  try {
    const { data } = await axios.post(`/site/console/${row.siteId}/token`)
    // auto-login via localStorage injection page, then embed the site
    iframeUrl.value = `${location.origin}/api/site/console/${row.siteId}/console.html`
  } catch (e) {
    iframeTip.value = '获取站点会话失败：' + (e.response?.data?.message || e.message)
  } finally { iframeLoading.value = false }
}

async function del(row) {
  await ElMessageBox.confirm(`确定移除站点「${row.name}」？`, '提示', { type: 'warning' })
  await axios.delete('/site/delete', { params: { siteId: row.siteId } })
  ElMessage.success('已移除')
  if (consoleSite.value?.siteId === row.siteId) consoleSite.value = null
  load()
}

onMounted(load)
</script>

<style scoped>
.iframe-wrap { height: 720px; border-radius: 8px; overflow: hidden; border: 1px solid var(--panel-border); }
.console-frame { width: 100%; height: 100%; border: 0; background: #fff; }
.tip { color: #f87171; font-size: 13px; }
</style>
