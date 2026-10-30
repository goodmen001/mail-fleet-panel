<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:source-branch"/>上游版本检查</div>
      <el-button type="primary" size="small" @click="check" :loading="checking" style="margin-bottom:14px">检查更新</el-button>
      <div v-if="info" class="ver-info">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="本地基线">{{ short(info.currentUpstream) || '未记录' }}</el-descriptions-item>
          <el-descriptions-item label="上游最新">{{ short(info.latestSha) }}</el-descriptions-item>
          <el-descriptions-item label="上游提交">{{ info.latestMsg }}</el-descriptions-item>
          <el-descriptions-item label="结论">
            <el-tag v-if="info.hasUpdate && info.conflictCount === 0" type="success" effect="dark" size="small">有更新，可安全升级</el-tag>
            <el-tag v-else-if="info.hasUpdate && info.conflictCount > 0" type="danger" effect="dark" size="small">有更新，但存在冲突 — 不升级</el-tag>
            <el-tag v-else type="info" effect="dark" size="small">已是最新</el-tag>
          </el-descriptions-item>
        </el-descriptions>
        <template v-if="info.hasUpdate">
          <div class="sec-title">上游改动文件（{{ info.changedCount }}）</div>
          <div class="file-list">
            <div v-for="f in info.changedFiles" :key="f.filename" class="file-item"
                 :class="{ conflict: info.conflicts.includes(f.filename) }">
              <Icon :icon="info.conflicts.includes(f.filename) ? 'mdi:alert-octagon' : 'mdi:file-document-outline'" width="14"/>
              {{ f.filename }}
              <el-tag v-if="info.conflicts.includes(f.filename)" size="small" type="danger" effect="dark">与定制冲突</el-tag>
            </div>
          </div>
          <el-alert v-if="info.conflictCount > 0" type="error" show-icon :closable="false" style="margin-top:12px"
            :title="`检测到 ${info.conflictCount} 个冲突文件，升级已阻止。需人工重新编译合并后手动登记新版本。`"/>
          <el-button v-if="info.canAutoUpgrade" type="success" style="margin-top:12px" @click="adopt">确认升级完成（登记新基线）</el-button>
        </template>
      </div>
      <el-empty v-else description="点击「检查更新」对比上游 maillab/cloud-mail"/>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title">
        <Icon icon="mdi:package-variant-closed"/>部署包（版本中心）
        <el-button v-if="isAdmin" size="small" type="primary" style="margin-left:auto" @click="uploadShow = true">上传定制包</el-button>
        <el-button v-if="isAdmin" size="small" type="success" style="margin-left:8px" @click="openGithubSync">从 GitHub 同步</el-button>
        <el-button v-if="isAdmin" size="small" style="margin-left:8px" @click="openImportOfficial">导入官方包</el-button>
      </div>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
        title="定制包：我们升级后的 cloud-mail（上传 zip，或使用面板内置包）。官方包：与原项目一致的版本，从 GitHub 官方 Release 一键导入并自动构建。批量部署时可在此选择使用哪个包。"/>
      <el-table :data="pkgs" size="small">
        <el-table-column prop="name" label="名称" min-width="160"/>
        <el-table-column label="类型" width="100">
          <template #default="{row}">
            <el-tag size="small" effect="dark" :type="row.kind === 'custom' ? 'warning' : 'success'">
              {{ row.kind === 'custom' ? '定制包' : '官方包' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="110">
          <template #default="{row}">{{ row.version || '—' }}</template>
        </el-table-column>
        <el-table-column prop="tag" label="Tag" width="110">
          <template #default="{row}">{{ row.tag || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{row}">
            <el-tag size="small" :type="row.exists ? 'success' : 'danger'">{{ row.exists ? '可用' : '缺失' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="140"/>
        <el-table-column prop="createTime" label="时间" width="160"/>
        <el-table-column label="操作" width="130" v-if="isAdmin">
          <template #default="{row}">
            <el-button size="small" type="primary" link :loading="updatingId === row.pkgId" @click="updatePkg(row)">在线更新</el-button>
            <el-button size="small" type="danger" link @click="delPkg(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title"><Icon icon="mdi:puzzle-outline"/>定制文件清单（升级冲突判定依据）</div>
      <div style="margin-bottom:12px" v-if="isAdmin">
        <el-input v-model="newPath" placeholder="仓库相对路径，如 mail-worker/src/service/account-service.js" style="width:440px;margin-right:8px"/>
        <el-button type="primary" size="small" @click="addCustom">登记</el-button>
      </div>
      <el-table :data="customs" size="small">
        <el-table-column prop="path" label="文件路径" min-width="360"/>
        <el-table-column prop="note" label="备注" min-width="160"/>
        <el-table-column label="操作" width="80" v-if="isAdmin">
          <template #default="{row}"><el-button size="small" type="danger" link @click="delCustom(row)">删除</el-button></template>
        </el-table-column>
      </el-table>
    </div>
    <el-dialog v-model="uploadShow" title="上传定制包" width="480">
      <el-form label-width="90px">
        <el-form-item label="名称"><el-input v-model="uploadForm.name" placeholder="例如：定制包 v1.2"/></el-form-item>
        <el-form-item label="版本号"><el-input v-model="uploadForm.version" placeholder="可选，如 1.2.0"/></el-form-item>
        <el-form-item label="备注"><el-input v-model="uploadForm.note" placeholder="可选"/></el-form-item>
        <el-form-item label="zip 包">
          <el-upload drag accept=".zip" :auto-upload="false" :limit="1" :on-change="onUploadFile">
            <Icon icon="mdi:upload" width="22"/><div class="el-upload__text">拖拽 zip 到此处，或<em>点击选择</em></div>
            <template #tip><div class="el-upload__tip">cloud-mail 的 mail-worker/dist 打包 zip（内含 worker.js、index.html、assets/）</div></template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="uploadShow = false">取消</el-button>
        <el-button type="primary" :loading="uploading" @click="doUpload">上传并校验</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ghSyncShow" title="从 GitHub 同步定制包" width="560">
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
        title="列出本仓库 GitHub Release 中的 custom-worker-dist-*.zip（CI 自动构建并附加），选择一个即可拉取为定制包，无需本地构建。"/>
      <el-table :data="ghReleases" size="small" v-loading="ghLoading" max-height="320">
        <el-table-column prop="tag" label="Release" width="140"/>
        <el-table-column label="构建时间" width="170">
          <template #default="{row}">{{ (row.publishedAt || '').replace('T', ' ').slice(0, 16) }}</template>
        </el-table-column>
        <el-table-column label="定制包" min-width="220">
          <template #default="{row}">
            <div v-for="p in row.packages" :key="p.name" style="display:flex;align-items:center;gap:8px">
              <el-tag size="small" effect="dark" :type="p.kind === 'official' ? 'success' : 'warning'">{{ p.kind === 'official' ? '官方包' : '定制包' }}</el-tag>
              <span style="font-family:monospace;font-size:12px">{{ p.name }}</span>
              <el-button size="small" type="primary" link @click="doGhSync(p, row)">同步</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!ghLoading && !ghReleases.length" description="暂无可同步的包 — 等下一次 push 触发 CI 后再试"/>
      <template #footer>
        <el-button @click="ghSyncShow = false">关闭</el-button>
        <el-button @click="openGithubSync">刷新</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importShow" title="导入官方包（GitHub Release）" width="520">
      <el-form label-width="90px">
        <el-form-item label="官方版本">
          <el-select v-model="importForm.tag" :loading="releasesLoading" placeholder="选择官方 Release" style="width:100%">
            <el-option v-for="r in releases" :key="r.tag" :value="r.tag"
              :label="r.tag + (r.prerelease ? '（预发布）' : '')"/>
          </el-select>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="importForm.note" placeholder="可选"/></el-form-item>
      </el-form>
      <el-alert type="warning" show-icon :closable="false"
        title="导入时会从 GitHub 下载该版本源码并自动构建（前端 vite build + wrangler 打包），需要几分钟，请耐心等待。"/>
      <template #footer>
        <el-button @click="importShow = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="doImportOfficial">下载并构建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const info = ref(null)
const checking = ref(false)
const customs = ref([])
const newPath = ref('')
const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
const isAdmin = me.role === 'admin'

// ---- deployment packages (version center) ----
const pkgs = ref([])
const uploadShow = ref(false)
const uploading = ref(false)
const uploadForm = ref({ name: '', version: '', note: '', file: null })
const importShow = ref(false)
const importing = ref(false)
const importForm = ref({ tag: '', note: '' })
const releases = ref([])
const releasesLoading = ref(false)

async function loadPkgs() {
  const { data } = await axios.get('/version/pkgs')
  pkgs.value = data.data
}

function onUploadFile(file) {
  uploadForm.value.file = file.raw
  return false // prevent el-upload auto posting; we post manually with axios
}

async function doUpload() {
  if (!uploadForm.value.file) return ElMessage.warning('请选择 zip 包')
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('name', uploadForm.value.name)
    fd.append('version', uploadForm.value.version)
    fd.append('note', uploadForm.value.note)
    fd.append('file', uploadForm.value.file)
    await axios.post('/version/pkgs/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    ElMessage.success('定制包已上传')
    uploadShow.value = false
    uploadForm.value = { name: '', version: '', note: '', file: null }
    loadPkgs()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '上传失败')
  } finally { uploading.value = false }
}

async function openImportOfficial() {
  importShow.value = true
  releasesLoading.value = true
  try {
    const { data } = await axios.get('/version/pkgs/official-releases')
    releases.value = data.data
    if (data.data.length && !importForm.value.tag) importForm.value.tag = data.data[0].tag
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '获取官方 Release 失败')
  } finally { releasesLoading.value = false }
}

async function doImportOfficial() {
  if (!importForm.value.tag) return ElMessage.warning('请选择官方版本')
  importing.value = true
  try {
    await axios.post('/version/pkgs/import-official', importForm.value)
    ElMessage.success(`官方包 ${importForm.value.tag} 已导入（前端构建 + Worker 打包完成）`)
    importShow.value = false
    loadPkgs()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '导入失败')
  } finally { importing.value = false }
}

async function delPkg(row) {
  await ElMessageBox.confirm(`删除部署包「${row.name}」？`, '提示', { type: 'warning' })
  await axios.delete('/version/pkgs/delete', { params: { pkgId: row.pkgId } })
  loadPkgs()
}

// per-package online update: official → rebuild from latest upstream release;
// custom → pull newest custom-worker-dist from our GitHub release
const updatingId = ref(null)
async function updatePkg(row) {
  const what = row.kind === 'official' ? '上游最新 Release 重新构建' : 'GitHub 最新定制包 zip'
  await ElMessageBox.confirm(`在线更新「${row.name}」（${what}）？更新期间旧包仍可部署。`, '提示', { type: 'warning' })
  updatingId.value = row.pkgId
  try {
    const { data } = await axios.post('/version/pkgs/update', { pkgId: row.pkgId })
    ElMessage.success(data.message || '已更新')
    loadPkgs()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '更新失败')
  } finally { updatingId.value = null }
}

