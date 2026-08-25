import { app } from './app.js';
import { requireRuntimeEnv, type RuntimeEnv } from './runtime-env.js';

const invalidConfiguration = () =>
  new Response(JSON.stringify({ error: 'Worker runtime is not configured.' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });

export default {
  fetch(request: Request, bindings: Partial<RuntimeEnv>) {
    let runtimeEnv: RuntimeEnv;
    try {
      runtimeEnv = requireRuntimeEnv(bindings);
    } catch {
      return invalidConfiguration();
    }
    return app.fetch(request, runtimeEnv);
  },
};
