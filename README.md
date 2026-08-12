# 结算业务智能盘户工作台

## 环境要求

- Python 3.10 及以上版本
- Node.js 20 及以上版本
- npm 10 及以上版本

## 启动后端

在项目根目录执行：

```bash
python3 -m pip install -r apps/api/requirements.txt
python3 apps/api/init_db.py
python3 -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8787
```

后端健康检查地址：`http://127.0.0.1:8787/health`

## 启动前端

另开一个终端，在项目根目录执行：

```bash
cd apps/web
npm install
npm run dev
```

浏览器访问：`http://127.0.0.1:5173`

## 构建前端

如需生成部署文件：

```bash
cd apps/web
npm install
npm run build
```

构建产物位于 `apps/web/dist`。
