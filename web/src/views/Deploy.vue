<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:key-chain"/>Cloudflare 凭证库</div>
      <el-button type="primary" size="small" @click="openAddCred" v-if="isAdmin" style="margin-bottom:12px">添加凭证</el-button>
      <el-table :data="creds" size="small">
        <el-table-column prop="name" label="名称" width="150"/>
        <el-table-column prop="kind" label="类型" width="100">
          <template #default="{row}">{{ row.kind === 'token' ? 'API Token' : 'Global Key' }}</template>
        </el-table-column>
        <el-table-column prop="accountId" label="Account ID" min-width="200">
          <template #default="{row}">
            <span class="secret" v-if="!reveal">{{ maskId(row.accountId) }}</span>
            <span v-else>{{ row.accountId || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{row}">
            <el-button size="small" type="primary" link @click="editCred(row)" v-if="isAdmin">编辑</el-button>
            <el-button size="small" type="danger" link @click="delCred(row)" v-if="isAdmin">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title">
        <Icon icon="mdi:rocket-launch-outline"/>批量部署 cloud-mail
        <el-button size="small" :type="reveal ? 'warning' : 'default'" style="margin-left:auto" @click="reveal = !reveal">
          <Icon :icon="reveal ? 'mdi:eye-off' : 'mdi:eye'"/>{{ reveal ? '隐藏账号' : '显示账号' }}
        </el-button>
      </div>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:16px"
        title="部署内容：D1 数据库 + KV + Worker + 自定义域名 + Email Routing，全自动一条龙。选择凭证后自动带出该账号下的域名；每个域名可单独指定管理员邮箱，不同 Cloudflare 账号可分开配置。"/>

      <div v-for="(g, gi) in groups" :key="gi" class="cred-group">
        <div class="group-head">
          <span class="group-label">账号 {{ gi + 1 }}</span>
          <el-select v-model="g.credId" placeholder="选择 Cloudflare 凭证" style="width:240px" @change="onCredChange(g)">
            <el-option v-for="c in creds" :key="c.credId" :label="c.name" :value="c.credId"/>
          </el-select>
          <span v-if="g.loadingZones" class="tip-txt">拉取域名中...</span>
          <span v-else-if="g.zoneError" class="tip-err">{{ g.zoneError }}</span>
          <span v-else-if="g.zones.length" class="tip-ok">{{ g.zones.length }} 个域名已带出</span>
          <el-button size="small" type="danger" link style="margin-left:auto" @click="removeGroup(gi)" v-if="groups.length > 1">移除此账号</el-button>
        </div>

        <el-table :data="g.rows" size="small" style="margin-top:8px">
          <el-table-column label="域名" min-width="220">
            <template #default="{row}">
              <el-select v-model="row.domain" placeholder="选择域名" style="width:100%" allow-create filterable>
                <el-option v-for="z in g.zones" :key="z.name" :label="z.name + (z.status !== 'active' ? '（' + z.status + '）' : '')" :value="z.name"/>
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="管理员邮箱" min-width="240">
            <template #default="{row}">
              <el-input v-model="row.adminEmail" placeholder="该域名站点的管理员邮箱，如 mail@域名"/>
            </template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{$index}">
              <el-button size="small" type="danger" link @click="g.rows.splice($index,1)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-button size="small" style="margin-top:6px" @click="g.rows.push({ domain: '', adminEmail: defaultEmail(g) })">+ 添加域名</el-button>
      </div>

      <div style="margin-top:12px">
        <el-button @click="addGroup">+ 添加 Cloudflare 账号</el-button>
      </div>

      <div style="margin-top:16px">
        <el-button type="primary" :loading="deploying" @click="startDeploy">开始批量部署</el-button>
        <span class="tip-txt" style="margin-left:10px">共 {{ totalJobs }} 个域名待部署</span>
      </div>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title"><Icon icon="mdi:history"/>部署记录</div>
      <el-table :data="records" size="small">
        <el-table-column label="域名" min-width="180">
          <template #default="{row}">
            <span class="secret" v-if="!reveal">{{ maskDomain(row.domain) }}</span>
            <span v-else>{{ row.domain }}</span>
          </template>
        </el-table-column>
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

    <el-dialog v-model="credShow" :title="editingCred ? '编辑 Cloudflare 凭证' : '添加 Cloudflare 凭证'" width="480">
      <el-form label-width="110px">
        <el-form-item label="名称"><el-input v-model="credForm.name" placeholder="例如：主账号Token"/></el-form-item>
        <el-form-item v-if="!editingCred" label="类型">
          <el-radio-group v-model="credForm.kind">
            <el-radio value="token">API Token（推荐）</el-radio>
            <el-radio value="global_key">Global API Key</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="editingCred ? '新Token/Key' : 'Token/Key'">
          <el-input v-model="credForm.token" type="password" show-password :placeholder="editingCred ? '留空表示不修改凭证' : ''"/>
        </el-form-item>
        <el-form-item v-if="credForm.kind === 'global_key'" label="注册邮箱">
          <el-input v-model="credForm.authEmail" placeholder="Cloudflare 账号登录邮箱（Global Key 必填）"/>
        </el-form-item>
        <el-form-item label="Account ID"><el-input v-model="credForm.accountId" placeholder="可留空，保存时自动从 Cloudflare 获取"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credShow = false">取消</el-button>
        <el-button type="primary" @click="saveCred">{{ editingCred ? '保存修改' : '保存并校验' }}</el-button>
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
const editingCred = ref(null)
const deploying = ref(false)
const credForm = ref({ name: '', kind: 'token', token: '', accountId: '', authEmail: '' })
const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
const isAdmin = me.role === 'admin'

// privacy toggle (default hidden) + masking helpers
const reveal = ref(false)
const maskId = (id) => id ? id.slice(0, 4) + '••••' + id.slice(-4) : '—'
const maskDomain = (d) => {
  if (!d) return ''
  const parts = d.split('.')
  return parts.length > 1 ? parts[0].slice(0, 1) + '•••.' + parts.slice(1).join('.') : d
}

// per-account deployment groups
const groups = ref([])

function newGroup() {
  return { credId: null, zones: [], rows: [{ domain: '', adminEmail: '' }], loadingZones: false, zoneError: '' }
}
// prefill rows: one per zone; admin email defaults to admin@first-domain for the first row, admin@<own domain> for the rest
function prefillRows(g) {
  g.rows = g.zones.map((z, i) => ({ domain: z.name, adminEmail: i === 0 ? 'admin@' + z.name : 'admin@' + z.name }))
}
function addGroup() { groups.value.push(newGroup()) }
function removeGroup(i) { groups.value.splice(i, 1) }

function defaultEmail(g) {
  const first = g.zones[0]?.name
  return first ? 'admin@' + first : ''
}

const totalJobs = computed(() => groups.value.reduce((n, g) => n + g.rows.filter(r => r.domain && r.adminEmail).length, 0))

async function onCredChange(g) {
  g.zones = []
  g.zoneError = ''
  g.loadingZones = true
  try {
    const { data } = await axios.get('/credential/zones', { params: { credId: g.credId } })
    g.zones = data.data || []
    prefillRows(g)
  } catch (e) {
    g.zoneError = e.response?.data?.message || '拉取域名失败'
  } finally { g.loadingZones = false }
}

async function load() {
  const [c, r] = await Promise.all([axios.get('/credential/list'), axios.get('/deploy/records')])
  creds.value = c.data.data
  records.value = r.data.data
}

function openAddCred() {
  editingCred.value = null
  credForm.value = { name: '', kind: 'token', token: '', accountId: '', authEmail: '' }
  credShow.value = true
}

function editCred(row) {
  editingCred.value = row
  credForm.value = { name: row.name, kind: row.kind, token: '', accountId: row.accountId || '', authEmail: row.authEmail || '' }
  credShow.value = true
}

async function saveCred() {
  try {
    if (editingCred.value) {
      await axios.put('/credential/edit', { ...credForm.value, credId: editingCred.value.credId })
      ElMessage.success('凭证已更新')
    } else {
      await axios.post('/credential/add', credForm.value)
      ElMessage.success('凭证已保存')
    }
    credShow.value = false
    editingCred.value = null
    credForm.value = { name: '', kind: 'token', token: '', accountId: '', authEmail: '' }
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
  const items = []
  for (const g of groups.value) {
    if (!g.credId) return ElMessage.warning('有账号分组未选择凭证')
    const domains = g.rows.filter(r => r.domain && r.adminEmail).map(r => ({ domain: r.domain.trim(), adminEmail: r.adminEmail.trim() }))
    if (!domains.length) continue
    // check duplicate domains
    items.push({ credId: g.credId, domains })
  }
  if (!items.length) return ElMessage.warning('没有可部署的域名（每个域名需要域名+管理员邮箱）')
  const all = items.flatMap(i => i.domains.map(d => d.domain))
  if (new Set(all).size !== all.length) return ElMessage.warning('存在重复域名，请检查')

  deploying.value = true
  try {
    await axios.post('/deploy/start', { items })
    ElMessage.success('部署任务已启动，稍后刷新查看进度')
    setTimeout(load, 3000)
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '启动失败')
  } finally { deploying.value = false }
}

onMounted(() => { load(); addGroup() })
</script>

<style scoped>
.cred-group { border: 1px solid var(--panel-border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.group-head { display: flex; align-items: center; gap: 10px; }
.group-label { color: var(--panel-accent); font-weight: 600; font-size: 13px; }
.tip-txt { color: #94a3b8; font-size: 12px; }
.tip-ok { color: #34d399; font-size: 12px; }
.tip-err { color: #f87171; font-size: 12px; }
.step-log { max-height: 300px; overflow: auto; font-size: 12px; font-family: monospace; }
.secret { letter-spacing: 1px; color: #9aa4b2; user-select: none; }
</style>
