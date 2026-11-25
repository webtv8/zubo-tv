/**
 * 配置存储：Cloudflare KV（免费额度：10 万次读/天、1000 次写/天）。
 * 单一 key，保存整份配置 JSON。
 */

const CONFIG_KEY = 'config';

/** 新增组播主分组时文本框的默认示例内容（对应原版 config/default_config.php 的 new_group_text_default） */
export const DEFAULT_NEW_GROUP_TEXT = `卫视频道,#genre#
CCTV1,http://192.168.0.1:4022/rtp/239.3.1.129:8008
CCTV2,http://192.168.1.1:4022/rtp/239.3.1.60:8084

体育频道,#genre#
CCTV5,http://192.168.0.1:4022/rtp/239.3.1.130:8009`;

export const DEFAULT_CONFIG = {
  settings: {
    whitelist_groups: [],
    region_ips: {},
    new_group_text_default: DEFAULT_NEW_GROUP_TEXT,
  },
  groups: [],
  channels: [],
};

export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const srcSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};

  const whitelistGroups = Array.isArray(srcSettings.whitelist_groups)
    ? srcSettings.whitelist_groups.map((g) => String(g)).filter(Boolean)
    : [];

  const regionIps = {};
  if (srcSettings.region_ips && typeof srcSettings.region_ips === 'object') {
    for (const [k, v] of Object.entries(srcSettings.region_ips)) {
      if (typeof v === 'string') regionIps[String(k)] = v;
    }
  }

  const channels = [];
  if (Array.isArray(raw.channels)) {
    for (const ch of raw.channels) {
      if (!ch || typeof ch !== 'object') continue;
      const name = String(ch.name ?? '').trim();
      const url = String(ch.url ?? '').trim();
      if (!name && !url) continue;
      channels.push({
        name,
        url,
        group: String(ch.group ?? '其他'),
        genre: String(ch.genre ?? '默认'),
        enabled: ch.enabled === false ? false : true,
      });
    }
  }

  // 兼容旧 PHP 版的 groups 表（{name, enabled}），保留但不参与输出过滤
  const groups = [];
  const groupNames = new Set(whitelistGroups);
  const seen = new Set();
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      const name = String(g?.name ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      groups.push({ name, enabled: g?.enabled === false ? false : true });
    }
  }
  for (const ch of channels) {
    const name = ch.group;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    groups.push({ name, enabled: true });
  }
  for (const name of groupNames) {
    if (!seen.has(name)) {
      seen.add(name);
      groups.push({ name, enabled: true });
    }
  }

  return {
    settings: {
      whitelist_groups: whitelistGroups,
      region_ips: regionIps,
      new_group_text_default:
        typeof srcSettings.new_group_text_default === 'string'
          ? srcSettings.new_group_text_default
          : DEFAULT_NEW_GROUP_TEXT,
    },
    groups,
    channels,
  };
}

export async function readConfig(env) {
  const kv = env?.CONFIG_KV;
  if (kv) {
    const stored = await kv.get(CONFIG_KEY);
    if (stored) {
      try {
        return { config: normalizeConfig(JSON.parse(stored)), source: 'kv' };
      } catch {
        throw new HttpError(500, 'CONFIG_KV 中的配置不是合法 JSON，请检查或清空该 key');
      }
    }
  }

  // 首次访问：允许通过环境变量注入初始配置（方便从旧 PHP 版本迁移数据）
  if (env?.SEED_CONFIG_JSON) {
    try {
      return { config: normalizeConfig(JSON.parse(env.SEED_CONFIG_JSON)), source: 'seed' };
    } catch {
      throw new HttpError(500, '环境变量 SEED_CONFIG_JSON 不是合法 JSON');
    }
  }

  return { config: structuredClone(DEFAULT_CONFIG), source: 'default' };
}

export async function writeConfig(env, config) {
  const kv = env?.CONFIG_KV;
  if (!kv) {
    throw new HttpError(500, '未绑定 KV 命名空间：请在 Cloudflare 控制台创建 KV 并绑定为 CONFIG_KV');
  }
  const payload = normalizeConfig(config);
  await kv.put(CONFIG_KEY, JSON.stringify(payload));
  return payload;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
