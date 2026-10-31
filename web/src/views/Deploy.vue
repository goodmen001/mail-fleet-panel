<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:key-chain"/>Cloudflare 凭证库<span class="tip-txt" style="margin-left:10px;font-weight:400">仅显示 {{ isAdmin ? '全部用户的' : '你自己的' }}凭证</span></div>
      <el-button type="primary" size="small" @click="openAddCred" style="margin-bottom:12px">添加凭证</el-button>
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
        title="部署内容：D1 数据库 + KV + Worker + 自定义域名 + Email Routing，全自动一条龙。选择凭证后自动带出该账号下的域名；每个域名可单独指定管理员邮箱，不同 Cloudflare 账号可分开配置。已部署过的域名会自动识别为升级：只更新邮局版本，原有邮件/用户/配置数据全部保留。"/>

      <el-form-item label="部署包" label-width="80px" style="margin-bottom:14px">
        <el-select v-model="pkgId" placeholder="使用面板内置定制包" style="width:320px" clearable>
          <el-option label="内置定制包（随面板安装）" :value="0"/>
          <el-option label="内置官方包（随面板安装，原版）" :value="-1"/>
          <el-option v-for="p in pkgs" :key="p.pkgId" :value="p.pkgId"
            :label="(p.kind === 'custom' ? '[定制] ' : '[官方] ') + p.name + (p.version ? ' v' + p.version : '')"/>
        </el-select>
        <span class="tip-txt" style="margin-left:10px">在版本中心可上传定制包 / 导入官方包；官方包在部署中心同样可选</span>
      </el-form-item>

      <div v-for="(g, gi) in groups" :key="gi" class="cred-group">
        <div class="group-head">
          <span class="group-label">账号 {{ gi + 1 }}</span>
          <el-select v-model="g.credId" placeholder="选择 Cloudflare 凭证" style="width:240px" @change="onCredChange(g)">
            <!-- 已被其它账号分组选中的凭证不再出现，避免同一账号重复部署 -->
            <el-option v-for="c in availCreds(g)" :key="c.credId" :label="c.name" :value="c.credId"/>
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
          <el-table-column label="状态" width="150">
            <template #default="{row}">
              <el-tooltip v-if="row.deployed" :content="`已识别邮箱 Worker: ${row.workerName}，点下方「已部署站点现有配置」查看详情`" placement="top">
                <el-tag size="small" :type="row.hasJwt === false ? 'danger' : 'warning'" effect="dark">
                  已部署·升级<template v-if="row.hasJwt === false">⚠</template>
                </el-tag>
              </el-tooltip>
              <el-tag v-else-if="row.checked" size="small" type="info" effect="plain">新部署</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="管理员邮箱" min-width="240">
            <template #default="{row}">
              <el-input v-model="row.adminEmail" placeholder="该域名站点的管理员邮箱，如 mail@域名"/>
            </template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{row, $index}">
              <el-button size="small" type="danger" link @click="g.rows.splice($index,1)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-button size="small" style="margin-top:6px" @click="g.rows.push({ domain: '', adminEmail: defaultEmail(g) })">+ 添加域名</el-button>

        <!-- 已部署站点的现有配置详情（升级前可视化确认） -->
        <div v-if="g.rows.some(r => r.deployed)" class="detail-panel">
          <div class="detail-head" @click="g.showDetail = !g.showDetail">
            <Icon :icon="g.showDetail ? 'mdi:chevron-down' : 'mdi:chevron-right'"/>
            <span>已部署站点现有配置（升级前请核对）</span>
            <span class="tip-txt" style="margin-left:8px">{{ g.rows.filter(r => r.deployed).length }} 个域名已是邮箱站点</span>
          </div>
          <div v-show="g.showDetail" class="detail-body">
            <div v-for="r in g.rows.filter(x => x.deployed)" :key="r.domain" class="detail-item">
              <div class="detail-domain">
                <Icon icon="mdi:email-check-outline" style="color:#34d399"/>
                <span class="secret" v-if="!reveal">{{ maskDomain(r.domain) }}</span><span v-else>{{ r.domain }}</span>
                <el-tag v-if="r.hasJwt === false" size="small" type="danger" effect="plain" style="margin-left:8px">jwt_secret 不可读，升级将中止</el-tag>
              </div>
              <table class="detail-table">
                <tr><td>Worker 名称</td><td>{{ r.workerName || '—' }}</td></tr>
                <tr>
                  <td>站点地址</td>
                  <td>
                    <span class="secret" v-if="!reveal">{{ maskDomain(r.siteDomain || ('mail.' + r.domain)) }}</span><span v-else>https://{{ r.siteDomain || ('mail.' + r.domain) }}</span>
                    <el-tag v-if="r.onMailDomain === false" size="small" type="warning" effect="plain" style="margin-left:8px">
                      当前访问地址不是 mail.{{ r.domain }}，重新部署时将自动绑定 mail.{{ r.domain }}（数据不动）
                    </el-tag>
                    <el-tag v-else-if="r.onMailDomain" size="small" type="success" effect="plain" style="margin-left:8px">
                      mail.{{ r.domain }} 访问有效
                    </el-tag>
                  </td>
                </tr>
                <tr><td>邮箱域名（发收件）</td><td><span class="secret" v-if="!reveal">{{ (r.domains || []).map(maskDomain).join('、') }}</span><span v-else>{{ (r.domains || []).join('、') || '—' }}</span></td></tr>
                <tr><td>管理员账号</td><td><span class="secret" v-if="!reveal">{{ maskEmail(r.admin) }}</span><span v-else>{{ r.admin || '—' }}</span></td></tr>
                <tr><td>自定义域名绑定</td><td><span class="secret" v-if="!reveal">{{ (r.workerDomains || []).map(maskDomain).join('、') }}</span><span v-else>{{ (r.workerDomains || []).join('、') || '—' }}</span></td></tr>
                <tr><td>D1 数据库 ID</td><td><span class="secret" v-if="!reveal">{{ maskId(r.dbId) }}</span><span v-else>{{ r.dbId || '—' }}</span></td></tr>
                <tr><td>KV 命名空间 ID</td><td><span class="secret" v-if="!reveal">{{ maskId(r.kvId) }}</span><span v-else>{{ r.kvId || '—' }}</span></td></tr>
                <tr><td>R2 存储桶</td><td>{{ r.r2Bucket || '未配置' }}</td></tr>
                <tr>
                  <td>其它绑定</td>
                  <td>
                    <el-tag v-if="r.hasSendEmail" size="small" type="success" effect="plain" style="margin-right:6px">send_email 邮件发送</el-tag>
                    <el-tag v-if="r.hasAi" size="small" type="success" effect="plain" style="margin-right:6px">AI</el-tag>
                    <el-tag v-if="r.observability" size="small" type="info" effect="plain" style="margin-right:6px">可观测性</el-tag>
                    <span v-if="r.compatDate" class="tip-txt">兼容日期 {{ r.compatDate }}</span>
                  </td>
                </tr>
              </table>
              <div class="tip-ok" style="margin-top:6px">升级只替换邮局程序；D1/KV 数据、邮件、用户、配置全部保留，jwt_secret 延用原值（登录态不失效）。</div>
            </div>
          </div>
        </div>
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
        <el-table-column label="状态" width="100">
          <template #default="{row}">
            <el-tag size="small" effect="dark" :type="row.status === 'success' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'">
              {{ row.status === 'success' ? '成功' : row.status === 'failed' ? '失败' : '进行中' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="pkg_id" label="包" width="90">
          <template #default="{row}">{{ row.pkg_id === -1 ? '内置官方' : row.pkg_id ? '版本中心' : '内置定制' }}</template>
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
const maskEmail = (e) => e ? e.slice(0, 2) + '•••@' + (e.split('@')[1] ? maskDomain(e.split('@')[1]) : '•••') : '—'

// per-account deployment groups
const groups = ref([])
// deployment package: 0/undefined = built-in custom, -1 = built-in official, else pkgId from version center
const pkgId = ref(0)
const pkgs = ref([])

async function loadPkgs() {
  try {
    const { data } = await axios.get('/version/pkgs')
    pkgs.value = (data.data || []).filter(p => p.exists)
  } catch { /* version center unreachable — keep builtin only */ }
}

function newGroup() {
  return { credId: null, zones: [], rows: [{ domain: '', adminEmail: '' }], loadingZones: false, zoneError: '', showDetail: true }
}
// prefill rows: one per zone; admin email defaults to admin@first-domain for the first row, admin@<own domain> for the rest
function prefillRows(g) {
  g.rows = g.zones.map((z, i) => ({ domain: z.name, adminEmail: i === 0 ? 'admin@' + z.name : 'admin@' + z.name }))
}
function addGroup() { groups.value.push(newGroup()) }
function removeGroup(i) { groups.value.splice(i, 1) }

// 某分组可选凭证 = 全部凭证 - 其它分组已选中的
function availCreds(g) {
  return creds.value.filter(c => c.credId === g.credId || !groups.value.some(x => x !== g && x.credId === c.credId))
}

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
    // preflight: mark domains that already have a cloud-mail worker (upgrade path)
    try {
      const { data: cd } = await axios.post('/deploy/check', { credId: g.credId, domains: g.zones.map(z => z.name) })
      for (const row of g.rows) {
        row.checked = true
        const info = cd.data?.[row.domain]
        row.deployed = !!(info?.deployed)
        row.workerName = info?.workerName || ''
        row.hasJwt = info?.hasJwt
        // carry the full existing-config summary for the detail panel
        row.admin = info?.admin || ''
        row.domains = info?.domains || []
        row.mailDomain = info?.mailDomain || ''
        row.dbId = info?.dbId || ''
        row.kvId = info?.kvId || ''
        row.r2Bucket = info?.r2Bucket || ''
        row.hasSendEmail = !!info?.hasSendEmail
        row.hasAi = !!info?.hasAi
        row.compatDate = info?.compatDate || ''
        row.siteDomain = info?.siteDomain || ''
        row.onMailDomain = info?.onMailDomain
        row.observability = !!info?.observability
        row.workerDomains = info?.workerDomains || []
        if (info?.deployed) g.showDetail = true
      }
    } catch { /* preflight is advisory only */ }
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
    items.push({ credId: g.credId, pkgId: pkgId.value || null, domains })
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

onMounted(() => { load(); loadPkgs(); addGroup() })
</script>

<style scoped>
.cred-group { border: 1px solid var(--panel-border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.group-head { display: flex; align-items: center; gap: 10px; }
.group-label { color: var(--panel-accent); font-weight: 600; font-size: 13px; }
.tip-txt { color: #94a3b8; font-size: 12px; }
.tip-ok { color: #34d399; font-size: 12px; }
.tip-err { color: #f87171; font-size: 12px; }
.detail-panel { margin-top: 10px; border: 1px dashed var(--panel-border); border-radius: 8px; padding: 10px 14px; background: rgba(59,130,246,.05); }
.detail-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--panel-accent); cursor: pointer; user-select: none; }
.detail-body { margin-top: 8px; }
.detail-item { padding: 10px 0; border-bottom: 1px dashed var(--panel-border); }
.detail-item:last-child { border-bottom: none; }
.detail-domain { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.detail-table { font-size: 12px; border-collapse: collapse; }
.detail-table td { padding: 3px 10px 3px 0; vertical-align: top; }
.detail-table td:first-child { color: #94a3b8; white-space: nowrap; width: 150px; }
.step-log { max-height: 300px; overflow: auto; font-size: 12px; font-family: monospace; }
.secret { letter-spacing: 1px; color: #9aa4b2; user-select: none; }
</style>
