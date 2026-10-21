const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', times: '×', divide: '÷',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '',
};

function codePoint(value, radix) {
  const point = Number.parseInt(value, radix);
  if (!Number.isInteger(point) || point < 0 || point > 0x10FFFF) return '';
  try {
    return String.fromCodePoint(point);
  } catch {
    return '';
  }
}

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, decimal) => codePoint(decimal, 10))
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

export function stripTags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ');
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

export function extractTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  if (!match) return '';
  return decodeEntities(stripTags(match[1])).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * 把 HTML 压成可读文本。
 *
 * 不追求完整 DOM 语义：去掉脚本/样式/导航噪声，保留段落、列表和链接目标，
 * 让模型读正文而不是标签。输出仍可能包含网页里的提示注入文本，调用方必须
 * 把它当作不可信内容。
 */
export function htmlToText(html, maxChars = 0) {
  let text = String(html ?? '');

  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');

  // 保留链接目标：正文 + (https://...)。相对链接不展开，避免制造假 URL。
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (match, attributes, label) => {
    const href = decodeEntities(attribute(attributes, 'href'));
    const visible = stripTags(label).replace(/\s+/g, ' ').trim();
    if (!visible) return ' ';
    if (/^https?:\/\//i.test(href) && href !== visible) return `${visible} (${href})`;
    return visible;
  });

  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = decodeEntities(attribute(tag, 'alt')).replace(/\s+/g, ' ').trim();
    return alt ? `[图片: ${alt}]` : ' ';
  });

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(li|tr)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|h[1-6]|blockquote|pre|form|fieldset|figure|figcaption|table|thead|tbody|tfoot|ul|ol|dl|dd|dt)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');

  text = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return text;
}

export function compactText(value, maxChars = 400) {
  const text = decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  return `${/[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced}…`;
}
