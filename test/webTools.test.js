import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createToolRegistry } from '../src/tools/index.js';
import { createWebFetchTool } from '../src/tools/webFetch.js';
import {
  createSearchProvider, createWebSearchTool, parseBingResults, parseDuckDuckGoResults,
} from '../src/tools/webSearch.js';
import { assertPublicUrl, isPrivateAddress } from '../src/tools/web/urlSafety.js';

let server;
let origin;
let observed = [];

function fetchTool(overrides = {}) {
  return createWebFetchTool({
    allowPrivateHosts: true,
    webFetchTimeoutMs: 1_000,
    ...overrides,
  });
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    observed.push(url.pathname);

    if (url.pathname === '/html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end([
        '<!doctype html><html><head><title>示例 页面</title>',
        '<script>alert("secret")</script></head><body>',
        '<h1>Hello</h1><p>World &amp; more</p>',
        '<a href="https://example.com/x">链接</a>',
        '</body></html>',
      ].join(''));
      return;
    }
    if (url.pathname === '/json') {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true,"值":"中文"}');
      return;
    }
    if (url.pathname === '/binary') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([1, 2, 3]));
      return;
    }
    if (url.pathname === '/big') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('x'.repeat(10_000));
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.setHeader('content-type', 'text/plain');
        res.end('late');
      }, 200);
      return;
    }
    if (url.pathname === '/redirect-ok') {
      res.statusCode = 302;
      res.setHeader('location', '/html');
      res.end();
      return;
    }
    if (url.pathname === '/redirect-loop') {
      res.statusCode = 302;
      res.setHeader('location', '/redirect-loop');
      res.end();
      return;
    }
    if (url.pathname === '/missing') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (url.pathname === '/error') {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('web 安全边界', () => {
  test('识别常见内网、保留和公网地址', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0', '::1', '::',
      'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1',
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  test('拒绝内网、非 http(s)、userinfo、非标准端口和解析到内网的域名', async () => {
    await assert.rejects(assertPublicUrl('http://127.0.0.1/'), /内网/);
    await assert.rejects(assertPublicUrl('file:///etc/passwd'), /http\/https/);
    await assert.rejects(assertPublicUrl('https://user:pass@example.com/'), /用户名或密码/);
    await assert.rejects(assertPublicUrl('https://example.com:8443/'), /端口/);
    await assert.rejects(
      assertPublicUrl('https://example.com/', {
        lookupImpl: async () => [{ address: '10.0.0.1', family: 4 }],
      }),
      /内网/,
    );
    await assert.rejects(
      assertPublicUrl('https://example.com/', { lookupImpl: async () => { throw new Error('DNS 失败'); } }),
      /无法解析域名/,
    );
  });

  test('web_fetch 默认拒绝本地地址，测试开关只用于本地服务', async () => {
    const result = await createWebFetchTool().invokeResult({ url: `${origin}/html` });
    assert.equal(result.status, 'rejected');
    assert.match(result.content, /内网|不允许访问端口/);
  });
});

describe('web_fetch', () => {
  test('把 HTML 压成可读文本，去掉脚本并保留链接目标', async () => {
    const result = await fetchTool().invokeResult({ url: `${origin}/html` });
    assert.equal(result.status, 'success');
    assert.equal(result.truncated, false);
    assert.match(result.content, /标题: 示例 页面/);
    assert.match(result.content, /Hello/);
    assert.match(result.content, /World & more/);
    assert.match(result.content, /链接 \(https:\/\/example\.com\/x\)/);
    assert.doesNotMatch(result.content, /alert\("secret"\)/);
    assert.match(result.content, /来源: 外部网页/);
  });

  test('保留 JSON 原文，拒绝二进制类型', async () => {
    const json = await fetchTool().invokeResult({ url: `${origin}/json` });
    assert.equal(json.status, 'success');
    assert.match(json.content, /"ok":true/);
    assert.match(json.content, /中文/);

    const binary = await fetchTool().invokeResult({ url: `${origin}/binary` });
    assert.equal(binary.status, 'rejected');
    assert.match(binary.content, /不支持的网页类型/);
  });

  test('按字节和字符截断', async () => {
    const bytes = await fetchTool({ webFetchMaxBytes: 100 }).invokeResult({ url: `${origin}/big` });
    assert.equal(bytes.status, 'truncated');
    assert.equal(bytes.truncated, true);
    assert.match(bytes.content, /内容已截断/);

    const chars = await fetchTool({ maxOutputChars: 20 }).invokeResult({ url: `${origin}/big` });
    assert.equal(chars.status, 'truncated');
    assert.match(chars.content, /内容已截断/);
  });

  test('跟随重定向，限制次数，HTTP 错误返回 error', async () => {
    const redirected = await fetchTool().invokeResult({ url: `${origin}/redirect-ok` });
    assert.equal(redirected.status, 'success');
    assert.match(redirected.content, /重定向: 1 次/);
    assert.match(redirected.content, /URL: .*\/html/);

    const limited = await fetchTool({ webFetchMaxRedirects: 0 }).invokeResult({ url: `${origin}/redirect-ok` });
    assert.equal(limited.status, 'error');
    assert.match(limited.content, /重定向超过 0 次/);

    const loop = await fetchTool({ webFetchMaxRedirects: 2 }).invokeResult({ url: `${origin}/redirect-loop` });
    assert.equal(loop.status, 'error');
    assert.match(loop.content, /重定向超过 2 次/);

    assert.match((await fetchTool().invokeResult({ url: `${origin}/missing` })).content, /HTTP 404/);
    assert.match((await fetchTool().invokeResult({ url: `${origin}/error` })).content, /HTTP 500/);
  });

  test('网络失败保留底层原因，便于模型区分重试与放弃', async () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const result = await fetchTool({ fetchImpl: async () => { throw failure; } })
      .invokeResult({ url: `${origin}/html` });
    assert.equal(result.status, 'error');
    assert.match(result.content, /fetch failed/);
    assert.match(result.content, /ECONNREFUSED/);
  });

  test('超时和取消都以工具结果返回，不抛到 Agent 循环', async () => {
    const timedOut = await fetchTool({ webFetchTimeoutMs: 20 }).invokeResult({ url: `${origin}/slow` });
    assert.equal(timedOut.status, 'error');
    assert.match(timedOut.content, /超时/);

    const controller = new AbortController();
    const pending = fetchTool().invokeResult({ url: `${origin}/slow` }, { signal: controller.signal });
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.status, 'rejected');
    assert.match(aborted.content, /已取消/);
  });
});

