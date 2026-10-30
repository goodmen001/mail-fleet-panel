<template>
  <div>
    <div class="tech-card" style="margin-top:20px" v-if="isAdmin">
      <div class="tech-title">
        <Icon icon="mdi:fast-forward-outline"/>GitHub 加速代理
        <el-button size="small" type="primary" style="margin-left:auto" @click="saveProxy" :loading="proxySaving">保存配置</el-button>
      </div>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
        title="导入官方包、在线更新、GitHub 同步都会经过这里配置的线路。访问 GitHub 受限时可选内置加速镜像或填入自建代理（如 Cloudflare Worker 反代）。"/>
      <el-form label-width="100px" style="max-width:640px">
        <el-form-item label="线路模式">
          <el-radio-group v-model="proxy.mode">
            <el-radio value="auto">自动（直连优先，失败切镜像）</el-radio>
            <el-radio value="direct">仅直连</el-radio>
            <el-radio value="mirror">仅镜像</el-radio>
            <el-radio value="custom">自定义代理</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="自定义代理" v-if="proxy.mode === 'custom'">
          <el-input v-model="proxy.customUrl" placeholder="例如 https://你的反代域名/（须能代理整个 GitHub URL）"/>
        </el-form-item>
        <el-form-item label="内置镜像">
          <div class="mirror-list">
            <div v-for="m in proxy.mirrors" :key="m" class="mirror-item">
              <span class="mirror-url">{{ m }}</span>
              <el-tag v-if="m === proxy.lastGood" size="small" type="success" effect="dark">当前可用</el-tag>
              <el-button size="small" link type="primary" @click="testProxy(m)">测速</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="连接测试">
          <el-button size="small" @click="testProxy('')">测试直连</el-button>
          <span v-if="testResult" :style="{color: testResult.ok ? '#34d399' : '#f87171', fontSize: '12px', marginLeft: '8px'}">
            {{ testResult.ok ? '✓ 连接成功 (HTTP ' + testResult.status + ')' : '✗ 连接失败' + (testResult.error ? '：' + testResult.error : ' (HTTP ' + testResult.status + ')') }}
          </span>
        </el-form-item>
      </el-form>
    </div>

    <div class="tech-card" style="margin-top:20px" v-if="isAdmin">
      <div class="tech-title">
        <Icon icon="mdi:cloud-braces"/>Cloudflare 加速代理
        <el-button size="small" type="primary" style="margin-left:auto" @click="saveCfProxy" :loading="cfSaving">保存配置</el-button>
      </div>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
        title="凭证校验、域名拉取、批量部署都会经过这里配置的线路。无法连接 Cloudflare API 时，可填入自建反代地址（须能整站代理 api.cloudflare.com，如 Cloudflare Worker 反代）。"/>
      <el-form label-width="100px" style="max-width:640px">
        <el-form-item label="线路模式">
          <el-radio-group v-model="cfProxy.mode">
            <el-radio value="auto">自动（代理优先，失败切直连）</el-radio>
            <el-radio value="direct">仅直连</el-radio>
            <el-radio value="custom">自定义代理</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="代理地址" v-if="cfProxy.mode === 'custom'">
          <el-input v-model="cfProxy.customUrl" placeholder="例如 https://你的反代域名/（须能代理整个 api.cloudflare.com URL）"/>
        </el-form-item>
        <el-form-item label="连接测试">
          <el-button size="small" @click="testCfProxy('')">测试直连</el-button>
          <el-button size="small" @click="testCfProxy(cfProxy.customUrl)" :disabled="cfProxy.mode !== 'custom' || !cfProxy.customUrl">测试代理</el-button>
          <span v-if="cfTestResult" :style="{color: cfTestResult.ok ? '#34d399' : '#f87171', fontSize: '12px', marginLeft: '8px'}">
            {{ cfTestResult.ok ? '✓ 线路可用 (HTTP ' + cfTestResult.status + ')' : '✗ 线路不通' + (cfTestResult.error ? '：' + cfTestResult.error : '') }}
          </span>
        </el-form-item>
      </el-form>

      <div class="sec-title" style="margin-top:8px" v-if="isAdmin">一键部署 API 反代（推荐）</div>
      <el-form label-width="100px" style="max-width:640px" v-if="isAdmin">
        <el-form-item label="凭证">
          <el-select v-model="onlycf.credId" placeholder="选择 Cloudflare 凭证" style="width:280px" @change="loadZones">
            <el-option v-for="c in creds" :key="c.credId" :label="c.name" :value="c.credId"/>
          </el-select>
        </el-form-item>
        <el-form-item label="域名">
          <el-select v-model="onlycf.domain" placeholder="先选凭证，再选要绑定的域名" style="width:280px" :disabled="!onlycf.credId">
            <el-option v-for="z in onlycf.zones" :key="z" :label="'onlycf.' + z" :value="z"/>
          </el-select>
        </el-form-item>
        <el-form-item label="部署">
          <el-button size="small" type="primary" :disabled="!onlycf.credId || !onlycf.domain" :loading="onlycf.deploying" @click="deployOnlycf">一键部署</el-button>
          <span v-if="onlycf.step" style="fontSize:12px;marginLeft:8px;color:#94a3b8">{{ onlycf.step }}</span>
        </el-form-item>
      </el-form>

      <div class="sec-title" style="margin-top:8px">出站代理（SOCKS5 / HTTP）</div>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
        :title="isAdmin
          ? '面板服务器走 v2ray/clash 等本地代理或公司 HTTP 代理时填写，例如 socks5://127.0.0.1:1080 或 http://user:pass@host:port。对所有 Cloudflare / GitHub API 请求生效。'
          : '代理是可选的：只有在无法连接 Cloudflare 时才需要。配置后退出登录会自动取消该代理（可在历史代理中找回），避免影响其他用户。'"/>
      <el-alert v-if="outProxy.exists && !outProxy.mine" type="warning" show-icon :closable="false" style="margin-bottom:12px"
        title="当前已有其他用户配置了出站代理（地址保密）。线路不可用时请让该用户调整，或联系管理员。"/>
      <el-form label-width="100px" style="max-width:640px" v-if="!outProxy.exists || outProxy.mine">
        <el-form-item label="代理地址">
          <el-input v-model="outProxy.url" placeholder="留空 = 不使用（直连）" style="max-width:420px"/>
        </el-form-item>
        <el-form-item label="连接测试">
          <el-button size="small" @click="testOutProxy" :loading="outProxy.testing">测试出站线路</el-button>
          <span v-if="outProxy.result" :style="{color: outProxy.result.ok ? '#34d399' : '#f87171', fontSize: '12px', marginLeft: '8px'}">
            {{ outProxy.result.ok ? '✓ 可用 (HTTP ' + outProxy.result.status + ', ' + outProxy.result.ms + 'ms, via ' + outProxy.result.via + ')' : '✗ ' + (outProxy.result.error || '失败') }}
          </span>
        </el-form-item>
        <el-form-item label="">
          <el-button size="small" type="primary" :loading="outProxy.saving" @click="saveOutProxy">保存出站代理</el-button>
        </el-form-item>
      </el-form>
      <div v-if="outProxy.history.length" class="sec-title">历史代理</div>
      <div class="mirror-list" style="max-width:640px">
        <div v-for="h in outProxy.history" :key="h.id" class="mirror-item">
          <span class="mirror-url">{{ h.url }}</span>
          <el-tag size="small" type="info">{{ (h.removedAt || '').slice(0, 10) }}</el-tag>
          <el-button size="small" link type="primary" @click="restoreProxy(h)">恢复使用</el-button>
          <el-button size="small" link type="danger" @click="delProxyHistory(h)">删除</el-button>
        </div>
      </div>
    </div>

    <div class="tech-card" style="margin-top:20px">
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

