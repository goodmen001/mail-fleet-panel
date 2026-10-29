<template>
  <div>
    <div class="tech-card">
      <div class="tech-title"><Icon icon="mdi:account-group-outline"/>面板用户</div>
      <el-button type="primary" size="small" @click="addShow = true" style="margin-bottom:12px">添加用户</el-button>
      <el-table :data="users" size="small">
        <el-table-column prop="user_id" label="ID" width="60"/>
        <el-table-column prop="username" label="用户名" width="180"/>
        <el-table-column prop="role" label="角色" width="100">
          <template #default="{row}">
            <el-tag size="small" effect="dark" :type="row.role === 'admin' ? 'warning' : 'info'">
              {{ row.role === 'admin' ? '管理员' : '普通用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="create_time" label="创建时间" width="180"/>
        <el-table-column label="操作" width="160">
          <template #default="{row}">
            <el-button size="small" link type="primary" @click="openReset(row)">改密</el-button>
            <el-button size="small" link type="danger" @click="del(row)" v-if="row.user_id !== me.uid">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="tech-card" style="margin-top:20px">
      <div class="tech-title"><Icon icon="mdi:lock-reset"/>修改我的密码</div>
      <el-form label-width="90px" style="max-width:400px">
        <el-form-item label="原密码"><el-input v-model="myForm.oldPassword" type="password" show-password/></el-form-item>
        <el-form-item label="新密码"><el-input v-model="myForm.newPassword" type="password" show-password/></el-form-item>
        <el-form-item><el-button type="primary" @click="changeMy">保存</el-button></el-form-item>
      </el-form>
    </div>

    <el-dialog v-model="addShow" title="添加用户" width="420">
      <el-form label-width="80px">
        <el-form-item label="用户名"><el-input v-model="addForm.username"/></el-form-item>
        <el-form-item label="密码"><el-input v-model="addForm.password" type="password" show-password/></el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="addForm.role">
            <el-radio value="user">普通用户</el-radio>
            <el-radio value="admin">管理员</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addShow = false">取消</el-button>
        <el-button type="primary" @click="add">添加</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resetShow" title="重置密码" width="420">
      <el-input v-model="resetPassword" placeholder="新密码（至少6位）"/>
      <template #footer>
        <el-button @click="resetShow = false">取消</el-button>
        <el-button type="primary" @click="doReset">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
const users = ref([])
const addShow = ref(false)
const addForm = ref({ username: '', password: '', role: 'user' })
const resetShow = ref(false)
const resetTarget = ref(null)
const resetPassword = ref('')
const myForm = ref({ oldPassword: '', newPassword: '' })

async function load() {
  const { data } = await axios.get('/user/list')
  users.value = data.data
}

async function add() {
  try {
    await axios.post('/user/add', addForm.value)
    ElMessage.success('已添加')
    addShow.value = false
    addForm.value = { username: '', password: '', role: 'user' }
    load()
  } catch (e) { ElMessage.error(e.response?.data?.message || '失败') }
}

function openReset(row) { resetTarget.value = row; resetPassword.value = ''; resetShow.value = true }

async function doReset() {
  try {
    await axios.put('/user/password', { userId: resetTarget.value.user_id, newPassword: resetPassword.value })
    ElMessage.success('已重置')
    resetShow.value = false
  } catch (e) { ElMessage.error(e.response?.data?.message || '失败') }
}

async function changeMy() {
  try {
    await axios.put('/user/password', myForm.value)
    ElMessage.success('密码已修改')
    myForm.value = { oldPassword: '', newPassword: '' }
  } catch (e) { ElMessage.error(e.response?.data?.message || '失败') }
}

async function del(row) {
  await ElMessageBox.confirm(`删除用户「${row.username}」？`, '提示', { type: 'warning' })
  await axios.delete('/user/delete', { params: { userId: row.user_id } })
  load()
}

onMounted(load)
</script>
