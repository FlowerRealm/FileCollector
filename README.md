# FileCollector

轻量文件收集与分发：没有用户系统，身份是浏览器 cookie 里的随机 token。名字即链接：收集是 `/c/<名字>`，分发是 `/d/<名字>`。

收集：

- 任何人发起一个收集，拿到链接发给大家；发起者即管理者
- 加入者提交文件或文件夹，同一人再次提交会覆盖上一次
- 管理者查看、下载（单文件 / 按人 zip / 全部 zip）、删除提交，可手动关闭收集

分发：

- 发起者上传文件或文件夹，同路径的文件会被替换，也可单独删除
- 拿到链接的人可以下载单个文件或全部 zip
- 关闭后只有发起者还能看到文件

收集和分发都在创建 3 天后自动过期，文件一并清理。

## 运行

```sh
npm ci
npm start          # http://localhost:3000
npm test
```

或使用 Docker：

```sh
docker run -d -p 3000:3000 -v fc-data:/data ghcr.io/flowerrealm/filecollector:latest
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data`（镜像内 `/data`） | SQLite 与上传文件目录 |
| `TTL_HOURS` | `72` | 收集有效期（小时） |
| `MAX_FILE_MB` | `500` | 单文件大小上限 |
| `TRUST_PROXY` | 未设置 | 置于反向代理后时设为 `1`，cookie 才会带 `Secure` |

需要 Node.js >= 22.13（使用内置 `node:sqlite`）。

## 发版

推送 `v*` 标签即触发发版流水线：跑测试，构建 amd64/arm64 镜像推送到 `ghcr.io`，并创建 GitHub Release。

```sh
git tag v1.0.0 && git push origin v1.0.0
```
