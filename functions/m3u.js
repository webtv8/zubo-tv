import { outputResponse } from './_lib/output.js';

// 公开输出地址：https://<你的域名>/m3u（无需登录）
export const onRequest = ({ request, env }) => outputResponse('m3u', request, env);
