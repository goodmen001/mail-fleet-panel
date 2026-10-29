<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <Icon icon="mdi:email-fast-outline" width="26" height="26"/>
        <span>Mail Fleet</span>
      </div>
      <nav>
        <router-link v-for="m in menus" :key="m.path" :to="m.path" class="nav-item">
          <Icon :icon="m.icon" width="19" height="19"/>
          <span>{{ m.title }}</span>
        </router-link>
      </nav>
      <div class="foot" @click="logout">
        <Icon icon="mdi:logout" width="18" height="18"/>
        <span>退出</span>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <span class="page-title">{{ $route.meta.title }}</span>
        <span class="me">{{ user?.username }} <el-tag size="small" effect="dark">{{ user?.role }}</el-tag></span>
      </header>
      <div class="content">
        <router-view/>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'

const router = useRouter()
const user = computed(() => JSON.parse(localStorage.getItem('panel_user') || '{}'))

const menus = [
  { path: '/sites', icon: 'mdi:server-network', title: '站点管理' },
  { path: '/deploy', icon: 'mdi:rocket-launch-outline', title: '部署中心' },
  { path: '/version', icon: 'mdi:source-branch', title: '版本中心' },
  { path: '/users', icon: 'mdi:account-group-outline', title: '用户管理' },
]

function logout() {
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
.main { flex: 1; display: flex; flex-direction: column; }
.topbar {
  height: 56px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; border-bottom: 1px solid var(--panel-border);
  background: rgba(17,24,39,.6);
}
.page-title { font-weight: 600; letter-spacing: 1px; }
.me { color: #9ca3af; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.content { padding: 24px; flex: 1; }
</style>
