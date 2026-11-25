/**
 * 本地逻辑自测（不需要 wrangler / Cloudflare 账号）：
 *   node test/run.mjs
 * 用内存 KV 模拟 CONFIG_KV，直接调用 API 处理器验证登录、地址替换与输出。
 */
import assert from 'node:assert/strict';
import { handleApi } from '../functions/_lib/api.js';

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
}

const BASE = 'https://demo.example.com';
const env = {
  ADMIN_PASSWORD: 'test-pass-123',
  CONFIG_KV: new MemoryKV(),
};

let cookie = '';
let passed = 0;

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie && !headers.Cookie) init.headers.Cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await handleApi(new Request(`${BASE}/api/${path}`, init), env);
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function ok(name, cond, extra) {
  assert.ok(cond, `${name} 失败${extra ? `：${extra}` : ''}`);
  passed += 1;
}

/* --------------------------- 1. 未登录状态 --------------------------- */
{
  const session = await call('session');
  ok('session 未登录', session.data.authenticated === false);
  ok('session 识别密码已配置', session.data.passwordConfigured === true);

  const state = await call('state');
  ok('未登录不能读配置', state.status === 401, JSON.stringify(state.data));

  const login = await call('login', { method: 'POST', body: { password: 'wrong' } });
  ok('错误密码返回 401', login.status === 401);

  const noJson = await call('login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: undefined });
  ok('非 JSON 请求被拒绝', noJson.status === 415);
}

/* --------------------------- 2. 登录 --------------------------- */
{
  const login = await call('login', { method: 'POST', body: { password: 'test-pass-123' } });
  ok('正确密码登录成功', login.status === 200 && login.data.ok === true);
  ok('下发会话 Cookie', Boolean(cookie));

  const state = await call('state');
  ok('登录后可读配置', state.status === 200);
  ok('输出地址正确', state.data.output.txt === `${BASE}/txt`);
}

/* --------------------------- 3. 添加组播主分组 --------------------------- */
const sampleText = ['卫视频道,#genre#', 'CCTV1,http://125.33.94.8:4022/rtp/239.3.1.129:8008', 'CCTV2,http://125.33.94.8:4022/rtp/239.3.1.60:8084', '', '体育频道,#genre#', 'CCTV5,http://125.33.94.8:4022/rtp/239.3.1.130:8009'].join('\n');

{
  const res = await call('group/add', {
    method: 'POST',
    body: { type: 'whitelist', name: 'A市', target: '82.1.1.1', text: sampleText },
  });
  ok('添加主分组（IP 不带端口）', res.status === 200, JSON.stringify(res.data));

  const { data } = await call('state');
  const urls = data.config.channels.map((c) => c.url);
  ok('新分组频道已去掉端口', urls.every((u) => u.startsWith('http://82.1.1.1/rtp/')), urls.join(' | '));
  ok('路径部分保留', urls[0] === 'http://82.1.1.1/rtp/239.3.1.129:8008', urls[0]);
  ok('region_ips 记录为 82.1.1.1', data.config.settings.region_ips['A市'] === '82.1.1.1');

  // 重复名称
  const dup = await call('group/add', {
    method: 'POST',
    body: { type: 'whitelist', name: 'A市', target: '1.1.1.1', text: sampleText },
  });
  ok('重复分组名被拒绝', dup.status === 409, JSON.stringify(dup.data));
}

/* --------------------------- 4. 四种地址写法 --------------------------- */
{
  const cases = [
    ['10.0.0.5', 'http://10.0.0.5/rtp/239.3.1.129:8008'],
    ['10.0.0.5:4022', 'http://10.0.0.5:4022/rtp/239.3.1.129:8008'],
    ['vod.example.com', 'http://vod.example.com/rtp/239.3.1.129:8008'],
    ['vod.example.com:8080', 'http://vod.example.com:8080/rtp/239.3.1.129:8008'],
  ];

  for (const [target, expectedFirst] of cases) {
    const res = await call('target', { method: 'POST', body: { region: 'A市', target } });
    ok(`更新地址 ${target}`, res.status === 200, JSON.stringify(res.data));
    const { data } = await call('state');
    const first = data.config.channels.find((c) => c.name === 'CCTV1');
    ok(`替换结果 ${target}`, first.url === expectedFirst, `实际 ${first.url}`);
  }

  // 粘贴完整 URL 也能识别
  const full = await call('target', { method: 'POST', body: { region: 'A市', target: 'https://full.example.com:9443/' } });
  ok('允许粘贴完整 URL', full.status === 200, JSON.stringify(full.data));

  // 非法输入
  for (const bad of ['999.1.1.1:4022', 'http://x.com/path', 'a b', 'host:70000', '']) {
    const res = await call('target', { method: 'POST', body: { region: 'A市', target: bad } });
    ok(`拒绝非法地址「${bad}」`, res.status === 400, JSON.stringify(res.data));
  }

  // 无协议头的频道地址
  await call('group/add', {
    method: 'POST',
    body: { type: 'custom', name: '裸地址', text: '默认,#genre#\n裸1,239.3.1.9:8000/rtp/x' },
  });
  const { data } = await call('state');
  const bare = data.config.channels.find((c) => c.name === '裸1');
  ok('无协议地址原样保存', bare && bare.url === '239.3.1.9:8000/rtp/x', bare?.url);
}

/* --------------------------- 5. 输出格式 --------------------------- */
{
  const txt = await call('output?jk=txt');
  ok('txt 可匿名访问', txt.status === 200);
  ok('txt 含 #group#', txt.data.includes('A市,#group#'));
  ok('txt 含 #genre#', txt.data.includes('卫视频道,#genre#'));

  const m3u = await call('output?jk=m3u');
  ok('m3u 可匿名访问', m3u.status === 200);
  ok('m3u 以 #EXTM3U 开头', m3u.data.startsWith('#EXTM3U'));
  ok('m3u group-title 正确', m3u.data.includes('group-title="A市|卫视频道"'));

  const { data } = await call('state');
  const txtIdx = txt.data.indexOf('A市,#group#');
  const customIdx = txt.data.indexOf('裸地址,#group#');
  ok('自定义分组排在组播分组之后', customIdx > txtIdx);
}

/* --------------------------- 6. 编辑 / 删除 --------------------------- */
{
  const update = await call('group/update', {
    method: 'POST',
    body: { type: 'whitelist', name: 'A市', text: '新子分组,#genre#\n新频道,http://125.33.94.8:4022/rtp/1.2.3.4:5000' },
  });
  ok('保存分组内容', update.status === 200, JSON.stringify(update.data));

  const { data } = await call('state');
  ok('频道被整体替换', data.config.channels.filter((c) => c.group === 'A市').length === 1);
  ok('保存时未改地址', data.config.channels.find((c) => c.group === 'A市').url.startsWith('http://125.33.94.8:4022/'));

  const textAfter = '新子分组,#genre#\n新频道,http://125.33.94.8:4022/rtp/1.2.3.4:5000';
  const withTarget = await call('group/update', {
    method: 'POST',
    body: { type: 'whitelist', name: 'A市', target: 'new.example.com', text: textAfter },
  });
  ok('保存时可同时改地址', withTarget.status === 200, JSON.stringify(withTarget.data));
  const after = await call('state');
  const saved = after.data.config.channels.find((c) => c.group === 'A市');
  ok('保存后地址已替换', saved.url === 'http://new.example.com/rtp/1.2.3.4:5000', saved.url);

  const del = await call('group/delete', { method: 'POST', body: { type: 'custom', name: '裸地址' } });
  ok('删除自定义分组', del.status === 200, JSON.stringify(del.data));
  const afterDel = await call('state');
  ok('删除后频道消失', !afterDel.data.config.channels.some((c) => c.group === '裸地址'));
}

/* --------------------------- 6.5 输出全部分组（主分组在前）+ 组播跳转 --------------------------- */
{
  await call('group/add', {
    method: 'POST',
    body: { type: 'whitelist', name: '电信组播', target: '1.1.1.1:4022', text: '默认,#genre#\n电信1,http://1.1.1.1:4022/rtp/239.77.0.14:5146' },
  });
  await call('group/add', {
    method: 'POST',
    body: { type: 'whitelist', name: '联通组播', target: '2.2.2.2:4022', text: '默认,#genre#\n联通1,http://2.2.2.2:4022/rtp/239.77.1.20:8120' },
  });
  await call('group/add', {
    method: 'POST',
    body: { type: 'whitelist', name: '北京组播', target: '3.3.3.3:4022', text: '默认,#genre#\n北京1,http://3.3.3.3:4022/rtp/239.77.0.8:5148' },
  });
  await call('group/add', {
    method: 'POST',
    body: { type: 'custom', name: '自定义样例', text: '默认,#genre#\n样例1,http://example.com/a.m3u8' },
  });

  const out = await call('output?jk=txt');
  ok(
    '输出包含全部组播主分组与自定义分组',
    ['电信组播,#group#', '联通组播,#group#', '北京组播,#group#', '自定义样例,#group#'].every((g) => out.data.includes(g)),
    out.data,
  );
  {
    const customIdx = out.data.indexOf('自定义样例,#group#');
    const lastWhitelistIdx = Math.max(
      ...['A市,#group#', '电信组播,#group#', '联通组播,#group#', '北京组播,#group#'].map((g) => out.data.indexOf(g)),
    );
    ok('自定义分组永远排在所有主分组之后', customIdx > lastWhitelistIdx && customIdx > 0, `${customIdx} / ${lastWhitelistIdx}`);
  }
  ok('不再返回运营商相关响应头', !out.headers.get('X-ISP') && !out.headers.get('X-ISP-Source'));

  const withParam = await call('output?jk=txt&isp=telecom');
  ok('?isp 参数不再影响输出内容', withParam.data === out.data);

  ok('组播地址按保存内容原样输出（不做 302 改写）', out.data.includes('北京1,http://3.3.3.3:4022/rtp/239.77.0.8:5148'), out.data);
  ok('自定义分组里的非组播地址不受影响', out.data.includes('样例1,http://example.com/a.m3u8'));

  const state = await call('state');
  ok('state 不返回运营商字段', !('ispGroups' in state.data) && !('detectedIsp' in state.data));
  ok('state 不返回输出设置', !('outputSettings' in state.data), JSON.stringify(Object.keys(state.data)));
  ok('输出设置接口已移除', (await call('output-settings', { method: 'POST', body: { multicastRedirect: true } })).status === 404);
}

/* --------------------------- 6.6 只改本分组代理地址（对齐 Utils::updateUrlIP） --------------------------- */
{
  // 先建一个已有地址的分组（新增时会统一改写，属于既有约定）
  await call('group/add', {
    method: 'POST',
    body: { type: 'whitelist', name: '混合源组', target: '10.9.9.9:4022', text: '默认,#genre#\n代理台,http://125.33.94.8:4022/rtp/239.1.1.1:8000' },
  });
  // 之后再往里粘外部源（编辑分组不会改地址）
  await call('group/update', {
    method: 'POST',
    body: {
      type: 'whitelist',
      name: '混合源组',
      text:
        '默认,#genre#\n' +
        '代理台,http://10.9.9.9:4022/rtp/239.1.1.1:8000\n' +
        '外部台,http://cdn.other.com/live/a.m3u8\n' +
        '同主机非rtp,http://10.9.9.9:4022/live/b.m3u8',
    },
  });

  const upd = await call('target', { method: 'POST', body: { region: '混合源组', target: 'new.example.com:8080' } });
  ok('更新地址成功', upd.status === 200, JSON.stringify(upd.data));
  ok('提示里说明有频道保持原样', String(upd.data.message).includes('保持原样'), upd.data.message);

  const st = await call('state');
  const urls = new Map(st.data.config.channels.filter((c) => c.group === '混合源组').map((c) => [c.name, c.url]));
  ok('rtp 代理地址改写成新地址', urls.get('代理台') === 'http://new.example.com:8080/rtp/239.1.1.1:8000', urls.get('代理台'));
  ok('指向别的主机的非 rtp 链接保持原样', urls.get('外部台') === 'http://cdn.other.com/live/a.m3u8', urls.get('外部台'));
  ok('本分组主机的非 rtp 路径也跟着换', urls.get('同主机非rtp') === 'http://new.example.com:8080/live/b.m3u8', urls.get('同主机非rtp'));

  const badPort = await call('target', { method: 'POST', body: { region: '混合源组', target: '1.1.1.1:99999' } });
  ok('端口 99999 被拒绝', badPort.status === 400, JSON.stringify(badPort.data));

  // 只填 IP（不带端口）时，频道原有端口要被去掉
  const bare = await call('target', { method: 'POST', body: { region: '电信组播', target: '8.8.8.8' } });
  ok('只填 IP 的地址接受', bare.status === 200, JSON.stringify(bare.data));
  const st3 = await call('state');
  const c3 = st3.data.config.channels.find((c) => c.group === '电信组播' && c.name === '电信1');
  ok('只填 IP 时频道端口被去掉', c3.url === 'http://8.8.8.8/rtp/239.77.0.14:5146', c3 && c3.url);
}

/* --------------------------- 6.8 新增分组的默认示例文本 --------------------------- */
{
  const st = await call('state');
  const sample = st.data.config.settings.new_group_text_default;
  ok(
    'state 带出新分组默认示例文本',
    typeof sample === 'string' && sample.includes('卫视频道,#genre#') && sample.includes('CCTV5'),
    sample,
  );

  const raw = await env.CONFIG_KV.get('config');
  const edited = JSON.parse(raw);
  edited.settings.new_group_text_default = '自定义模板,#genre#\n测试台,http://a.example.com/1.m3u8';
  await env.CONFIG_KV.put('config', JSON.stringify(edited));

  const st2 = await call('state');
  ok('KV 里改过的默认文本会生效', st2.data.config.settings.new_group_text_default.includes('自定义模板'));

  await env.CONFIG_KV.put('config', raw);
}

/* --------------------------- 7. 已移除的功能 & 安全 --------------------------- */
{
  const pw = await call('password/change', { method: 'POST', body: { new_password: 'x' } });
  ok('修改密码接口已移除', pw.status === 404);

  const csrf = await call('target', {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com' },
    body: { region: 'A市', target: '1.1.1.1' },
  });
  ok('跨站来源被拒绝', csrf.status === 403);

  const forged = cookie;
  cookie = 'mrs_session=v1.MQ.ZZZ';
  const forgedRes = await call('state');
  ok('伪造 Cookie 被拒绝', forgedRes.status === 401);

  cookie = forged;
  const logout = await call('logout', { method: 'POST', body: {} });
  ok('退出登录成功', logout.status === 200);
  const after = await call('state');
  ok('退出后失效', after.status === 401);
}

console.log(`\n✅ 全部通过：${passed} 项断言`);
