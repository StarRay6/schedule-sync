# 推送到 GitHub（可选步骤）

日常使用不需要 GitHub —— 直接跑 `启动服务-Windows.bat` 就行。
这一步只是把代码备份到 GitHub，顺便获得一个公网 https 地址。

## 一、新建仓库

在 <https://github.com/new> 新建一个仓库，名字比如 `schedule-sync`，
**不要**勾选 "Add a README file"，保持空仓库。

## 二、推送代码

```bash
cd 日程同步
git init -b main
git add .
git commit -m "日程同步 v1.0"
git remote add origin https://github.com/<你的用户名>/schedule-sync.git
git push -u origin main
```

> `data/` 目录已被 `.gitignore` 排除，日程数据不会上传到 GitHub。

## 三、开启 Pages

仓库 → **Settings → Pages**：

- Source 选 **Deploy from a branch**
- Branch 选 **main**，目录选 **/ (root)**
- 点 **Save**，等 1-2 分钟

访问地址：`https://<你的用户名>.github.io/schedule-sync/`

## 四、重要说明

这个 Pages 地址是 **https**，浏览器不允许 https 页面访问你电脑上 http 的局域网服务，
所以 Pages 版打开后会是"离线模式"，只能看本机缓存，无法同步。

- 日常使用：请用局域网地址 `http://电脑IP:8765`（手机和电脑同一个 Wi-Fi）
- Pages 版：当作代码备份 / 在外地只看不改的看板
