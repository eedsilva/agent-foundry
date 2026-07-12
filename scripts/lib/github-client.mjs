import { execFileSync } from 'node:child_process';

export const API_VERSION = '2026-03-10';
const USER_AGENT = 'agent-foundry-delivery-foundation/2.0';

export function parseRepository(value) {
  const [owner, repo, ...extra] = String(value ?? '').split('/');
  if (!owner || !repo || extra.length) throw new Error(`Repositório inválido: ${value}`);
  return { owner, repo, nameWithOwner: `${owner}/${repo}` };
}

export function resolveGitHubToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token?.trim()) return token.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(
      'Credencial GitHub ausente. Defina GH_TOKEN/GITHUB_TOKEN ou execute gh auth login.',
      { cause: error },
    );
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nextLink(value) {
  if (!value) return null;
  for (const part of value.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2].split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

export class GitHubClient {
  constructor(token, { delayMs = 500 } = {}) {
    this.token = token;
    this.delayMs = delayMs;
  }

  async request(endpoint, options = {}) {
    const { payload } = await this.requestWithMetadata(endpoint, options);
    return payload;
  }

  async requestWithMetadata(endpoint, options = {}, attempt = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const method = options.method ?? 'GET';
    const response = await fetch(url, {
      method,
      headers: {
        Accept: options.accept ?? 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!response.ok) {
      const message = payload?.message ?? `${response.status} ${response.statusText}`;
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 && /rate limit|secondary rate/i.test(message));
      if (retryable && attempt < 6) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000 * 2 ** attempt;
        console.warn(`GitHub pediu backoff (${response.status}); retry em ${wait} ms.`);
        await sleep(wait);
        return this.requestWithMetadata(endpoint, options, attempt + 1);
      }
      throw new Error(
        `${method} ${endpoint}: ${response.status} ${message}${payload?.errors ? `\n${JSON.stringify(payload.errors)}` : ''}`,
      );
    }
    if (method !== 'GET' && this.delayMs > 0) await sleep(this.delayMs);
    return { payload, headers: response.headers, status: response.status };
  }

  async graphql(query, variables = {}) {
    const payload = await this.request('/graphql', { method: 'POST', body: { query, variables } });
    if (payload?.errors?.length)
      throw new Error(`GraphQL: ${JSON.stringify(payload.errors, null, 2)}`);
    return payload.data;
  }

  async paginate(endpoint) {
    const results = [];
    const separator = endpoint.includes('?') ? '&' : '?';
    let next = `${endpoint}${separator}per_page=100`;
    while (next) {
      const { payload, headers } = await this.requestWithMetadata(next);
      if (!Array.isArray(payload)) throw new Error(`Resposta paginada inválida: ${endpoint}`);
      results.push(...payload);
      next = nextLink(headers.get('link'));
    }
    return results;
  }
}
