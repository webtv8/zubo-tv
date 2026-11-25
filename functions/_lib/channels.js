/**
 * 频道与目标地址（IP / 域名 / IP:端口 / 域名:端口）的解析、校验与替换。
 * 纯函数，无 IO，方便单元测试。
 */

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:\/\//;
const MAX_HOST_LEN = 253;
const GENRE_SUFFIX = ',#genre#';
const GROUP_SUFFIX = ',#group#';

/* ------------------------------------------------------------------ */
/* 目标地址（新 IP/域名:端口）                                          */
/* ------------------------------------------------------------------ */

/**
 * 归一化并校验用户输入的目标地址。
 * 支持四种写法：IP、域名、IP:端口、域名:端口（也允许粘贴带协议的完整地址）。
 * @returns {{ok:true, host:string, port:string, authority:string} | {ok:false, error:string}}
 */
export function normalizeTarget(raw) {
  let input = String(raw ?? '').trim();
  if (!input) {
    return { ok: false, error: '请填写 IP、域名、IP:端口 或 域名:端口' };
  }

  // 允许用户直接粘贴 http://example.com:8080/ 这种完整地址
  if (SCHEME_RE.test(input)) input = input.replace(SCHEME_RE, '');
  if (input.startsWith('//')) input = input.slice(2);
  if (input.endsWith('/') && input.indexOf('/') === input.length - 1) {
    input = input.slice(0, -1);
  }

  if (/[/?#\s]/.test(input)) {
    return { ok: false, error: '只填写主机部分，不要包含路径、参数、空格或斜杠' };
  }

  let host = '';
  let port = '';

  // IPv6：[::1] 或 [::1]:8080
  const v6 = input.match(/^\[([0-9A-Fa-f:.]+)\](?::([0-9]{1,5}))?$/);
  if (v6) {
    host = `[${v6[1].toLowerCase()}]`;
    port = v6[2] ?? '';
  } else {
    const m = input.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
    if (!m) {
      return { ok: false, error: '格式不正确：端口只能用英文冒号分隔，例如 example.com:8080' };
    }
    host = m[1];
    port = m[2] ?? '';
  }

  const hostCheck = validateHost(host);
  if (!hostCheck.ok) return hostCheck;

  if (port !== '') {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, error: '端口超出范围，必须是 1-65535 之间的数字' };
    }
    port = String(n);
  }

  return {
    ok: true,
    host,
    port,
    authority: port ? `${host}:${port}` : host,
  };
}

