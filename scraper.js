// Bot de búsqueda de deptos en alquiler (MercadoLibre + Argenprop) en CABA -> avisa por Telegram con foto.
// Corre vía GitHub Actions (ver .github/workflows/buscar-deptos.yml).

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const PRICE_MIN = 0;
const PRICE_MAX = 600_000;
// Monoambiente (amplio) a 2 ambientes con balcón — pedido explícito de Nicolás.
const ROOMS_SEGMENT = "1-a-2-ambientes"; // confirmado: slug real de ML para el rango 1 a 2 ambientes
const FURNISHED_FILTER = "FURNISHED_242085"; // confirmado: id del atributo "Es amoblado" en ML

const BARRIOS = ["recoleta", "palermo", "almagro"];

const STATE_FILE = path.join(__dirname, "sent_ids.json");
const CHATS_FILE = path.join(__dirname, "chat_ids.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function loadSentIds() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveSentIds(sent) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(sent, null, 2));
}

function loadChatState() {
  try {
    return JSON.parse(fs.readFileSync(CHATS_FILE, "utf-8"));
  } catch {
    return { chatIds: [], lastUpdateId: 0 };
  }
}

function saveChatState(state) {
  fs.writeFileSync(CHATS_FILE, JSON.stringify(state, null, 2));
}

// Cualquiera que le escriba al bot (aunque sea "hola") queda agregado a la lista de
// destinatarios de los avisos, además del TELEGRAM_CHAT_ID fijo. Usa el offset de
// Telegram para no releer mensajes ya procesados en corridas anteriores.
async function refreshChatIds() {
  const state = loadChatState();
  const chatIds = new Set(state.chatIds);

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${state.lastUpdateId + 1}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[telegram] getUpdates HTTP ${res.status}`);
    return [...chatIds];
  }
  const data = await res.json();
  if (!data.ok) return [...chatIds];

  let maxUpdateId = state.lastUpdateId;
  for (const update of data.result) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const chat = update.message?.chat;
    if (chat && chat.type === "private") {
      chatIds.add(String(chat.id));
    }
  }

  saveChatState({ chatIds: [...chatIds], lastUpdateId: maxUpdateId });
  return [...chatIds];
}

function moneyFromAriaLabel(ariaLabel) {
  if (!ariaLabel) return null;
  const digits = ariaLabel.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

function moneyWithCurrencyFromAriaLabel(ariaLabel) {
  const amount = moneyFromAriaLabel(ariaLabel);
  if (amount == null) return null;
  const currency = /d[oó]lar/i.test(ariaLabel || "") ? "USD" : "ARS";
  return { amount, currency };
}

function hasBalcon(text) {
  return /balc[oó]n/i.test(text || "");
}

// "Monoambiente" en ML/Argenprop es 1 ambiente (0 dormitorios); si el título no lo aclara
// no se puede saber con certeza, se muestra igual con la etiqueta "revisar".
function roomsLabel(text) {
  if (!text) return null;
  if (/monoambiente/i.test(text)) return "Monoambiente";
  const m = text.match(/\b([1-9])\s*ambientes?\b/i);
  return m ? `${m[1]} ambiente${m[1] === "1" ? "" : "s"}` : null;
}

// --- MercadoLibre ---

function buildMLUrl(barrio) {
  return `https://inmuebles.mercadolibre.com.ar/departamentos/alquiler/${ROOMS_SEGMENT}/capital-federal/${barrio}/_PriceRange_${PRICE_MIN}ARS-${PRICE_MAX}ARS_${FURNISHED_FILTER}`;
}

