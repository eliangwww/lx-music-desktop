# LX Music Cloud Sync Worker

这个 Worker 使用一个共享同步 ID 和访问令牌，在 Cloudflare KV 中保存 LX Music 的收藏、用户歌单和上次播放位置。它不保存 Cloudflare API 凭据，也不提供账号系统。

## 部署

需要 Node.js 22 或更高版本，以及一个 Cloudflare 账号。

```powershell
npm install
npx wrangler login
npx wrangler kv namespace create SYNC_KV
```

把命令返回的 namespace ID 填入 `wrangler.toml` 的 `id`，然后设置一个足够长且随机的共享令牌并部署：

```powershell
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

`SYNC_TOKEN` 不要写入配置文件或提交到版本库。部署成功后，在 LX Music 的“设置 > 数据同步”中选择 Cloudflare KV，并填写：

- Worker 地址：部署输出中的 `https://...workers.dev` 地址
- 同步 ID：3 到 128 位字母、数字、下划线或连字符，例如 `home-music`
- 访问令牌：上面写入的 `SYNC_TOKEN`

首次使用时，在保存有完整歌单的主设备点击“用本机数据覆盖云端”。其他设备使用相同三项配置，启用同步后会拉取云端数据。

## 本地检查

```powershell
npm run check
npm run dev
```

本地开发时可在 `cloudflare-worker/.dev.vars` 中临时设置 `SYNC_TOKEN=...`；该文件不要提交。Worker 单次请求上限为 8 MiB，同一个同步 ID 使用最后写入者覆盖策略。