// ---- GitHub sync (custom packages built by CI) ----
const ghSyncShow = ref(false)
const ghReleases = ref([])
const ghLoading = ref(false)

async function openGithubSync() {
  ghSyncShow.value = true
  ghLoading.value = true
  try {
    const { data } = await axios.get('/version/pkgs/github-releases')
    ghReleases.value = data.data
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '获取 GitHub Release 失败')
  } finally { ghLoading.value = false }
}

async function doGhSync(pkg, rel) {
  try {
    await axios.post('/version/pkgs/sync-github', { downloadUrl: pkg.downloadUrl, name: pkg.name, note: `GitHub ${rel.tag}` })
    ElMessage.success(`已同步 ${pkg.name}`)
    ghSyncShow.value = false
    loadPkgs()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '同步失败')
  }
}

const short = s => s ? s.slice(0, 7) : ''

async function check() {
  checking.value = true
  try {
    const { data } = await axios.get('/version/check')
    info.value = data.data
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '检查失败')
  } finally { checking.value = false }
}

async function adopt() {
  await ElMessageBox.confirm('确认已完成升级合并并登记为新基线？', '提示', { type: 'warning' })
  await axios.post('/version/adopt', { sha: info.value.latestSha })
  ElMessage.success('已登记')
  check()
}

async function load() {
  const { data } = await axios.get('/version/customs')
  customs.value = data.data
}

async function addCustom() {
  if (!newPath.value.trim()) return
  await axios.post('/version/customs/add', { path: newPath.value.trim() })
  newPath.value = ''
  load()
}

async function delCustom(row) {
  await axios.delete('/version/customs/delete', { params: { fileId: row.fileId } })
  load()
}

onMounted(() => { load(); loadPkgs() })
</script>

<style scoped>
.ver-info { margin-top: 4px; }
.sec-title { margin: 16px 0 8px; font-weight: 600; font-size: 13px; }
.file-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
.file-item {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-family: monospace;
  padding: 6px 10px; border-radius: 6px;
  background: rgba(255,255,255,.03);
}
.file-item.conflict { background: rgba(248,113,113,.1); color: #f87171; }
</style>
