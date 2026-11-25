/**
 * Workers 入口（可选部署方式）：与 Pages Functions 共用同一套路由与逻辑。
 * 静态资源通过 [assets] 绑定提供（见 wrangler.toml）。
 */
import { handleApi } from '../functions/_lib/api.js';
import { outputResponse } from '../functions/_lib/output.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (path === '/api' || path.startsWith('/api/')) {
      return handleApi(request, env);
    }
    if (path === '/txt') return outputResponse('txt', request, env);
    if (path === '/m3u') return outputResponse('m3u', request, env);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  },
};
