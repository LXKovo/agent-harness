import { lookup as defaultLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const ALLOWED_PORTS = new Set([80, 443]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
];

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function privateIpv4(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function privateIpv6(address) {
  const value = normalizeHostname(address);

  // IPv4-mapped（::ffff:127.0.0.1）和 IPv4-compatible（::127.0.0.1）
  if (value.startsWith('::ffff:')) return privateIpv4(value.slice(7));
  if (value.startsWith('::') && value.includes('.')) return privateIpv4(value.slice(2));

  if (value === '::' || value === '::1') return true;
  if (/^2001:0*db8(:|$)/i.test(value)) return true; // 文档保留地址
  if (/^f[cd]/i.test(value)) return true; // unique local
  if (/^fe[89ab]/i.test(value)) return true; // link local
  if (/^fe[c-f]/i.test(value)) return true; // 已废弃的 site local
  if (/^ff/i.test(value)) return true; // multicast

  // 全局单播只有 2000::/3。其余前缀一律按不可访问处理，
  // 避免为每个保留前缀维护一份容易漏项的名单。
  return !/^[23]/i.test(value);
}

/**
 * 判断一个已解析的 IP 是否属于不允许 web_fetch 访问的地址。
 *
 * 这是 SSRF 的第一道检查：DNS 解析结果里只要有一个内网地址就拒绝。
 * 它不能防住 DNS rebinding（解析后 fetch 会再次解析），这一点在
 * docs/CONSTRAINTS.md 里明确记录，不假装已经解决。
 */
export function isPrivateAddress(address) {
  const value = normalizeHostname(address);
  const version = isIP(value);
  if (version === 4) return privateIpv4(value);
  if (version === 6) return privateIpv6(value);
  return true;
}

/**
 * 校验 URL，并解析域名确认不指向内网。
 *
 * `allowPrivateHosts` 只给离线测试用：测试要连 127.0.0.1 的本地 HTTP 服务，
 * 生产路径永远走默认的 false。调用方不要把这个开关暴露给模型。
 */
export async function assertPublicUrl(rawUrl, {
  allowPrivateHosts = false,
  allowedPorts = ALLOWED_PORTS,
  lookupImpl = defaultLookup,
} = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL 不合法');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http/https URL');
  }
  if (url.username || url.password) {
    throw new Error('URL 不能包含用户名或密码');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error('URL 缺少主机名');

  const port = url.port
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80);

  if (allowPrivateHosts) {
    return { url, hostname, port };
  }

  if (!allowedPorts.has(port)) {
    throw new Error(`不允许访问端口 ${port}（只允许 80/443）`);
  }

  if (BLOCKED_HOSTNAMES.has(hostname)
    || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`拒绝访问内部主机名: ${hostname}`);
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`拒绝访问内网地址: ${hostname}`);
    }
    return { url, hostname, port };
  }

  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`无法解析域名: ${hostname}`);
  }
  if (!addresses.length) throw new Error(`域名没有解析结果: ${hostname}`);

  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry.address;
    if (isPrivateAddress(address)) {
      throw new Error(`拒绝访问内网地址: ${hostname} -> ${address}`);
    }
  }

  return { url, hostname, port };
}
