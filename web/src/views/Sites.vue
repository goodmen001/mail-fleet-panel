<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:server-network"/>已接入站点</div>
      <div style="margin-bottom:14px">
        <!-- v0.7.5: open to all users — backend already assigns owner_id and
             lists/isolates per user; normal users manage their own sites -->
        <el-button type="primary" @click="addShow = true">接入站点</el-button>
        <el-button @click="checkAll">全部体检</el-button>
        <!-- privacy toggle: hide/show every account email on this page -->
        <el-button :type="reveal ? 'warning' : 'default'" @click="reveal = !reveal" style="float:right">
          <Icon :icon="reveal ? 'mdi:eye-off' : 'mdi:eye'"/>{{ reveal ? '隐藏账号' : '显示账号' }}
        </el-button>
      </div>
      <el-table :data="sites" style="width:100%">
        <el-table-column prop="name" label="名称" width="160"/>
        <el-table-column prop="base_url" label="地址" min-width="220">
          <template #default="{row}">
            <span class="secret" v-if="!reveal">{{ maskUrl(row.base_url) }}</span>
            <span v-else>{{ row.base_url }}</span>
          </template>
        </el-table-column>
        <el-table-column label="管理员" width="220">
          <template #default="{row}">
            <span class="secret" v-if="!reveal">{{ maskEmail(row.admin_email) }}</span>
            <span v-else>{{ row.admin_email }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{row}">
            <el-tag :type="row.status === 'online' ? 'success' : row.status === 'offline' ? 'danger' : 'info'" effect="dark" size="small">
              {{ row.status === 'online' ? '在线' : row.status === 'offline' ? '离线' : '未知' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="360">
          <template #default="{row}">
            <el-badge :value="unread[row.site_id]" :max="99" :hidden="!unread[row.site_id]" class="unread-badge">
              <el-button size="small" type="primary" @click="openConsole(row)">控制台</el-button>
            </el-badge>
            <!-- v0.7.7: open the auto-login embed URL in an external browser tab
                 instead of (or besides) the in-panel iframe console -->
            <el-button size="small" @click="openExternal(row)">外部打开</el-button>
            <el-button size="small" @click="copyCred(row)" v-if="isAdmin">复制密码</el-button>
            <el-button size="small" @click="check(row)">体检</el-button>
            <el-button size="small" type="primary" plain @click="editSite(row)" v-if="isAdmin">修改</el-button>
            <el-button size="small" type="danger" @click="del(row)" v-if="isAdmin">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- multi-console tabs: iframes stay mounted (v-show) so each console
         keeps its state while hidden; the last-clicked tab is on top and
         the others collapse automatically -->
    <div v-if="consoles.length" class="tech-card" style="margin-top:20px">
      <div class="console-tabs">
        <div v-for="c in consoles" :key="c.site_id"
             class="console-tab" :class="{ active: c.site_id === activeId }"
             @click="activateConsole(c)">
          <span class="dot" :class="unread[c.site_id] ? 'has-unread' : ''"></span>
          <span class="tab-name">{{ c.name }}</span>
          <el-badge v-if="unread[c.site_id]" :value="unread[c.site_id]" :max="99" class="tab-badge"/>
          <Icon icon="mdi:close" class="tab-close" @click.stop="closeConsole(c)"/>
        </div>
        <span style="margin-left:auto;display:flex;gap:8px">
          <el-button size="small" @click="reloadConsole(activeId)">刷新当前</el-button>
          <el-button size="small" @click="openNewTab(activeSite)">新标签页</el-button>
          <el-button size="small" type="danger" @click="closeConsole(activeSite)">关闭当前</el-button>
          <el-button size="small" type="danger" plain @click="closeAll">全部关闭</el-button>
        </span>
      </div>
      <div v-for="c in consoles" :key="c.site_id" v-show="c.site_id === activeId">
        <iframe v-if="c.url" :src="c.url" class="console-frame" referrerpolicy="no-referrer"></iframe>
      </div>
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

    <el-dialog v-model="editShow" title="修改站点信息" width="480">
      <el-form label-width="100px">
        <el-form-item label="名称"><el-input v-model="editForm.name"/></el-form-item>
        <el-form-item label="站点地址"><el-input v-model="editForm.baseUrl" placeholder="https://mail.example.com"/></el-form-item>
        <el-form-item label="管理员邮箱"><el-input v-model="editForm.adminEmail"/></el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="editForm.adminPassword" type="password" show-password placeholder="留空表示不修改密码"/>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editShow = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const sites = ref([])
const addShow = ref(false)
const saving = ref(false)
const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
const isAdmin = computed(() => me.role === 'admin')

const form = ref({ name: '', baseUrl: '', adminEmail: '', adminPassword: '' })

// privacy toggle + email masking (default hidden: 隐私保护)
const reveal = ref(false)
// mask the domain suffix too: the host part of the url and the part after @
const maskUrl = (u) => {
  if (!u) return ''
  try {
    const { protocol, host } = new URL(u)
    const parts = host.split('.')
    const maskedHost = parts.map((p, i) => (i === parts.length - 1 ? '•••' : p.slice(0, 1) + '•••')).join('.')
    return `${protocol}//${maskedHost}`
  } catch { return '••••' }
}
const maskEmail = (e) => {
  if (!e) return ''
  const [local, domain] = e.split('@')
  if (!domain) return '••••'
  const head = local.slice(0, 2)
  const dparts = domain.split('.')
  const maskedDomain = dparts.map((p, i) => (i === dparts.length - 1 ? '•••' : p.slice(0, 1) + '•••')).join('.')
  return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${maskedDomain}`
}

// ---- edit site ----
const editShow = ref(false)
const editForm = ref({ siteId: 0, name: '', baseUrl: '', adminEmail: '', adminPassword: '' })
function editSite(row) {
  editForm.value = { siteId: row.site_id, name: row.name, baseUrl: row.base_url, adminEmail: row.admin_email, adminPassword: '' }
  editShow.value = true
}
async function saveEdit() {
  saving.value = true
  try {
    await axios.put('/site/edit', editForm.value)
    ElMessage.success('站点已更新')
    editShow.value = false
    load()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '更新失败')
  } finally { saving.value = false }
}

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
  const { data } = await axios.post(`/site/check/${row.site_id}`)
  row.status = data.data.status
  ElMessage.info(row.status === 'online' ? '在线' : '离线')
}

async function checkAll() {
  await Promise.all(sites.value.map(async s => {
    try {
      const { data } = await axios.post(`/site/check/${s.site_id}`)
      s.status = data.data.status
    } catch { s.status = 'offline' }
  }))
  ElMessage.success('体检完成')
}

// ---- multi-console: one tab per open site; iframes stay mounted so hidden
// consoles keep their state. Last clicked/activated tab is shown on top —
// the others automatically collapse behind it.
const consoles = ref([])   // [{ site_id, name, url, key }]
const activeId = ref(null)
const activeSite = computed(() => consoles.value.find(c => c.site_id === activeId.value) || null)

// ---- unread badge per site (server aggregates each site's admin API) ----
const unread = ref({})     // site_id -> count|null
let unreadTimer = null
async function loadUnread() {
  try {
    const { data } = await axios.get('/site/unread')
    if (data.code === 200) unread.value = data.data
  } catch { /* offline sites are fine — badge just stays hidden */ }
}

async function openConsole(row) {
  try {
    const { data } = await axios.post(`/site/console/prepare/${row.site_id}`)
    const existing = consoles.value.find(c => c.site_id === row.site_id)
    const entry = existing || { site_id: row.site_id, name: row.name, url: '', key: '' }
    // a fresh key each activation: the 10-min HMAC embed key and injected
    // token are re-issued, so a tab opened long ago recovers on re-click
    entry.key = data.data.key
    entry.url = `/api/site/console/embed/${row.site_id}?key=${encodeURIComponent(data.data.key)}`
    if (!existing) consoles.value.push(entry)
    activeId.value = row.site_id
    ElMessage.success(`已加载 ${row.name} 控制台（自动登录）`)
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '打开控制台失败')
  }
}

// v0.7.7: open the auto-login console in an external browser tab — the embed
// key is freshly issued per click, so the new tab opens straight into the
// logged-in console (no password prompt), same as the in-panel iframe
async function openExternal(row) {
  try {
    const { data } = await axios.post(`/site/console/prepare/${row.site_id}`)
    window.open(`/api/site/console/embed/${row.site_id}?key=${encodeURIComponent(data.data.key)}`, '_blank')
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '打开失败')
  }
}

function activateConsole(c) {
  // re-activate with a fresh key so the iframe reloads logged-in (the embed
  // key/token expire after 10 min / 2 h); avoid reloading on every click
  // by only refreshing when the tab was NOT already active
  if (c.site_id !== activeId.value) {
    activeId.value = c.site_id
  } else {
    openConsole({ ...c, name: c.name })
  }
}

function reloadConsole(siteId) {
  const row = sites.value.find(s => s.site_id === siteId) || activeSite.value
  if (row) openConsole(row)
}

function closeConsole(c) {
  if (!c) return
  const idx = consoles.value.findIndex(x => x.site_id === c.site_id)
  if (idx >= 0) consoles.value.splice(idx, 1)
  if (activeId.value === c.site_id) {
    // show the most recently opened remaining tab
    activeId.value = consoles.value.length ? consoles.value[Math.max(0, idx - 1)].site_id : null
  }
}

function closeAll() {
  consoles.value = []
  activeId.value = null
}

function openNewTab(row) {
  if (row) window.open(row.base_url, '_blank')
}

// copy the stored admin password so the user can paste it once on the site login page
async function copyCred(row) {
  try {
    const { data } = await axios.get(`/site/password/${row.site_id}`)
    await navigator.clipboard.writeText(data.data.password)
    ElMessage.success(`已复制 ${data.data.email} 的密码，粘贴到站点登录页即可`)
  } catch (e) {
    // clipboard API can fail on plain http — fall back to a visible prompt
    try {
      const { data } = await axios.get(`/site/password/${row.site_id}`)
      await ElMessageBox.alert(
        `<p>管理员邮箱：<b>${data.data.email}</b></p><p>密码：<b>${data.data.password}</b></p>`,
        `${row.name} 登录信息`, { dangerouslyUseHTMLString: true })
    } catch (e2) {
      ElMessage.error(e2.response?.data?.message || '获取密码失败')
    }
  }
}

async function del(row) {
  await ElMessageBox.confirm(`确定移除站点「${row.name}」？`, '提示', { type: 'warning' })
  await axios.delete('/site/delete', { params: { siteId: row.site_id } })
  ElMessage.success('已移除')
  load()
}

onMounted(() => {
  load()
  loadUnread()
  unreadTimer = setInterval(loadUnread, 30000) // 30s poll, server caches 30s per site
})
onUnmounted(() => clearInterval(unreadTimer))
</script>

<style scoped>
.unread-badge :deep(.el-badge__content) { pointer-events: none; }
.secret { letter-spacing: 1px; color: #9aa4b2; user-select: none; }
.console-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.console-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--panel-border, #2a2f3a);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #9aa4b2;
  user-select: none;
  max-width: 220px;
}
.console-tab .tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.console-tab.active {
  color: #e7ecf3;
  border-color: #409eff;
  background: rgba(64, 158, 255, .12);
}
.console-tab .dot { width: 7px; height: 7px; border-radius: 50%; background: #4a5568; flex: none; }
.console-tab .dot.has-unread { background: #f56c6c; box-shadow: 0 0 4px #f56c6c; }
.console-tab .tab-close { color: #6b7280; }
.console-tab .tab-close:hover { color: #f56c6c; }
.console-frame {
  width: 100%;
  height: calc(100vh - 220px);
  min-height: 480px;
  border: 1px solid var(--panel-border, #2a2f3a);
  border-radius: 8px;
  background: #fff;
}
</style>