function parseMLCards(html, barrio) {
  const $ = cheerio.load(html);
  const listings = [];

  $("li.ui-search-layout__item").each((_, el) => {
    const card = $(el);
    const titleEl = card.find("a.poly-component__title").first();
    const title = titleEl.text().trim();
    const link = (titleEl.attr("href") || "").split("#")[0];
    if (!title || !link) return;

    const idMatch = link.match(/MLA-?(\d+)/);
    const id = idMatch ? `MLA${idMatch[1]}` : link;

    const priceAria = card
      .find(".poly-price__current .andes-money-amount")
      .first()
      .attr("aria-label");
    const priceInfo = moneyWithCurrencyFromAriaLabel(priceAria);
    const price = priceInfo ? priceInfo.amount : null;
    const priceCurrency = priceInfo ? priceInfo.currency : "ARS";

    const location = card.find(".poly-component__location").first().text().trim();
    const image = card.find(".poly-component__picture").first().attr("src") || null;

    listings.push({
      id,
      source: "ml",
      title,
      link,
      price,
      priceCurrency,
      location,
      image,
      barrio,
      rooms: roomsLabel(title),
      balcon: hasBalcon(title),
    });
  });

  return listings;
}

async function fetchML(barrio) {
  const url = buildMLUrl(barrio);
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "es-AR,es;q=0.9",
    },
  });
  if (!res.ok) {
    console.error(`[ml:${barrio}] HTTP ${res.status}`);
    return [];
  }
  return parseMLCards(await res.text(), barrio);
}

// --- Argenprop ---
// Sin filtro de URL confiable para precio/ambientes (los que probamos no aplicaron), así que
// se trae solo con el filtro de amoblado (confirmado, ?con-amoblado) y se filtra acá con los
// datos que cada card ya trae en sus atributos (montooperacion, dormitorios, idmoneda).

function buildArgenpropUrl(barrio) {
  return `https://www.argenprop.com/departamentos/alquiler/${barrio}?con-amoblado`;
}

function parseArgenpropCards(html, barrio) {
  const $ = cheerio.load(html);
  const listings = [];

  $("div.listing__item").each((_, el) => {
    const card = $(el);
    const anchor = card.find("a.card").first();
    const link = anchor.attr("href");
    const idAttr = anchor.attr("data-item-card") || anchor.attr("idaviso");
    if (!link || !idAttr) return;

    const title =
      card.find(".card__title--primary").first().text().trim() ||
      card.find(".card__title").first().text().trim();
    const address = card.find(".card__address").first().text().trim();

    const priceRaw = anchor.attr("montooperacion");
    const price = priceRaw ? parseInt(priceRaw, 10) : null;
    const currency = anchor.attr("idmoneda") === "2" ? "USD" : "ARS";

    const dormitorios = anchor.attr("dormitorios");
    const ambientesAttr = anchor.attr("ambientes");

    const infoText = card.find(".card__info").first().text().trim();
    const rooms =
      roomsLabel(infoText) ||
      roomsLabel(title) ||
      (dormitorios === "0" ? "Monoambiente" : ambientesAttr ? `${ambientesAttr} ambientes` : null);

    const image =
      card.find("img[data-src]").first().attr("data-src") ||
      card.find("img").first().attr("src") ||
      null;

    listings.push({
      id: `AP${idAttr}`,
      source: "argenprop",
      title: title || address,
      link: link.startsWith("http") ? link : `https://www.argenprop.com${link}`,
      price,
      priceCurrency: currency,
      location: address ? `${address}, ${barrio}` : barrio,
      image,
      barrio,
      rooms,
      balcon: hasBalcon(title) || hasBalcon(infoText),
    });
  });

  return listings;
}

async function fetchArgenprop(barrio) {
  const url = buildArgenpropUrl(barrio);
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "es-AR,es;q=0.9",
    },
  });
  if (!res.ok) {
    console.error(`[argenprop:${barrio}] HTTP ${res.status}`);
    return [];
  }
  return parseArgenpropCards(await res.text(), barrio);
}

// --- Filtro común ---

function evaluateListing(listing) {
  if (listing.price == null) return null;

  // Solo confiamos en el precio cuando está en pesos: en USD no tenemos cotización
  // cargada acá (a diferencia del bot de autos), así que se descarta en vez de arriesgar.
  if (listing.priceCurrency !== "ARS") return null;
  if (listing.price < PRICE_MIN || listing.price > PRICE_MAX) return null;

  // "Alquiler temporario" se publica en pesos por día (no por mes), así que su precio
  // no es comparable contra el rango mensual pedido — se descarta para no engañar.
  if (/temporari[oa]/i.test(listing.title)) return null;

  return listing;
}

