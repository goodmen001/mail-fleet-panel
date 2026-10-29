<template>
  <router-view/>
</template>

<style>
:root {
  --panel-bg: #0a0e17;
  --panel-card: #111827;
  --panel-border: #1f2a3d;
  --panel-accent: #22d3ee;
  --panel-accent2: #818cf8;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--panel-bg);
  color: #e5e7eb;
  font-family: 'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.tech-card {
  background: linear-gradient(145deg, rgba(34,211,238,0.04), rgba(129,140,248,0.03)), var(--panel-card);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  padding: 20px;
}
.tech-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tech-title::before {
  content: '';
  width: 3px;
  height: 14px;
  background: linear-gradient(180deg, var(--panel-accent), var(--panel-accent2));
  border-radius: 2px;
}
.el-button--primary {
  --el-button-bg-color: var(--panel-accent);
  --el-button-border-color: var(--panel-accent);
  --el-button-text-color: #06121a;
}
.el-table { --el-table-bg-color: transparent; --el-table-tr-bg-color: transparent; }
</style>
