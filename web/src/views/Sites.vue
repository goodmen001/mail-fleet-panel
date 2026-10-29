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
        <el-table-column label="操作" width="280">
          <template #default="{row}">
            <el-button size="small" type="primary" @click="openConsole(row)">进入控制台</el-button>
            <el-button size="small" @click="copyCred(row)" v-if="isAdmin">复制密码</el-button>
            <el-button size="small" @click="check(row)">体检</el-button>
            <el-button size="small" type="danger" @click="del(row)" v-if="isAdmin">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
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

// Open the site console in a NEW browser tab. Embedding the site in an iframe
// does not work: cloud-mail keeps its token in the site origin's localStorage,
// which a panel-origin page cannot write, and cross-origin iframes are blocked
// by browser storage partitioning (blank page). A direct tab works fine —
// the first login persists in the site origin.
async function openConsole(row) {
  window.open(row.base_url + '/login', '_blank')
  ElMessage.info(`已在新标签页打开 ${row.name} 控制台；首次登录后本浏览器会记住会话`)
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

onMounted(load)
</script>