describe('web_search', () => {
  test('搜索工具格式化结果、去重 URL 并限制条数', async () => {
    const provider = {
      name: 'fake',
      search: async ({ query, maxResults }) => {
        assert.equal(query, 'agent harness');
        assert.equal(maxResults, 2);
        return [
          { title: 'A &amp; B', url: 'https://example.com/a', snippet: '<b>hi</b> there' },
          { title: 'dup', url: 'https://example.com/a', snippet: 'duplicate' },
          { title: 'C', url: 'javascript:alert(1)', snippet: 'bad' },
          { title: 'D', url: 'https://example.com/d', snippet: 'last' },
        ];
      },
    };
    const result = await createWebSearchTool({ searchProvider: provider, webSearchMaxResults: 2 })
      .invokeResult({ query: 'agent harness' });

    assert.equal(result.status, 'success');
    assert.match(result.content, /搜索: "agent harness"（fake）/);
    assert.match(result.content, /1\. A & B/);
    assert.match(result.content, /https:\/\/example\.com\/a/);
    assert.match(result.content, /hi there/);
    assert.match(result.content, /2\. D/);
    assert.doesNotMatch(result.content, /duplicate/);
    assert.doesNotMatch(result.content, /javascript:/);
  });

  test('没有结果、输出截断、provider 失败和超时', async () => {
    const empty = await createWebSearchTool({
      searchProvider: { name: 'empty', search: async () => [] },
    }).invokeResult({ query: 'nothing' });
    assert.match(empty.content, /没有结果/);

    const truncated = await createWebSearchTool({
      searchProvider: {
        name: 'long',
        search: async () => [{ title: 'x'.repeat(100), url: 'https://example.com/', snippet: 'y'.repeat(500) }],
      },
      maxOutputChars: 30,
    }).invokeResult({ query: 'x' });
    assert.equal(truncated.status, 'truncated');
    assert.match(truncated.content, /结果已截断/);

    const failed = await createWebSearchTool({
      searchProvider: { name: 'bad', search: async () => { throw new Error('上游挂了'); } },
    }).invokeResult({ query: 'x' });
    assert.equal(failed.status, 'error');
    assert.match(failed.content, /上游挂了/);

    const timedOut = await createWebSearchTool({
      searchProvider: {
        name: 'slow',
        search: ({ signal }) => new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        }),
      },
      webSearchTimeoutMs: 20,
    }).invokeResult({ query: 'x' });
    assert.equal(timedOut.status, 'error');
    assert.match(timedOut.content, /超时/);
  });

  test('解析 DuckDuckGo HTML，解码 uddg 跳转并跳过广告/重复项', () => {
    const html = [
      '<div class="result__body">',
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First &amp; One</a>',
      '<a class="result__snippet">Snippet <b>one</b></a>',
      '</div>',
      '<div class="result__body result--ad">',
      '<a class="result__a" href="https://ads.example/">Ad</a>',
      '</div>',
      '<div class="result__body">',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Duplicate</a>',
      '</div>',
      '<div class="result__body">',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Second</a>',
      '<div class="result__snippet">Snippet two</div>',
      '</div>',
    ].join('');

    const results = parseDuckDuckGoResults(html, 8);
    assert.deepEqual(results.map((item) => item.url), ['https://example.com/a', 'https://example.com/b']);
    assert.equal(results[0].title, 'First & One');
    assert.equal(results[0].snippet, 'Snippet one');
    assert.equal(results[1].snippet, 'Snippet two');
    assert.deepEqual(parseDuckDuckGoResults('<html>no results</html>'), []);
  });

  test('解析 Bing HTML，解码 ck/a 跳转并跳过广告/重复项', () => {
    const encoded = Buffer.from('https://example.com/b').toString('base64url');
    const html = [
      '<ol id="b_results">',
      '<li class="b_algo" data-id="one">',
      '<h2><a href="https://example.com/a">First &amp; One</a></h2>',
      '<div class="b_caption"><p>Snippet <b>one</b></p></div>',
      '</li>',
      '<li class="b_algo b_ad">',
      '<h2><a href="https://ads.example/">Ad</a></h2>',
      '</li>',
      '<li class="b_algo">',
      '<h2><a href="https://example.com/a">Duplicate</a></h2>',
      '</li>',
      '<li class="b_algo">',
      `<h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1${encoded}">Second</a></h2>`,
      '<div class="b_caption"><p>Snippet two</p></div>',
      '</li>',
      '</ol>',
    ].join('');

    const results = parseBingResults(html, 8);
    assert.deepEqual(results.map((item) => item.url), ['https://example.com/a', 'https://example.com/b']);
    assert.equal(results[0].title, 'First & One');
    assert.equal(results[0].snippet, 'Snippet one');
    assert.equal(results[1].snippet, 'Snippet two');
    assert.deepEqual(parseBingResults('<html>no results</html>'), []);
  });

  test('provider 选择：默认 Bing，显式 tavily 缺 key 时明确失败', () => {
    assert.throws(() => createSearchProvider({ webSearchProvider: 'tavily' }), /TAVILY_API_KEY/);
    assert.throws(() => createSearchProvider({ webSearchProvider: 'nope' }), /未知/);
    assert.equal(createSearchProvider({ webSearchProvider: 'auto' }).name, 'bing');
    assert.equal(createSearchProvider({ webSearchProvider: 'bing' }).name, 'bing');
    assert.equal(createSearchProvider({ webSearchProvider: 'duckduckgo' }).name, 'duckduckgo');
    assert.equal(createSearchProvider({ webSearchProvider: 'auto', tavilyApiKey: 'k' }).name, 'tavily');
  });
});

describe('注册与参数', () => {
  test('网络工具默认不注册，只有 includeWeb 才加入', () => {
    const root = process.cwd();
    const without = createToolRegistry({ workspaceRoot: root }, { includeExecCommand: false });
    assert.equal(without.names().includes('web_fetch'), false);
    assert.equal(without.names().includes('web_search'), false);

    const withWeb = createToolRegistry({ workspaceRoot: root }, {
      includeExecCommand: false,
      includeWeb: true,
    });
    assert.deepEqual(withWeb.names(), [
      'read_file', 'list_directory', 'search_files', 'apply_patch', 'write_file',
      'web_fetch', 'web_search',
    ]);
    assert.match(withWeb.getProcessor('web_fetch').summarize('URL: x\nfoo'), /^URL: x/);
  });

  test('web 工具参数错误由注册表转成文本', async () => {
    const registry = createToolRegistry({ workspaceRoot: process.cwd() }, {
      includeExecCommand: false,
      includeWeb: true,
    });
    assert.match(await registry.invoke('web_fetch', {}), /参数不合法/);
    assert.match(await registry.invoke('web_search', {}), /参数不合法/);
  });
});
