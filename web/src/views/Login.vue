<template>
  <div class="login-page">
    <div class="login-card">
      <div class="logo">
        <Icon icon="mdi:email-fast-outline" width="42" height="42"/>
        <h1>Mail Fleet Panel</h1>
        <p>cloud-mail 多站点部署与管理平台</p>
      </div>
      <el-input v-model="username" placeholder="用户名" size="large" @keyup.enter="login">
        <template #prefix><Icon icon="mdi:account-outline"/></template>
      </el-input>
      <el-input v-model="password" type="password" placeholder="密码" size="large" show-password @keyup.enter="login">
        <template #prefix><Icon icon="mdi:lock-outline"/></template>
      </el-input>
      <el-button type="primary" size="large" :loading="loading" @click="login" style="width:100%">登 录</el-button>
      <p class="hint">首次使用默认账号 admin / admin123，登录后请立即修改密码</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Icon } from '@iconify/vue'
import axios from 'axios'

const router = useRouter()
const username = ref('')
const password = ref('')
const loading = ref(false)

async function login() {
  if (!username.value || !password.value) return
  loading.value = true
  try {
    const { data } = await axios.post('/auth/login', { username: username.value, password: password.value })
    localStorage.setItem('panel_token', data.data.token)
    localStorage.setItem('panel_user', JSON.stringify(data.data.user))
    ElMessage.success('欢迎回来')
    router.push('/sites')
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(ellipse 60% 40% at 20% 10%, rgba(34,211,238,.08), transparent),
    radial-gradient(ellipse 50% 40% at 85% 90%, rgba(129,140,248,.08), transparent),
    var(--panel-bg);
}
.login-card {
  width: 380px;
  padding: 40px;
  border-radius: 16px;
  background: var(--panel-card);
  border: 1px solid var(--panel-border);
  box-shadow: 0 0 60px rgba(34,211,238,.08);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.logo { text-align: center; margin-bottom: 10px; color: var(--panel-accent); }
.logo h1 { margin: 8px 0 4px; font-size: 22px; color: #fff; letter-spacing: 2px; }
.logo p { margin: 0; font-size: 12px; color: #6b7280; }
.hint { font-size: 12px; color: #6b7280; text-align: center; margin: 0; }
</style>