// ---- GitHub acceleration proxy config ----
const proxy = ref({ mode: 'auto', customUrl: '', lastGood: '', mirrors: [] })
const proxySaving = ref(false)
const testResult = ref(null)

async function loadProxy() {
  try {
    const { data } = await axios.get('/version/proxy')
    proxy.value = { ...proxy.value, ...data.data }
  } catch { /* older server build — hide gracefully */ }
}

async function saveProxy() {
  proxySaving.value = true
  try {
    await axios.post('/version/proxy', { mode: proxy.value.mode, customUrl: proxy.value.customUrl })
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '保存失败')
  } finally { proxySaving.value = false }
}

async function testProxy(prefix) {
  testResult.value = null
  try {
    const { data } = await axios.post('/version/proxy/test', { prefix })
    testResult.value = data.data
  } catch (e) {
    testResult.value = { ok: false, error: e.response?.data?.message || '请求失败' }
  }
}

// ---- Cloudflare acceleration proxy config ----
const cfProxy = ref({ mode: 'auto', customUrl: '' })
const cfSaving = ref(false)
const cfTestResult = ref(null)

async function loadCfProxy() {
  try {
    const { data } = await axios.get('/version/cfproxy')
    cfProxy.value = { ...cfProxy.value, ...data.data }
  } catch { /* older server build */ }
}

