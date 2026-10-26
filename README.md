1.在后台先手动创建一个 D1 数据库和一个 KV 命名空间，Pages 不会像 Workers 那样自动创建。

2.到 Workers & Pages 选 Create → Pages → Connect to Git，选这个仓库，构建设置如下：
  框架预设 (Framework preset)：None
  构建命令 (Build command)：npm install
  构建输出目录 (Build output directory)：public
  
3.部署后，在项目 Settings → Bindings 里添加 D1，变量名 DB，添加 KV，变量名 KV。Production 和 Preview 建议都加。
   在 Variables and Secrets 里设置 ADMIN_PASSWORD（必填），ADMIN_USERNAME 和 JWT_SECRET 按需设置。
   
  重新部署（Retry deployment），然后访问 /api/health，确认 kvBound 和 adminPasswordSet 都是 true，再去 /admin 登录。