function validateHost(host) {
  if (!host) return { ok: false, error: '主机名为空' };
  if (host.startsWith('[')) return { ok: true }; // IPv6 已在上面校验字符集

  if (host.length > MAX_HOST_LEN) {
    return { ok: false, error: '主机名过长（最多 253 个字符）' };
  }
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return { ok: false, error: '主机名中不能出现开头/结尾/连续的英文句点' };
  }

  // 纯数字四段：按 IPv4 校验，能挡住 999.1.1.1 这类手误
  if (/^\d+(?:\.\d+){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((p) => p > 255)) {
      return { ok: false, error: 'IPv4 地址每一段必须在 0-255 之间' };
    }
    return { ok: true };
  }

  const labels = host.split('.');
  for (const label of labels) {
    if (!/^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/.test(label)) {
      return {
        ok: false,
        error: `主机名片段 "${label}" 不合法：只能用字母、数字、连字符（每段 1-63 位，不能以连字符开头/结尾）`,
      };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* URL 中主机:端口的替换                                                */
/* ------------------------------------------------------------------ */

/**
 * 拆出 URL 的 authority（用户信息单独返回），保留路径与参数原样。
 * 只做正则，不吃 URL 对象的规范化，IPTV 地址的大小写/编码不会被改写。
 * @returns {{scheme:string, userinfo:string, authority:string, rest:string}|null}
 */
export function splitAuthority(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;

  const withScheme = url.match(/^([A-Za-z][A-Za-z0-9+.\-]*:\/\/)([^/?#]*)([\s\S]*)$/);
  if (withScheme) {
    const [, scheme, rawAuthority, rest] = withScheme;
    if (!rawAuthority) return null;
    const at = rawAuthority.lastIndexOf('@');
    return {
      scheme,
      userinfo: at >= 0 ? rawAuthority.slice(0, at + 1) : '',
      authority: rawAuthority.slice(at + 1),
      rest,
    };
  }

  // 无协议：形如 "239.3.1.129:8008/rtp/xxx"
  const bare = url.match(/^([^/?#]*)([\s\S]*)$/);
  if (bare && bare[1] && /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?$/.test(bare[1])) {
    return { scheme: '', userinfo: '', authority: bare[1], rest: bare[2] };
  }
  return null;
}

/**
 * 只取主机名（去掉端口和用户信息），用来判断"这条频道是不是指向本分组自己的代理地址"。
 */
export function hostOf(authority) {
  const a = String(authority ?? '').trim();
  if (!a) return '';
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end > 0 ? a.slice(0, end + 1).toLowerCase() : a.toLowerCase();
  }
  const at = a.lastIndexOf('@');
  const body = at >= 0 ? a.slice(at + 1) : a;
  const colon = body.indexOf(':');
  return (colon < 0 ? body : body.slice(0, colon)).toLowerCase();
}

/**
 * 把 URL 的 "协议 + 主机:端口" 部分替换成新的 authority，其余部分（路径、参数）原样保留。
 * @returns {{url:string, changed:boolean}|null}  null 表示无法识别为主机地址
 */
export function replaceAuthority(rawUrl, authority) {
  const parts = splitAuthority(rawUrl);
  if (!parts) return null;
  return {
    url: parts.scheme + parts.userinfo + authority + parts.rest,
    changed: parts.authority.toLowerCase() !== String(authority).toLowerCase(),
  };
}

/**
 * 把某个组播主分组下所有频道的 IP:端口 换掉。
 *
 * 只改"属于这个分组代理地址"的频道，避免把分组里混着的第三方直播源（台标备用源、CDN 链接）一起改坏：
 * - URL 路径里带 `/rtp/`（组播代理形态）→ 改
 * - URL 主机 == 分组当前地址的主机 → 改
 * - 分组还没配过地址（首次设置）→ 全部改，相当于给这个分组定义代理主机
 * - 其余（指向别的主机的非 rtp 链接）→ 原样保留，计入 untouched
 *
 * @returns {{handled:number, changed:number, skipped:string[], untouched:string[]}}
 */
export function replaceGroupAuthority(config, group, authority) {
  let handled = 0;
  let changed = 0;
  const skipped = [];
  const untouched = [];

  const currentAuthority = (config.settings?.region_ips ?? {})[group] ?? '';
  const currentHost = hostOf(currentAuthority);

  for (const channel of config.channels) {
    if ((channel.group ?? '') !== group) continue;
    handled += 1;

    const parts = splitAuthority(channel.url);
    if (!parts) {
      skipped.push(channel.name || '(未命名)');
      continue;
    }

    const isProxyStyle = parts.rest.includes('/rtp/');
    const sameHost = currentHost !== '' && hostOf(parts.authority) === currentHost;
    if (currentHost !== '' && !isProxyStyle && !sameHost) {
      untouched.push(channel.name || '(未命名)');
      continue;
    }

    const result = replaceAuthority(channel.url, authority);
    channel.url = result.url;
    if (result.changed) changed += 1;
  }
  return { handled, changed, skipped, untouched };
}

/* ------------------------------------------------------------------ */
/* 频道文本解析 / 序列化（沿用原有 "名称,URL" + "子分组,#genre#" 格式） */
/* ------------------------------------------------------------------ */

/**
 * @returns {{ok:true, items:Array<{name,url,genre}>} | {ok:false, error:string}}
 */
export function parseChannelText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  let genre = '默认';
  let invalid = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.endsWith(GROUP_SUFFIX)) continue; // 编辑区里不处理主分组标记
    if (line.endsWith(GENRE_SUFFIX)) {
      const next = line.slice(0, -GENRE_SUFFIX.length).trim();
      genre = next || '默认';
      continue;
    }

    const comma = line.indexOf(',');
    if (comma <= 0) {
      invalid += 1;
      continue;
    }
    const name = line.slice(0, comma).trim();
    const url = line.slice(comma + 1).trim();
    if (!name || !url) {
      invalid += 1;
      continue;
    }
    items.push({ name, url, genre });
  }

  if (invalid > 0 && items.length === 0) {
    return { ok: false, error: '内容无法解析，请使用「频道名称,URL」格式，子分组用「子分组名,#genre#」单独占一行' };
  }
  return { ok: true, items, invalid };
}

/**
 * 把一个分组的频道导出成可编辑文本（保持保存时的顺序）。
 */
export function serializeGroupText(config, group) {
  const genres = new Map();
  for (const channel of config.channels) {
    if ((channel.group ?? '') !== group) continue;
    const g = channel.genre || '默认';
    if (!genres.has(g)) genres.set(g, []);
    genres.get(g).push(channel);
  }

  const blocks = [];
  for (const [genre, list] of genres) {
    blocks.push(`${genre}${GENRE_SUFFIX}`);
    for (const channel of list) blocks.push(`${channel.name},${channel.url}`);
  }
  return blocks.join('\n');
}

/* ------------------------------------------------------------------ */
/* 分组名与统计                                                        */
/* ------------------------------------------------------------------ */

export function validateGroupName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, error: '请填写分组名称' };
  if (name.length > 50) return { ok: false, error: '分组名称最多 50 个字符' };
  if (/[,\r\n#]/.test(name)) {
    return { ok: false, error: '分组名称不能包含英文逗号、换行或 # 号' };
  }
  return { ok: true, name };
}

export function buildStats(config) {
  const whitelist = config.settings.whitelist_groups ?? [];
  const channels = config.channels ?? [];
  const customChannels = channels.filter((c) => !whitelist.includes(c.group ?? ''));
  const customGroups = new Set(customChannels.map((c) => c.group ?? ''));
  return {
    whitelistGroups: whitelist.length,
    customGroups: customGroups.size,
    customChannels: customChannels.length,
    totalChannels: channels.length,
  };
}
