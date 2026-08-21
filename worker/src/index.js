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

export default {
  async fetch() {
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchGitHubWorkflow(env));
  },
};
