// Cloudflare Pages Functions 入口：把 /api/* 和 /uploads/* 交给 Hono 应用处理
import app from '../src/index.js';

export const onRequest = ctx => app.fetch(ctx.request, ctx.env, ctx);
