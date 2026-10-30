<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <Icon icon="mdi:email-fast-outline" width="26" height="26"/>
        <span>Mail Fleet</span>
      </div>
      <nav>
        <template v-for="m in menus" :key="m.path">
          <router-link v-if="!m.admin || user?.role === 'admin'" :to="m.path" class="nav-item">
            <Icon :icon="m.icon" width="19" height="19"/>
            <span>{{ m.title }}</span>
          </router-link>
        </template>
      </nav>
      <div class="ver">v{{ appVersion }}</div>
      <div class="foot" @click="logout">
        <Icon icon="mdi:logout" width="18" height="18"/>
        <span>退出</span>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <span class="page-title">{{ $route.meta.title }}</span>
        <span class="me">
          <el-tooltip content="面板版本" placement="bottom">
            <span class="ver-chip" @click="checkUpdate">v{{ appVersion }}<template v-if="newVersion"> · <b class="new-tag">有新版 {{ newVersion }}</b></template></span>
          </el-tooltip>
          {{ user?.username }} <el-tag size="small" effect="dark">{{ user?.role === 'admin' ? '管理员' : '用户' }}</el-tag>
          <el-button size="small" link @click="pwdShow = true"><Icon icon="mdi:lock-reset" width="15"/>改密</el-button>
        </span>
      </header>
      <div class="content">
        <router-view/>
      </div>
    </main>
    <el-dialog v-model="pwdShow" title="修改密码" width="400">
      <el-form label-width="80px">
        <el-form-item label="原密码"><el-input v-model="pwdForm.oldPassword" type="password" show-password/></el-form-item>
        <el-form-item label="新密码"><el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少6位"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdShow = false">取消</el-button>
        <el-button type="primary" @click="changePwd">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const router = useRouter()
const pwdShow = ref(false)
const pwdForm = ref({ oldPassword: '', newPassword: '' })

async function changePwd() {
  try {
    await axios.put('/user/password', pwdForm.value)
    ElMessage.success('密码已修改')
    pwdShow.value = false
    pwdForm.value = { oldPassword: '', newPassword: '' }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '修改失败')
  }
}
const user = computed(() => JSON.parse(localStorage.getItem('panel_user') || '{}'))

const menus = [
  { path: '/sites', icon: 'mdi:server-network', title: '站点管理' },
  { path: '/deploy', icon: 'mdi:rocket-launch-outline', title: '部署中心' },
  { path: '/version', icon: 'mdi:source-branch', title: '版本中心' },
  { path: '/users', icon: 'mdi:account-group-outline', title: '用户管理', admin: true },
]

// version comes from the server (package.json at build time); plain axios to avoid cycles
const appVersion = ref('…')
const newVersion = ref('')
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d) return d
  }
  return 0
}
onMounted(async () => {
  try {
    // axios baseURL is '/api' — do NOT repeat it here or the request hits /api/api/…
    const { data } = await axios.get('/version/app')
    appVersion.value = data.data?.version || '?'
  } catch { appVersion.value = '?' }
})
// click the version chip → check latest GitHub release; shows 有新版 when newer
async function checkUpdate() {
  if (newVersion.value) return
  try {
    const { data } = await axios.get('/version/latest')
    const latest = data.data?.tag
    if (latest && appVersion.value !== '?' && cmpVer(appVersion.value, latest) > 0) {
      newVersion.value = latest.replace(/^v/, '')
      ElMessage.success(`发现新版本 v${newVersion.value}，请更新镜像/重新下载`)
    } else {
      ElMessage.success('已是最新版本')
    }
  } catch { ElMessage.error('检查更新失败（网络原因），可稍后重试') }
}

async function logout() {
  // tell the server first: if the outbound proxy was configured by this user,
  // it is auto-removed and recorded in their history (v0.7.4)
  try { await axios.post('/user/logout') } catch { /* token expired etc. */ }
  localStorage.removeItem('panel_token')
  localStorage.removeItem('panel_user')
  router.push('/login')
}
</script>

<style scoped>
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 210px;
  background: var(--panel-card);
  border-right: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  padding: 18px 12px;
}
.brand {
  display: flex; align-items: center; gap: 8px;
  color: var(--panel-accent); font-weight: 700; letter-spacing: 1px;
  padding: 0 10px 18px; border-bottom: 1px solid var(--panel-border);
}
nav { flex: 1; margin-top: 12px; display: flex; flex-direction: column; gap: 4px; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 12px; border-radius: 8px;
  color: #9ca3af; text-decoration: none; font-size: 14px;
  border: 1px solid transparent;
}
.nav-item:hover { color: #e5e7eb; background: rgba(34,211,238,.05); }
.nav-item.router-link-active {
  color: var(--panel-accent);
  background: linear-gradient(90deg, rgba(34,211,238,.12), transparent);
  border-color: rgba(34,211,238,.25);
}
.foot {
  display: flex; align-items: center; gap: 8px;
  color: #6b7280; cursor: pointer; padding: 11px 12px; font-size: 13px;
}
.foot:hover { color: #f87171; }
.ver { color: #4b5563; font-size: 11px; text-align: center; padding-bottom: 6px; font-family: monospace; }
.ver-chip {
  cursor: pointer; font-family: monospace; font-size: 12px;
  color: #9ca3af; border: 1px solid var(--panel-border); border-radius: 10px;
  padding: 2px 10px; margin-right: 6px; user-select: none;
}
.ver-chip:hover { color: var(--panel-accent); border-color: rgba(34,211,238,.35); }
.new-tag { color: #fbbf24; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  height: 56px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; border-bottom: 1px solid var(--panel-border);
  background: rgba(17,24,39,.6);
}
.page-title { font-weight: 600; letter-spacing: 1px; }
.me { color: #9ca3af; font-size: 13px; display: flex; align-items: center; gap: 8px; }
/* min-width:0 lets el-table min-widths shrink instead of bursting the flex
   layout on narrow screens (overflow seen from ~1100px down); tables get
   their own horizontal scroll */
.content { padding: 24px; flex: 1; min-width: 0; overflow-x: auto; }
</style>
