<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:key-chain"/>Cloudflare 凭证库</div>
      <el-button type="primary" size="small" @click="credShow = true" v-if="isAdmin" style="margin-bottom:12px">添加凭证</el-button>
      <el-table :data="creds" size="small">
        <el-table-column prop="name" label="名称" width="150"/>
        <el-table-column prop="kind" label="类型" width="100">
          <template #default="{row}">{{ row.kind === 'token' ? 'API Token' : 'Global Key' }}</template>
        </el-table-column>
        <el-table-column prop="account_id" label="Account ID" min-width="200"/>
        <el-table-column label="操作" width="80">
          <template #default="{row}"><el-button size="small" type="danger" link @click="delCred(row)" v-if="isAdmin">删除</el-button></template>
        </el-table-column>
      </el-table>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title"><Icon icon="mdi:rocket-launch-outline"/>批量部署 cloud-mail</div>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:16px"
        title="部署内容：D1 数据库 + KV + Worker + 自定义域名 + Email Routing，全自动一条龙。每次部署使用独立资源命名，可批量多域名并行。"/>
      <el-form label-width="130px" style="max-width:640px">
        <el-form-item label="Cloudflare 凭证">
          <el-select v-model="form.credId" placeholder="选择凭证" style="width:100%">
            <el-option v-for="c in creds" :key="c.credId" :label="c.name" :value="c.credId"/>
          </el-select>
        </el-form-item>
        <el-form-item label="Account ID" v-if="!selectedCred?.account_id">
          <el-input v-model="form.accountId" placeholder="Cloudflare Account ID（凭证未带出时必填）"/>
        </el-form-item>
        <el-form-item label="管理员邮箱">
          <el-input v-model="form.adminEmail" placeholder="部署后站点的管理员邮箱，如 mail@example.com"/>
        </el-form-item>
        <el-form-item label="域名列表">
          <el-input v-model="domainsText" type="textarea" :rows="4" placeholder="每行一个域名&#10;mail.example.com&#10;box.another.org"/>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="deploying" @click="startDeploy">开始批量部署</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title"><Icon icon="mdi:history"/>部署记录</div>
      <el-table :data="records" size="small">
        <el-table-column prop="domain" label="域名" min-width="180"/>
        <el-table-column label="状态" width="90">
          <template #default="{row}">
            <el-tag size="small" effect="dark" :type="row.status === 'success' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'">
              {{ row.status === 'success' ? '成功' : row.status === 'failed' ? '失败' : '进行中' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="create_time" label="时间" width="160"/>
        <el-table-column label="日志" min-width="300">
          <template #default="{row}">
            <el-popover trigger="click" width="480">
              <template #reference><el-button size="small" link type="primary">查看步骤</el-button></template>
              <div class="step-log">
                <div v-for="(s, i) in row.steps" :key="i">{{ i + 1 }}. {{ s.msg }}</div>
                <div v-if="!row.steps.length">暂无日志</div>
              </div>
            </el-popover>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="credShow" title="添加 Cloudflare 凭证" width="480">
      <el-form label-width="110px">
        <el-form-item label="名称"><el-input v-model="credForm.name" placeholder="例如：主账号Token"/></el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="credForm.kind">
            <el-radio value="token">API Token（推荐）</el-radio>
            <el-radio value="global_key">Global API Key</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="Token/Key"><el-input v-model="credForm.token" type="password" show-password/></el-form-item>
        <el-form-item label="Account ID"><el-input v-model="credForm.accountId" placeholder="可留空，部署时再填"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credShow = false">取消</el-button>
        <el-button type="primary" @click="addCred">保存并校验</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const creds = ref([])
const records = ref([])
const credShow = ref(false)
const deploying = ref(false)
const domainsText = ref('')
const form = ref({ credId: null, accountId: '', adminEmail: '' })
const credForm = ref({ name: '', kind: 'token', token: '', accountId: '' })
const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
const isAdmin = me.role === 'admin'
const selectedCred = computed(() => creds.value.find(c => c.credId === form.value.credId))

async function load() {
  const [c, r] = await Promise.all([axios.get('/credential/list'), axios.get('/deploy/records')])
  creds.value = c.data.data
  records.value = r.data.data
}

async function addCred() {
  try {
    await axios.post('/credential/add', credForm.value)
    ElMessage.success('凭证已保存')
    credShow.value = false
    credForm.value = { name: '', kind: 'token', token: '', accountId: '' }
    load()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '保存失败')
  }
}

async function delCred(row) {
  await ElMessageBox.confirm(`删除凭证「${row.name}」？`, '提示', { type: 'warning' })
  await axios.delete('/credential/delete', { params: { credId: row.credId } })
  load()
}

async function startDeploy() {
  const domains = domainsText.value.split('\n').map(s => s.trim()).filter(Boolean)
  if (!domains.length) return ElMessage.warning('请填写域名')
  deploying.value = true
  try {
    await axios.post('/deploy/start', {
      credId: form.value.credId,
      accountId: form.value.accountId || undefined,
      domains,
      adminEmail: form.value.adminEmail
    })
    ElMessage.success('部署任务已启动，稍后刷新查看进度')
    setTimeout(load, 3000)
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '启动失败')
  } finally { deploying.value = false }
}

onMounted(load)
</script>

<style scoped>
.step-log { max-height: 300px; overflow: auto; font-size: 12px; font-family: monospace; }
</style>
