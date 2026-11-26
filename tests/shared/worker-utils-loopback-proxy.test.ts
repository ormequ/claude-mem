import { describe, expect, it } from 'bun:test';
import { ensureLoopbackBypassesProxy } from '../../src/shared/worker-utils.js';

describe('ensureLoopbackBypassesProxy', () => {
  it('adds loopback hosts when NO_PROXY is unset', () => {
    const env: NodeJS.ProcessEnv = { ALL_PROXY: 'socks5://1.2.3.4:1' };
    ensureLoopbackBypassesProxy(env);
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(env.no_proxy).toBe('127.0.0.1,localhost,::1');
  });

  it('keeps existing entries and adds only what is missing', () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: 'example.com, localhost', no_proxy: '127.0.0.1,localhost,::1' };
    ensureLoopbackBypassesProxy(env);
    expect(env.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('127.0.0.1,localhost,::1');
  });

  it('lets Bun fetch reach loopback despite a socks5 proxy', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    const saved = { ...process.env };
    try {
      for (const k of ['NO_PROXY', 'no_proxy']) delete process.env[k];
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        process.env[k] = 'socks5://1.2.3.4:1';
      }
      ensureLoopbackBypassesProxy();
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      server.stop(true);
      process.env = saved;
    }
  });
});