async function saveCfProxy() {
  cfSaving.value = true
  try {
    await axios.post('/version/cfproxy', { mode: cfProxy.value.mode, customUrl: cfProxy.value.customUrl })
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '保存失败')
  } finally { cfSaving.value = false }
}

async function testCfProxy(prefix) {
  cfTestResult.value = null
  try {
    const { data } = await axios.post('/version/cfproxy/test', { prefix })
    cfTestResult.value = data.data
  } catch (e) {
    cfTestResult.value = { ok: false, error: e.response?.data?.message || '请求失败' }
  }
}

// ---- one-click onlycf proxy deployment ----
const creds = ref([])
const onlycf = ref({ credId: null, domain: '', zones: [], deploying: false, step: '' })

async function loadOnlycfCreds() {
  try {
    const { data } = await axios.get('/credential/list')
    creds.value = data.data || []
  } catch { /* ignore */ }
}

async function loadZones() {
  onlycf.value.zones = []
  onlycf.value.domain = ''
  if (!onlycf.value.credId) return
  try {
    const { data } = await axios.get('/version/cfproxy/zones', { params: { credId: onlycf.value.credId } })
    onlycf.value.zones = (data.data || []).map(z => z.name)
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '域名拉取失败')
  }
}

async function deployOnlycf() {
  onlycf.value.deploying = true
  onlycf.value.step = '开始部署…'
  try {
    const { data } = await axios.post('/version/cfproxy/onlycf-deploy', { credId: onlycf.value.credId, domain: onlycf.value.domain })
    if (data.code === 200) {
      onlycf.value.step = '完成'
      ElMessage.success(data.message)
      await loadCfProxy()
    } else {
      onlycf.value.step = ''
      ElMessage.error(data.message || '部署失败')
    }
  } catch (e) {
    onlycf.value.step = ''
    ElMessage.error(e.response?.data?.message || '部署失败')
  } finally { onlycf.value.deploying = false }
}

// ---- outbound proxy (socks5/http) — v0.7.4 per-user isolation ----
const outProxy = ref({ url: '', saving: false, testing: false, result: null, mine: false, exists: false, history: [] })

async function loadOutProxy() {
  try {
    const { data } = await axios.get('/version/outproxy')
    outProxy.value.url = data.data?.url || ''
    outProxy.value.mine = !!data.data?.mine
    outProxy.value.exists = !!data.data?.exists
    outProxy.value.history = data.data?.history || []
  } catch { /* older server build */ }
}

async function saveOutProxy() {
  outProxy.value.saving = true
  try {
    await axios.post('/version/outproxy', { url: outProxy.value.url })
    ElMessage.success('出站代理已保存')
    loadOutProxy()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '保存失败')
  } finally { outProxy.value.saving = false }
}

async function testOutProxy() {
  outProxy.value.result = null
  outProxy.value.testing = true
  try {
    const { data } = await axios.post('/version/outproxy/test')
    outProxy.value.result = data.data
  } catch (e) {
    outProxy.value.result = { ok: false, error: e.response?.data?.message || '请求失败' }
  } finally { outProxy.value.testing = false }
}

async function restoreProxy(h) {
  try {
    await axios.post('/version/outproxy/history/restore', { id: h.id })
    ElMessage.success('已恢复该代理')
    loadOutProxy()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '恢复失败')
  }
}

async function delProxyHistory(h) {
  try {
    await axios.delete('/version/outproxy/history', { params: { id: h.id } })
    loadOutProxy()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '删除失败')
  }
}

loadOnlycfCreds()
loadOutProxy()

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

onMounted(() => { load(); loadPkgs(); loadProxy(); loadCfProxy() })
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
.mirror-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.mirror-item { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.mirror-url { font-family: monospace; color: #9aa4b2; }
</style>
