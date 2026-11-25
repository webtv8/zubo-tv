/**
 * /api/* 路由：登录、配置读取、IP 端口更新、分组增删改、输出下载。
 * 除 login / output 外全部要求已登录。
 */
import {
  adminPassword,
  clearSessionCookie,
  isAuthenticated,
  issueSession,
  sessionCookie,
  verifyPassword,
} from './auth.js';
import {
  buildStats,
  normalizeTarget,
  parseChannelText,
  replaceAuthority,
  replaceGroupAuthority,
  validateGroupName,
} from './channels.js';
import { outputResponse } from './output.js';
import { HttpError, readConfig, writeConfig } from './store.js';

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    throw new HttpError(415, '请求必须使用 application/json');
  }
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  try {
    if (new URL(origin).host !== new URL(request.url).host) {
      throw new HttpError(403, '来源校验失败');
    }
  } catch {
    throw new HttpError(403, '来源校验失败');
  }
}

async function requireAuth(request, env) {
  if (!(await isAuthenticated(request, env))) {
    throw new HttpError(401, '登录已过期，请重新登录');
  }
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const route = segments.join('/');
  const method = request.method.toUpperCase();

  try {
    /* ---------- 公开：输出（不需要密码） ---------- */
    if (method === 'GET' && route.startsWith('output')) {
      const kind = (segments[1] || url.searchParams.get('jk') || 'txt').toLowerCase();
      if (kind !== 'txt' && kind !== 'm3u') throw new HttpError(400, 'jk 只能是 txt 或 m3u');
      return outputResponse(kind, request, env);
    }

    /* ---------- 登录状态 ---------- */
    if (method === 'GET' && route === 'session') {
      const authed = await isAuthenticated(request, env);
      return json({
        ok: true,
        authenticated: authed,
        passwordConfigured: adminPassword(env) !== '',
        kvBound: Boolean(env?.CONFIG_KV),
      });
    }

    /* ---------- 登录 ---------- */
    if (method === 'POST' && route === 'login') {
      assertSameOrigin(request);
      if (!adminPassword(env)) {
        throw new HttpError(
          500,
          '服务器未配置管理员密码：请在 Cloudflare 项目设置中添加环境变量 ADMIN_PASSWORD 后重新部署',
        );
      }
      const body = await readJson(request);
      const password = String(body.password ?? '');
      if (!password) throw new HttpError(400, '请输入密码');
      if (!(await verifyPassword(password, adminPassword(env)))) {
        await new Promise((r) => setTimeout(r, 400)); // 简单的失败延迟，抑制暴力尝试
        throw new HttpError(401, '密码错误');
      }
      const session = await issueSession(env);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(session, request) });
    }

    /* ---------- 退出登录 ---------- */
    if (method === 'POST' && route === 'logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
    }

    /* ---------- 以下均需登录 ---------- */
    if (method === 'POST') {
      assertSameOrigin(request);
    }
    await requireAuth(request, env);

    if (method === 'GET' && route === 'state') {
      const { config, source } = await readConfig(env);
      const origin = url.origin;
      return json({
        ok: true,
        config,
        stats: buildStats(config),
        output: {
          txt: `${origin}/txt`,
          m3u: `${origin}/m3u`,
        },
        configSource: source,
        kvBound: Boolean(env?.CONFIG_KV),
      });
    }

    /* ---------- 更新组播 IP:端口 ---------- */
    if (method === 'POST' && route === 'target') {
      const body = await readJson(request);
      const region = String(body.region ?? '').trim();
      const target = normalizeTarget(body.target);
      if (!target.ok) throw new HttpError(400, target.error);

      const { config } = await readConfig(env);
      if (!config.settings.whitelist_groups.includes(region)) {
        throw new HttpError(400, `组播主分组「${region}」不存在`);
      }

      const result = replaceGroupAuthority(config, region, target.authority);
      config.settings.region_ips[region] = target.authority;
      await writeConfig(env, config);

      let message = `已把「${region}」的地址更新为 ${target.authority}，处理 ${result.handled} 个频道`;
      if (result.changed) message += `，实际改动 ${result.changed} 个`;
      if (result.skipped.length) {
        message += `；${result.skipped.length} 个频道无法识别主机地址，已跳过：${result.skipped.slice(0, 5).join('、')}`;
      }
      if (result.untouched?.length) {
        message += `；${result.untouched.length} 个频道指向其他主机（非 /rtp/ 代理地址），保持原样：${result.untouched.slice(0, 5).join('、')}`;
      }
      return json({ ok: true, message, data: { ...result, authority: target.authority } });
    }

    /* ---------- 分组增删改 ---------- */
    if (method === 'POST' && route === 'group/add') {
      const body = await readJson(request);
      const type = body.type === 'custom' ? 'custom' : 'whitelist';
      const nameCheck = validateGroupName(body.name);
      if (!nameCheck.ok) throw new HttpError(400, nameCheck.error);
      const name = nameCheck.name;

      const { config } = await readConfig(env);
      const whitelist = config.settings.whitelist_groups;
      const existingGroups = new Set(config.channels.map((c) => c.group));
      if (whitelist.includes(name) || existingGroups.has(name)) {
        throw new HttpError(409, `分组「${name}」已存在，请换一个名称`);
      }

      const parsed = parseChannelText(body.text);
      if (!parsed.ok) throw new HttpError(400, parsed.error);

      let authority = null;
      if (type === 'whitelist') {
        const target = normalizeTarget(body.target);
        if (!target.ok) throw new HttpError(400, target.error);
        authority = target.authority;
        whitelist.push(name);
        config.settings.region_ips[name] = authority;
      }

      const added = parsed.items.map((item) => {
        const replaced = authority ? replaceAuthority(item.url, authority) : null;
        return { name: item.name, url: replaced ? replaced.url : item.url, group: name, genre: item.genre };
      });
      config.channels.push(...added);

      await writeConfig(env, config);
      return json({
        ok: true,
        message: `已添加${type === 'whitelist' ? '组播主分组' : '自定义分组'}「${name}」，共 ${parsed.items.length} 个频道`,
      });
    }

    if (method === 'POST' && route === 'group/update') {
      const body = await readJson(request);
      const type = body.type === 'custom' ? 'custom' : 'whitelist';
      const name = String(body.name ?? '').trim();
      if (!name) throw new HttpError(400, '分组名不能为空');

      const { config } = await readConfig(env);
      const isWhitelist = config.settings.whitelist_groups.includes(name);
      if (type === 'whitelist' && !isWhitelist) throw new HttpError(400, `组播主分组「${name}」不存在`);
      if (type === 'custom' && isWhitelist) throw new HttpError(400, '该名称属于组播主分组，不能在自定义分组里编辑');

      const parsed = parseChannelText(body.text);
      if (!parsed.ok) throw new HttpError(400, parsed.error);

      // 在原位置替换频道，保持分组在输出中的先后顺序
      const kept = config.channels.filter((c) => c.group !== name);
      const firstIndex = config.channels.findIndex((c) => c.group === name);
      const insertAt = firstIndex >= 0 ? Math.min(firstIndex, kept.length) : kept.length;
      const added = parsed.items.map((item) => ({
        name: item.name,
        url: item.url,
        group: name,
        genre: item.genre,
      }));
      kept.splice(insertAt, 0, ...added);
      config.channels = kept;

      if (type === 'whitelist' && body.target !== undefined && String(body.target).trim() !== '') {
        const target = normalizeTarget(body.target);
        if (!target.ok) throw new HttpError(400, target.error);
        replaceGroupAuthority(config, name, target.authority);
        config.settings.region_ips[name] = target.authority;
      }

      await writeConfig(env, config);
      return json({ ok: true, message: `已保存分组「${name}」，共 ${parsed.items.length} 个频道` });
    }

    if (method === 'POST' && route === 'group/delete') {
      const body = await readJson(request);
      const type = body.type === 'custom' ? 'custom' : 'whitelist';
      const name = String(body.name ?? '').trim();
      if (!name) throw new HttpError(400, '分组名不能为空');

      const { config } = await readConfig(env);
      const before = config.channels.length;
      config.channels = config.channels.filter((c) => c.group !== name);
      const removed = before - config.channels.length;

      if (type === 'whitelist') {
        config.settings.whitelist_groups = config.settings.whitelist_groups.filter((g) => g !== name);
        delete config.settings.region_ips[name];
      }

      await writeConfig(env, config);
      return json({ ok: true, message: `已删除分组「${name}」，共移除 ${removed} 个频道` });
    }

    throw new HttpError(404, `未知接口：${route || '(空)'}`);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ ok: false, error: err.message }, err.status);
    }
    return json({ ok: false, error: `服务器错误：${err?.message ?? err}` }, 500);
  }
}
