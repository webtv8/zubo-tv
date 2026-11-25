/**
 * 输出 txt / m3u。
 *
 * 输出永远包含全部频道：组播主分组按配置顺序排在前面，自定义分组永远排在后面。
 * 不做 IP 查询、不区分运营商；频道地址一律按保存内容原样输出。
 */
import { readConfig } from './store.js';

/** 收集分组 → 子分组 → 频道，保持保存时的顺序，白名单分组排在前面 */
function collect(config) {
  const map = new Map();
  for (const channel of config.channels ?? []) {
    const group = channel.group || '其他';
    const genre = channel.genre || '默认';
    if (!map.has(group)) map.set(group, new Map());
    const genres = map.get(group);
    if (!genres.has(genre)) genres.set(genre, []);
    genres.get(genre).push(channel);
  }

  const whitelist = config.settings?.whitelist_groups ?? [];
  const order = [];
  for (const group of whitelist) if (map.has(group)) order.push(group);
  for (const group of map.keys()) if (!whitelist.includes(group)) order.push(group);
  return { map, order, whitelist };
}

export function buildTxt(config) {
  const { map, order } = collect(config);
  const lines = [];

  for (const group of order) {
    lines.push(`${group},#group#`);
    for (const [genre, channels] of map.get(group)) {
      lines.push(`${genre},#genre#`);
      for (const channel of channels) {
        lines.push(`${channel.name},${channel.url}`);
      }
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function buildM3u(config) {
  const { map, order } = collect(config);
  const lines = ['#EXTM3U'];

  for (const group of order) {
    for (const [genre, channels] of map.get(group)) {
      for (const channel of channels) {
        lines.push(`#EXTINF:-1 group-title="${group}|${genre}",${channel.name}`);
        lines.push(channel.url);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * 输出响应：不分运营商，永远输出全部频道。
 */
export async function outputResponse(kind, request, env) {
  let config;
  try {
    ({ config } = await readConfig(env));
  } catch (err) {
    return new Response(`配置读取失败：${err.message}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const isM3u = kind === 'm3u';
  const body = isM3u ? buildM3u(config) : buildTxt(config);

  const headers = {
    'Content-Type': isM3u ? 'application/vnd.apple.mpegurl; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Disposition': `inline; filename="channels.${isM3u ? 'm3u' : 'txt'}"`,
    'Cache-Control': 'no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  };
  return new Response(body, { status: 200, headers });
}
