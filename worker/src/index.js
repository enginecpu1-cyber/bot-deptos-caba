// El schedule nativo de GitHub Actions no es confiable (ver README del bot de autos:
// nunca disparó solo en ese repo). El cron real vive acá: un Cron Trigger de Cloudflare
// dispara el workflow de GitHub por su API cada 30 minutos.

const GITHUB_REPO = "enginecpu1-cyber/bot-deptos-caba";
const GITHUB_WORKFLOW = "buscar-deptos.yml";

async function dispatchGitHubWorkflow(env) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "bot-deptos-caba-cron",
      },
      body: JSON.stringify({ ref: "master" }),
    }
  );
  if (!res.ok) {
    console.error(`GitHub dispatch error ${res.status}: ${await res.text()}`);
  }
}

// GitHub Actions tiene la IP bloqueada por el WAF de Argenprop (403 directo,
// challenge de AWS WAF), Cloudflare no. El scraper le pide las páginas de
// Argenprop a este proxy en vez de pedírselas directo.
async function handleArgenpropProxy(request, env) {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const target = new URL(request.url).searchParams.get("url");
  if (!target || !/^https:\/\/(www\.)?argenprop\.com\//.test(target)) {
    return new Response("bad url", { status: 400 });
  }

  const r = await fetch(target, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "es-AR,es;q=0.9",
    },
  });
  return new Response(await r.text(), { status: r.status });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/argenprop-proxy") {
      return handleArgenpropProxy(request, env);
    }
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchGitHubWorkflow(env));
  },
};