function formatMoney(n) {
  return "$" + n.toLocaleString("es-AR");
}

function formatCaption(listing) {
  const lines = [];
  const tag = listing.balcon ? "🛋️ " : "";
  lines.push(`${tag}${listing.title}`);
  lines.push(formatMoney(listing.price) + " — " + listing.location);
  if (listing.rooms) lines.push(listing.rooms + (listing.balcon ? " · balcón" : ""));
  lines.push(listing.link);
  return lines.join("\n").slice(0, 1024);
}

async function sendTelegramPhoto(chatId, photoUrl, caption) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
  });
  return res.ok;
}

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram error ${res.status} (chat ${chatId}): ${body}`);
  }
}

const MAX_PHOTO_BYTES = 2_000_000;

async function isPhotoUsable(photoUrl) {
  try {
    const res = await fetch(photoUrl, { method: "HEAD" });
    const length = parseInt(res.headers.get("content-length") || "0", 10);
    return res.ok && length > 0 && length < MAX_PHOTO_BYTES;
  } catch {
    return false;
  }
}

async function sendListing(chatId, listing, photoOk) {
  const caption = formatCaption(listing);
  if (listing.image && photoOk) {
    const ok = await sendTelegramPhoto(chatId, listing.image, caption);
    if (ok) return;
  }
  await sendTelegramMessage(chatId, caption); // fallback sin foto (o sin foto usable)
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun && (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)) {
    throw new Error("Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID en el entorno.");
  }

  const sentIds = loadSentIds();
  const allMatches = [];

  for (const barrio of BARRIOS) {
    try {
      const listings = await fetchML(barrio);
      for (const listing of listings) {
        if (sentIds[listing.id]) continue;
        const evaluated = evaluateListing(listing);
        if (evaluated) allMatches.push(evaluated);
      }
    } catch (err) {
      console.error(`Error en ML ${barrio}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 500)); // ser educado con ML

    try {
      const listings = await fetchArgenprop(barrio);
      for (const listing of listings) {
        if (sentIds[listing.id]) continue;
        const evaluated = evaluateListing(listing);
        if (evaluated) allMatches.push(evaluated);
      }
    } catch (err) {
      console.error(`Error en Argenprop ${barrio}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 500)); // ser educado con Argenprop
  }

  const uniqueMatches = Array.from(new Map(allMatches.map((m) => [m.id, m])).values());
  uniqueMatches.sort((a, b) => a.price - b.price);

  if (uniqueMatches.length === 0) {
    console.log("Sin deptos nuevos que cumplan los criterios en esta corrida.");
    return;
  }

  if (dryRun) {
    console.log(`[DRY RUN] ${uniqueMatches.length} matches (no se envía ni se guarda estado):\n`);
    for (const m of uniqueMatches) console.log(formatCaption(m) + `\n[img: ${m.image}]\n---`);
    return;
  }

  const refreshedChatIds = await refreshChatIds();
  const chatIds = new Set(refreshedChatIds);
  if (TELEGRAM_CHAT_ID) chatIds.add(String(TELEGRAM_CHAT_ID));

  for (const m of uniqueMatches) {
    m.photoOk = m.image ? await isPhotoUsable(m.image) : false;
  }

  for (const chatId of chatIds) {
    await sendTelegramMessage(
      chatId,
      `🏠 ${uniqueMatches.length} depto(s) nuevo(s), amoblados, hasta ${formatMoney(PRICE_MAX)}:`
    );
    for (const m of uniqueMatches) {
      await sendListing(chatId, m, m.photoOk);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  for (const m of uniqueMatches) {
    sentIds[m.id] = new Date().toISOString();
  }
  saveSentIds(sentIds);
  console.log(`Enviados ${uniqueMatches.length} deptos nuevos a ${chatIds.size} destinatario(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
