import { handleApi } from '../_lib/api.js';

// 兜住 /api/ 下所有子路径（Pages 路由：functions/api/[[path]].js）
export const onRequest = ({ request, env }) => handleApi(request, env);
