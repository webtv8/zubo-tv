import { outputResponse } from './_lib/output.js';

// 公开输出地址：https://<你的域名>/txt（无需登录）
export const onRequest = ({ request, env }) => outputResponse('txt', request, env);
