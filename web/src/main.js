import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import axios from 'axios'

axios.defaults.baseURL = '/api'
axios.interceptors.request.use(cfg => {
  const token = localStorage.getItem('panel_token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})
axios.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && location.pathname !== '/login') {
      localStorage.removeItem('panel_token')
      location.href = '/login'
    }
    return Promise.reject(err)
  }
)

const app = createApp(App)
app.use(ElementPlus)
app.use(router)
document.documentElement.classList.add('dark')
app.mount('#app')
