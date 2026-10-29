import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/login', component: () => import('../views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('../views/Layout.vue'),
    children: [
      { path: '', redirect: '/sites' },
      { path: 'sites', component: () => import('../views/Sites.vue'), meta: { title: '站点管理' } },
      { path: 'deploy', component: () => import('../views/Deploy.vue'), meta: { title: '部署中心' } },
      { path: 'version', component: () => import('../views/Version.vue'), meta: { title: '版本中心' } },
      { path: 'users', component: () => import('../views/Users.vue'), meta: { title: '用户管理', admin: true } },
    ]
  }
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  const token = localStorage.getItem('panel_token')
  if (!to.meta.public && !token) return '/login'
  const me = JSON.parse(localStorage.getItem('panel_user') || '{}')
  if (to.meta.admin && me.role !== 'admin') return '/sites'
  if (to.path === '/login' && token) return '/sites'
})

export default router
