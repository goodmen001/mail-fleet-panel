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

onMounted(load)
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
