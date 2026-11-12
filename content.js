/* global chrome */
(() => {
  "use strict";
  if (globalThis.__GLCSV_CONTENT_LOADED__) return;
  globalThis.__GLCSV_CONTENT_LOADED__ = true;

  const STATE_KEY = "glcsv_state";
  const PHONE_HINT = /(?:tel[eé]fono|telephone|telefone|phone|llamar|ligar|call|tel:)/i;
  const WEB_HINT = /(?:website|sitio\s*web|site\s*web|p[aá]gina\s*web|web\s*site|site\s*oficial|site|authority|produtos\s*e\s*servi[cç]os|sitio)/i;
  const BAD_DOMAINS = /(?:^|\.)(?:google\.[a-z.]+|googleusercontent\.com|gstatic\.com|youtube\.com|goo\.gl|maps\.app\.goo\.gl)$/i;
  const SELECTORS = {
    cards: '.VkpGBb, .Nv2PK, .THOPZb, div[role="article"], a.hfpxzc, .rllt__link, .dbg0pd',
    names: '.dbg0pd, .fontHeadlineSmall, [role="heading"], h3, a.hfpxzc, .qBF1Pd, .OSrXXb',
    titles: 'h1,h2,h3,[role="heading"],.DUwDvf,.qrShPb,.fontHeadlineLarge,.OSrXXb,.X7NTVe,span',
    phone: 'a[href^="tel:"], [data-item-id^="phone:tel:"], [aria-label*="teléfono" i], [aria-label*="telefone" i], [aria-label*="phone" i], [data-tooltip*="teléfono" i]'
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const plain = s => String(s ?? "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  const canonical = s => plain(s).toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const safeText = el => plain(el?.innerText || el?.textContent || "");
  const within = (n, low, high) => Math.max(low, Math.min(high, n));
  const rect = el => el?.getBoundingClientRect?.() || {left:0,right:0,width:0,height:0};
  let running = false;
  let stopped = false;
  let currentRun = null;
  let ui = null;
  let lastMessage = "";

  function sourceKey(url) {
    try {
      const u = new URL(url);
      const query=u.searchParams.get("q")||u.searchParams.get("query")||decodeURIComponent(u.pathname.match(/\/maps\/search\/([^/]+)/)?.[1]||"");
      return query?`${u.hostname}/maps/search?q=${encodeURIComponent(query)}`:`${u.hostname}${u.pathname}?udm=${u.searchParams.get("udm")||""}`;
    } catch { return url?.split("#")[0] || ""; }
  }
  function digitsPhone(text) {
    const raw = plain(text).replace(/^(?:tel[eé]fono|telefone|telephone|phone|tel\.?|llamar|call|ligar)\s*:?\s*/i, "").trim();
    if (!raw || raw.length > 45) return "";
    if (!/^[+0-9\s().\-–—\u00a0]+$/.test(raw)) return "";
    const num = raw.replace(/\D/g, "");
    if (num.length < 8 || num.length > 15) return "";
    return raw;
  }
  function findPhoneInText(text) {
    if (!text) return "";
    const lines = String(text).split(/[\n\r\t·•|;]+/);
    for (const line of lines) {
      const l = plain(line);
      if (!l || l.length > 130) continue;
      const direct = digitsPhone(l);
      if (direct) return direct;
      // Suelen aparecer después de una calle o categoría: "Av. ... 8200 - 0376 482-1453".
      const candidates = l.match(/\+?\d[\d\s().\-–]{6,}\d/g) || [];
      for (const candidate of candidates) {
        const val = digitsPhone(candidate);
        if (val) return val;
      }
    }
    return "";
  }
  function phoneFromNode(scope) {
    if (!scope) return "";
    const nodes = [...scope.querySelectorAll(SELECTORS.phone)];
    for (const el of nodes) {
      const href = el.getAttribute("href") || "";
      const id = el.getAttribute("data-item-id") || "";
      const attr = href.startsWith("tel:") ? href.slice(4).split(/[;?]/)[0] : id.startsWith("phone:tel:") ? id.slice(10) : "";
      const aria = el.getAttribute("aria-label") || "";
      for (const value of [attr, safeText(el), aria.replace(/[^+\d\s().\-–]/g," ")]) {
        const got = digitsPhone(value) || findPhoneInText(value);
        if (got) return got;
      }
    }
    // Leaf nodes first, rather than unrelated dates, ratings or addresses.
    const leaves = scope.querySelectorAll("span,div,a,button");
    for (const el of leaves) {
      if (el.children.length || el.closest("#glcsv-float")) continue;
      const text = safeText(el);
      if (text.length > 50) continue;
      const got = digitsPhone(text);
      if (got) return got;
    }
    return findPhoneInText(scope.innerText || "");
  }
  const utils = globalThis.GLCSVUtil;
  const hasRealWebsite = value => Boolean(String(value||"").trim()) && !utils?.isSocialWebsite(value);
  function whatsapp(raw, country = "auto", place = "", searchUrl = "") {
    return utils?.whatsapp(raw, country, place, searchUrl) || "";
  }
  function findAddress(scope) {
    if (!scope) return "";
    const targets = scope.querySelectorAll(
      '[data-item-id="address"], [data-item-id^="address:"], [aria-label^="Dirección:" i], ' +
      '[aria-label^="Address:" i], [aria-label^="Endereço:" i], ' +
      '[data-tooltip*="dirección" i], [data-tooltip*="address" i]'
    );
    for (const el of targets) {
      // En Maps, el aria-label del botón puede ser "Copiar dirección", por eso
      // priorizamos el texto visible de la ficha.
      for (const val of [safeText(el), el.getAttribute("aria-label")]) {
        const value=utils.cleanAddress(val);
        if (value && utils.locality(value)) return value;
      }
    }
    // Alternativa para diseños de Maps/Locales sin data-item-id.
    for (const el of [...scope.querySelectorAll('.Io6YTe, .W4Efsd, .fontBodyMedium')].slice(0,90)) {
      const value=utils.cleanAddress(safeText(el));
      if (value && utils.locality(value)) return value;
    }
    for (const line of String(scope.innerText||"").split(/[\n\r]+/).slice(0,45)) {
      const value=utils.cleanAddress(line);
      if (value && utils.locality(value)) return value;
    }
    return "";
  }
  function findRating(scope) {
    if (!scope) return "";
    const preferred = [...scope.querySelectorAll('[aria-label*="estrella" i],[aria-label*="star" i],[aria-label*="avalia" i], .MW4etd, .btQScd, .fontDisplayLarge, span')].slice(0,150);
    for (const el of preferred) {
      if (el.closest("#glcsv-float")) continue;
      const txt = [el.getAttribute("aria-label"), safeText(el)].filter(Boolean).join(" ");
      const star = txt.match(/([1-5][.,]\d)\s*(?:\/\s*5|star|estrella|estrel|★|⭐)/i);
      const base = star || ((/^[1-5][.,]\d$/.test(safeText(el))) ? [null, safeText(el)] : null);
      if (base) return base[1].replace(",", ".");
    }
    const m = (scope.innerText || "").match(/(?:^|\s)([1-5][.,]\d)(?=\s*(?:⭐|★|\(|avalia|reseña|opiniones|reviews|\s*·))/i);
    return m ? m[1].replace(",", ".") : "";
  }
  // Categoría publicada por Google en la ficha. No se deduce del término buscado:
  // una búsqueda de "joyerías" también puede devolver relojerías, casas de empeño, etc.
  function cleanCategory(raw) {
    let s = plain(raw).replace(/^(?:categor[ií]a|category|categoria)\s*:\s*/i, "");
    s = s.replace(/^[·•|\-–—]\s*/, "").split(/\s+[·•|]\s+/)[0].trim();
    s = s.replace(/\s*\(\d[\d.,]*\s*(?:reseñas|opiniones|reviews|avaliações|evaluaciones)\)\s*$/i, "").trim();
    if (s.length < 3 || s.length > 72 || /\d{3}/.test(s)) return "";
    if (!/[a-záéíóúñüãõç]/i.test(s)) return "";
    if (/^(?:abiert[oa]s?|cerrad[oa]s?|open(?: now)?|closed|abre|cierra|fecha|abre às|fechado|aberto|horario|hours?|tel[eé]fono|phone|llamar|call|direcci[oó]n|address|ruta|cómo llegar|sitio web|website|guardar|share|compartir|reseñas|opiniones|reviews|avaliar|fotos|photos|productos y servicios|produtos e servi[cç]os|servicios|ver m[aá]s|more|entrega|delivery|recogida|pickup)\b/i.test(s)) return "";
    if (/^(?:av\.?|avenida|calle|rua|r\.|blvd|boulevard|san|ruta|street|road)\b/i.test(s)) return "";
    if (/^[\d.,\s★⭐()\-+]+$/.test(s) || /\b(?:https?:\/\/|www\.)/i.test(s)) return "";
    return s;
  }
  function findCategory(scope, isDetail = false) {
    if (!scope) return "";

    // En Maps, .DkEaL muestra la categoría principal debajo del nombre.
    // Google Local puede usar otro idioma o una categoría junto al rating.
    const categoryNodes = scope.querySelectorAll(
      '.DkEaL, [data-item-id="category"], [data-item-id^="category:"], ' +
      '[aria-label^="Categoría:" i], [aria-label^="Category:" i], ' +
      '[aria-label^="Categoria:" i], button[jsaction*="category"], ' +
      'button[jsaction*="pane.rating.category"]'
    );
    for (const node of categoryNodes) {
      const raw = node.getAttribute("aria-label") || safeText(node);
      const result = cleanCategory(raw);
      if (result) return result;
    }

    // Los bloques de texto que incluyen "4,9 ★★★★★ (228) · Joyería" son
    // una forma habitual de mostrar la categoría en la lista de Locales.
    const containers = [
      ...scope.querySelectorAll('.rllt__details, .W4Efsd, .fontBodyMedium, .YhemCb, .lcr4fd, .X7NTVe'),
      scope
    ];
    for (const container of containers.slice(0, 90)) {
      const text = (container.innerText || container.textContent || "").slice(0, isDetail ? 950 : 450);
      for (const line of text.split(/[\n\r]+/).slice(0, 18)) {
        // La categoría debe figurar después de las estrellas/valoraciones,
        // no detrás de un fragmento aleatorio del negocio.
        if (!/(?:[1-5][.,]\d|★|⭐|\(\s*\d+\s*\)|\b\d+\s*(?:reseñas|opiniones|reviews|avaliações)\b)/i.test(line)) continue;
        const chunks = line.split(/[·•]/);
        for (let i = 1; i < chunks.length; i++) {
          const result = cleanCategory(chunks[i]);
          if (result) return result;
        }
      }
    }

    // En algunas versiones de Maps aparece solo la categoría en una línea,
    // inmediatamente debajo del bloque de estrellas. Priorizar ese contexto.
    for (const container of containers.slice(0, 35)) {
      const lines = String(container.innerText || "").split(/[\n\r]+/).map(plain).filter(Boolean);
      for (let i = 1; i < Math.min(lines.length, 9); i++) {
        const previous = lines[i - 1];
        if (!/(?:[1-5][.,]\d|★|⭐|\(\d+\))/i.test(previous)) continue;
        const result = cleanCategory(lines[i]);
        if (result && !/\d/.test(result)) return result;
      }
    }
    return "";
  }

  function unwrapUrl(href) {
    if (!href) return "";
    try {
      const u = new URL(href, location.href);
      if (BAD_DOMAINS.test(u.hostname) && u.pathname === "/url") {
        const target = u.searchParams.get("q") || u.searchParams.get("url");
        if (target) return unwrapUrl(target);
      }
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
    } catch { return ""; }
  }
  function externalWebsite(scope) {
    if (!scope) return "";
    let best = { score: -1, url: "" };
    for (const a of scope.querySelectorAll('a[href], [role="link"][data-url]')) {
      const url = unwrapUrl(a.getAttribute("href") || a.getAttribute("data-url"));
      if (!url) continue;
      const domain = new URL(url).hostname;
      if (BAD_DOMAINS.test(domain)) continue;
      if (/^(?:web\.whatsapp\.com|wa\.me|api\.whatsapp\.com)$/i.test(domain)) continue;
      const label = [safeText(a), a.getAttribute("aria-label"), a.getAttribute("data-item-id"), a.title].join(" ");
      const isSocial = /(?:^|\.)(facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|linkedin\.com)$/i.test(domain);
      const websiteHint = WEB_HINT.test(label);
      const textDomain = /(?:[\w-]+\.)+(?:com|ar|br|org|net|io|co)(?:\.[a-z]{2})?/i.test(label);
      const isAd = /\b(ad|ads|patrocinado|publicidad|sponsor)\b/i.test(label);
      const score = (websiteHint ? 12 : 0) + (textDomain ? 8 : 0) + (isSocial ? -15 : 0) + (isAd ? -8 : 0) + (label.length > 200 ? -5 : 0);
      if (score > best.score && (score >= 8 || (!isSocial && !best.url))) best = {score,url};
    }
    return best.score >= 3 ? best.url : "";
  }
  function businessUrl(root) {
    if (!root) return "";
    const selector='a.hfpxzc, a[href*="/maps/place/"], a[href*="cid="]';
    const link=root.matches(selector)?root:root.querySelector(selector);
    return unwrapUrl(link?.getAttribute("href") || "");
  }
  function getCardName(root) {
    for (const node of root.querySelectorAll(SELECTORS.names)) {
      const val = plain(node.getAttribute("aria-label") || safeText(node));
      if (val && val.length <= 110 && !/^(?:resultados|results|sitios web|website|reseñas|reviews|mostrar m[aá]s|open|aberto)/i.test(val)) return val;
    }
    if (root.matches("a.hfpxzc")) return plain(root.getAttribute("aria-label"));
    return "";
  }
  function cardKey(root, name) {
    const dataId = root.getAttribute("data-cid") || root.querySelector('[data-cid]')?.getAttribute("data-cid") || "";
    if (dataId) return utils.placeIdentity(`data:${dataId}`) || `data:${canonical(dataId)}`;
    const link = root.querySelector('a.hfpxzc, a[href*="/maps/place/"],a[href*="cid="]');
    const raw = link?.getAttribute("href") || "";
    const place = utils.placeIdentity(unwrapUrl(raw));
    if (place) return place;
    const address=findAddress(root), phone=phoneFromNode(root);
    const identity=utils.businessIdentity({name,address,phone});
    if (address||phone) return identity;
    const snippet = safeText(root).slice(0,130);
    return `name:${canonical(name)}|${canonical(snippet)}`;
  }
  function selectCards() {
    const roots = new Set();
    for (const node of document.querySelectorAll(SELECTORS.cards)) {
      if (node.closest("#glcsv-float")) continue;
      let root = node.matches("a.hfpxzc") ? (node.closest('.Nv2PK, [role="article"]') || node.parentElement) : node;
      if (node.matches(".dbg0pd")) root = node.closest('.VkpGBb, .rllt__link, [role="article"]') || node.parentElement?.parentElement || node.parentElement;
      if (!root) continue;
      if (root.matches(".rllt__link")) root = root.closest(".VkpGBb") || root;
      const r = rect(root);
      // Evitar reseñas, menús y fichas del panel derecho.
      if (r.width < 95 || r.height < 28 || r.left > innerWidth * .64 || r.right < 0) continue;
      roots.add(root);
    }
    const out = [];
    const seen = new Set();
    for (const root of roots) {
      const name = getCardName(root);
      if (!name) continue;
      const key = cardKey(root,name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({name, key, element:root, phone:phoneFromNode(root), rating:findRating(root), website:externalWebsite(root), businessUrl:businessUrl(root), category:findCategory(root), address:findAddress(root)});
    }
    return out;
  }
  function closestPanelForTitle(title) {
    let best = {score:-999, element:null};
    let p = title.parentElement;
    for (let d=0; p && d<13 && p!==document.body; d++,p=p.parentElement) {
      const r = rect(p);
      if (r.width <= 150 || r.width >= innerWidth*.86 || r.right <= innerWidth*.5) continue;
      const text = p.innerText || "";
      if (text.length > 15000) continue;
      const hasPhone = !!p.querySelector('a[href^="tel:"],[data-item-id^="phone:tel:"]');
      const hasWebsite = !!p.querySelector('a[data-item-id*="authority"]');
      const isTall = r.height >= 200;
      const score = (hasPhone?22:0) + (hasWebsite?12:0) + (isTall?8:0) + (text.length>100?6:0) + (r.height>350?4:0) - (r.width>900?40:0);
      if (score >= best.score) best={score,element:p};
    }
    return best.element;
  }
  function findBusinessPanel(name) {
    const target = canonical(name);
    let candidates = [];
    for (const node of document.querySelectorAll(SELECTORS.titles)) {
      const r = rect(node);
      if (r.right < innerWidth*.53 || r.width === 0) continue;
      const txt = canonical(node.getAttribute("aria-label") || safeText(node));
      if (txt !== target) continue;
      if (node.children.length && node.tagName !== "H1" && node.tagName !== "H2" && node.tagName !== "H3") continue;
      candidates.push(node);
      if (candidates.length >= 12) break;
    }
    // Algunos diseños del panel de Google Local muestran el título en un DIV común.
    if (!candidates.length) {
      for (const el of document.querySelectorAll("div")) {
        if (el.children.length || (el.textContent || "").length > 115) continue;
        const r = rect(el);
        if (r.right < innerWidth*.53 || !r.width) continue;
        if (canonical(safeText(el)) === target) { candidates.push(el); if (candidates.length >= 12) break; }
      }
    }
    if (!candidates.length) return null;
    for (const el of candidates) {
      const panel = closestPanelForTitle(el);
      if (panel) return panel;
    }
    return null;
  }
  async function waitForPanel(name, timeout=4400) {
    const begin = Date.now();
    let panel = null;
    while (!stopped && Date.now()-begin < timeout) {
      panel = findBusinessPanel(name);
      // Panel puede existir mientras todavía cambia el teléfono/web.
      if (panel && (phoneFromNode(panel) || externalWebsite(panel))) {
        await wait(280);
        return findBusinessPanel(name) || panel;
      }
      await wait(190);
    }
    return panel;
  }
  async function extractPlaceDetails(baseRow) {
    const started=Date.now();
    let title=null;
    while(Date.now()-started<9000) {
      title=document.querySelector('h1.DUwDvf, h1[role="heading"], h1');
      if(title&&safeText(title))break;
      await wait(180);
    }
    // The worker visits a public Maps place URL in its own inactive tab. Read
    // the rendered page DOM; do not call undocumented Maps endpoints.
    await wait(260);
    let scope=null, bestScore=-1;
    for(let node=title,d=0;node&&node!==document.body&&d<14;node=node.parentElement,d++) {
      const textLength=(node.innerText||"").length;
      if(textLength>16000)continue;
      const hasPhone=!!node.querySelector(SELECTORS.phone);
      const hasAddress=!!node.querySelector('[data-item-id^="address"],[aria-label^="Dirección:" i],[aria-label^="Address:" i]');
      const hasWebsite=!!node.querySelector('[data-item-id*="authority"],a[aria-label*="sitio web" i],a[aria-label*="website" i]');
      const score=(hasPhone?28:0)+(hasAddress?16:0)+(hasWebsite?8:0)+(textLength>80?4:0)+(node===title.parentElement?3:0);
      if(score>bestScore){bestScore=score;scope=node;}
      if(hasPhone&&hasAddress&&hasWebsite&&textLength>80)break;
    }
    // Do not inspect the whole page when no business panel can be isolated:
    // nearby businesses may otherwise contribute the wrong phone or website.
    if(!scope||bestScore<8)return {...baseRow,businessUrl:baseRow.businessUrl||location.href};
    const address=findAddress(scope);
    const phone=phoneFromNode(scope);
    const website=externalWebsite(scope);
    const rating=findRating(scope);
    const category=findCategory(scope,true);
    return {
      ...baseRow,
      phone:phone||baseRow.phone||"",
      address:address||baseRow.address||"",
      location:utils.locality(address||baseRow.address||"")||baseRow.location||"",
      website:website||baseRow.website||"",
      rating:rating||baseRow.rating||"",
      category:category||baseRow.category||"",
      businessUrl:baseRow.businessUrl||location.href
    };
  }
  function clickCard(card,{requireMapsPlace=false}={}) {
    const root = card.element;
    if (!root?.isConnected) return false;
    try {
      const placeLink=[...root.querySelectorAll('a.hfpxzc,a[href*="/maps/place/"]')].find(anchor=>{
        try {
          const url=new URL(unwrapUrl(anchor.getAttribute("href")||""));
          return /(^|\.)google\.[a-z.]+$/i.test(url.hostname)&&url.pathname.startsWith("/maps/place/");
        } catch {return false;}
      });
      if(requireMapsPlace&&!placeLink)return false;
      let target = placeLink || root.querySelector(".dbg0pd, .fontHeadlineSmall, .qBF1Pd") || (!requireMapsPlace?root:null);
      if(!target)return false;
      if (target.closest("#glcsv-float")) return false;
      target.scrollIntoView({behavior:"instant",block:"nearest",inline:"nearest"});
      target.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,cancelable:true,view:window}));
      target.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,view:window}));
      target.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true,view:window}));
      target.click();
      return true;
    } catch { return false; }
  }
  function drawOverlay() {
    if (ui?.root?.isConnected) return;
    const root=document.createElement("div");
    root.id="glcsv-float";
    Object.assign(root.style, { position:"fixed", bottom:"17px", right:"17px", width:"258px", zIndex:"2147483647", color:"white", background:"#153c33", boxShadow:"0 10px 30px #0004", border:"1px solid #278665", borderRadius:"12px", padding:"12px", font:"12px/1.4 Arial,sans-serif" });
    const title=document.createElement("div"); title.textContent="Google Local → CSV"; title.style.cssText="font-weight:bold;margin-bottom:7px;font-size:13px";
    const info=document.createElement("div"); info.style.cssText="word-break:break-word;margin-bottom:10px";
    const stop=document.createElement("button"); stop.textContent="Detener"; stop.type="button";
    stop.style.cssText="border:0;border-radius:7px;background:#effff8;color:#175b43;padding:7px 12px;font-weight:bold;cursor:pointer";
    stop.addEventListener("click",event=> {event.preventDefault();event.stopPropagation();stopped=true;stop.disabled=true;stop.textContent="Deteniendo...";});
    root.append(title,info,stop); document.documentElement.appendChild(root);
    ui={root,info,stop};
  }
  function showOverlay(text) { drawOverlay(); ui.info.textContent=text; }
  function hideOverlay() {ui?.root?.remove();ui=null;}
  async function writeState(value) { await chrome.storage.local.set({[STATE_KEY]:value}); }
  function rowFromCard(card, country, searchUrl) {
    const address=card.address || "";
    const location=utils.locality(address);
    return {id:card.key, name:card.name, phone:card.phone || "", rating:card.rating || "",
      category:card.category || "", website:card.website || "", businessUrl:card.businessUrl || "", address, location,
      whatsappLink:whatsapp(card.phone || "", country, address, searchUrl)};
  }
  function combineRow(oldRow, latest, country, searchUrl) {
    const merged=utils.mergeBusinessRows(oldRow,latest);
    // Priorizar la dirección del panel completo frente al snippet de la lista.
    if (latest.address && (!merged.address || latest.address.length>merged.address.length))
      merged.address=latest.address;
    merged.location=utils.locality(merged.address || "") || latest.location || merged.location || "";
    merged.whatsappLink=whatsapp(merged.phone, country, merged.address || merged.location, searchUrl);
    return merged;
  }
  function findDuplicateRow(rows,candidate) {
    if(candidate.id&&rows.has(candidate.id))return candidate.id;
    for(const [key,row] of rows)if(utils.sameBusiness(row,candidate))return key;
    return "";
  }
  function storeUniqueRow(rows,candidate,country,searchUrl) {
    const oldKey=findDuplicateRow(rows,candidate);
    if(!oldKey) {
      const key=utils.businessIdentity(candidate)||candidate.id;
      rows.set(key,{...candidate,id:key});
      return {key,duplicate:false};
    }
    const old=rows.get(oldKey);
    const merged=combineRow(old,candidate,country,searchUrl);
    const key=utils.businessIdentity(merged)||oldKey;
    if(key!==oldKey)rows.delete(oldKey);
    rows.set(key,{...merged,id:key});
    return {key,duplicate:true};
  }
  function getScrollTarget(cards) {
    const first=cards.find(card=>card.element?.isConnected)?.element||null;
    const isScrollable=el=>{
      if(!el||el===document.body||el===document.documentElement||el.clientHeight<150||el.scrollHeight<=el.clientHeight+80)return false;
      const style=getComputedStyle(el);
      const known=el.matches('div[role="feed"],.m6QErb,[data-results-container]');
      return (/(auto|scroll|overlay|hidden)/.test(style.overflowY)||known)&&rect(el).width>170&&rect(el).width<innerWidth*.82;
    };
    const feed=document.querySelector('div[role="feed"]');
    if(isScrollable(feed))return feed;
    let current=first;
    for(let depth=0;current&&current!==document.body&&depth<14;depth++,current=current.parentElement) {
      if(isScrollable(current))return current;
    }
    const candidates=[...document.querySelectorAll('div[role="feed"],.m6QErb,[data-results-container],div,section,main')]
      .filter(el=>isScrollable(el)&&(!first||el.contains(first)))
      .sort((a,b)=>{
        const score=el=>(el.matches('div[role="feed"]')?100:0)+(el.matches('.m6QErb,[data-results-container]')?50:0)+Math.min(rect(el).height,700)/100;
        return score(b)-score(a);
      });
    return candidates[0]||null;
  }
  async function advanceResults(cards) {
    const scroller=getScrollTarget(cards);
    const beforeCount=selectCards().length;
    if (scroller) {
      const old=scroller.scrollTop;
      const maxTop=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
      const step=Math.max(520,Math.floor(scroller.clientHeight*.82));
      scroller.scrollTop=Math.min(maxTop,old+step);
      scroller.dispatchEvent(new Event("scroll",{bubbles:true}));
      if(scroller.scrollTop===old) cards.at(-1)?.element?.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,view:window,deltaY:step}));
      const outcome=await waitForResultsOutcome(beforeCount,2500);
      const afterCount=selectCards().length;
      const after=scroller.scrollTop;
      return {moved:after!==old||afterCount>beforeCount,method:"container",target:`${scroller.tagName.toLowerCase()}${scroller.id?`#${scroller.id}`:""}${typeof scroller.className==="string"&&scroller.className?`.${scroller.className.trim().split(/\s+/).slice(0,3).join(".")}`:""}`,topBefore:old,topAfter:after,maxTop,clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,cardsBefore:beforeCount,cardsAfter:afterCount,...outcome};
    }
    const old=window.scrollY;
    const step=Math.max(520,window.innerHeight*.78);
    cards.at(-1)?.element?.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,view:window,deltaY:step}));
    window.scrollBy({top:step,behavior:"instant"});
    const outcome=await waitForResultsOutcome(beforeCount,2500);
    const afterCount=selectCards().length;
    return {moved:window.scrollY!==old||afterCount>beforeCount,method:"window-fallback",topBefore:old,topAfter:window.scrollY,cardsBefore:beforeCount,cardsAfter:afterCount,...outcome};
  }
  async function scrollUntilNewResults(inspected,maxSteps=20) {
    for(let step=1;step<=maxSteps&&!stopped;step++) {
      let fresh=selectCards().filter(card=>!inspected.has(card.key));
      if(hasNoMoreResults())return {endReached:fresh.length===0,newResults:fresh.length>0,newCount:fresh.length,scrollSteps:step-1};
      if(fresh.length)return {endReached:false,newResults:true,newCount:fresh.length,scrollSteps:step-1};
      const cards=selectCards();
      const outcome=await advanceResults(cards);
      fresh=selectCards().filter(card=>!inspected.has(card.key));
      if(outcome.endReached||hasNoMoreResults())return {endReached:fresh.length===0,newResults:fresh.length>0,newCount:fresh.length,scrollSteps:step,...outcome};
      if(fresh.length)return {endReached:false,newResults:true,newCount:fresh.length,scrollSteps:step,...outcome};
    }
    const fresh=selectCards().filter(card=>!inspected.has(card.key));
    return {endReached:hasNoMoreResults()&&!fresh.length,newResults:fresh.length>0,newCount:fresh.length,scrollSteps:maxSteps,loading:resultsSpinnerVisible()};
  }
  async function waitForStalledFeed(inspected,timeout=10000) {
    const started=Date.now(),spinnerAtStart=resultsSpinnerVisible();
    while(!stopped&&Date.now()-started<timeout) {
      const fresh=selectCards().filter(card=>!inspected.has(card.key));
      if(fresh.length)return {newResults:true,endReached:false,spinnerAtStart,spinnerVisible:resultsSpinnerVisible(),waitedMs:Date.now()-started,newCount:fresh.length};
      if(hasNoMoreResults())return {newResults:false,endReached:true,spinnerAtStart,spinnerVisible:false,waitedMs:Date.now()-started,newCount:0};
      const spinner=resultsSpinnerVisible();
      if(spinnerAtStart&&!spinner)return {newResults:false,endReached:false,spinnerAtStart,spinnerVisible:false,spinnerCleared:true,waitedMs:Date.now()-started,newCount:0};
      await wait(250);
    }
    const fresh=selectCards().filter(card=>!inspected.has(card.key));
    return {newResults:fresh.length>0,endReached:hasNoMoreResults()&&!fresh.length,spinnerAtStart,spinnerVisible:resultsSpinnerVisible(),waitedMs:Date.now()-started,newCount:fresh.length,timeout:!stopped};
  }
  async function restorePreviouslyLoadedResults(targetCount,maxSteps=80) {
    let steps=0,lastCount=selectCards().length;
    while(steps<maxSteps&&!stopped) {
      const cards=selectCards();
      if(cards.length>=targetCount)return {restored:true,steps,cards:cards.length,targetCount};
      if(hasNoMoreResults())return {restored:false,endReached:true,steps,cards:cards.length,targetCount};
      await advanceResults(cards);
      steps++;
      const currentCount=selectCards().length;
      if(currentCount>lastCount)lastCount=currentCount;
    }
    const cards=selectCards();
    return {restored:cards.length>=targetCount,endReached:hasNoMoreResults(),steps,cards:cards.length,targetCount,lastCount};
  }
  function hasNoMoreResults() {
    const endings=new Set(["no hay mas resultados","no more results"]);
    const scope=document.querySelector('div[role="feed"]')||document.querySelector('[data-results-container]')||getScrollTarget(selectCards())||document.body;
    const containsEndMarker=text=>String(text||"").split(/[\n\r]+/).some(line=>endings.has(canonical(line).replace(/[.!?…]+$/g,"").trim()));
    if(containsEndMarker(scope?.innerText))return true;
    return scope!==document.body&&containsEndMarker(document.body?.innerText);
  }
  function resultsSpinnerVisible() {
    const scope=document.querySelector('div[role="feed"]')||getScrollTarget(selectCards())||document.body;
    const selectors='[role="progressbar"],[aria-busy="true"],[aria-label*="cargando" i],[aria-label*="loading" i],[aria-label*="carregando" i]';
    for(const el of scope.querySelectorAll(selectors)) {
      if(el.closest("#glcsv-float"))continue;
      const r=rect(el), style=getComputedStyle(el);
      if(r.width>0&&r.height>0&&style.visibility!=="hidden"&&style.display!=="none")return true;
    }
    return false;
  }
  async function waitForResultsOutcome(previousCount,timeout=10000) {
    const started=Date.now();
    let stableSince=Date.now();
    while(Date.now()-started<timeout) {
      if(hasNoMoreResults())return {endReached:true,loading:false};
      if(selectCards().length>previousCount)return {endReached:false,loading:resultsSpinnerVisible()};
      if(resultsSpinnerVisible())stableSince=Date.now();
      else if(Date.now()-stableSince>=1100)return {endReached:false,loading:false};
      await wait(250);
    }
    return {endReached:hasNoMoreResults(),loading:resultsSpinnerVisible()};
  }
  function cardDetailHeadingVisible(name) {
    const target=canonical(name);
    return [...document.querySelectorAll('h1,h2,[role="heading"],.DUwDvf')]
      .some(el=>rect(el).width>0&&canonical(safeText(el))===target);
  }
  function captureResultsPosition() {
    const scroller=getScrollTarget(selectCards());
    return {top:scroller?scroller.scrollTop:window.scrollY,scroller:Boolean(scroller)};
  }
  function mapsSearchInput() {
    return [...document.querySelectorAll('input#searchboxinput,input[role="combobox"]')]
      .find(input=>rect(input).width>0&&rect(input).height>0)||null;
  }
  function mapsSearchValue() {return plain(mapsSearchInput()?.value||"");}
  async function submitMapsSearch(query,timeout=16000) {
    if(!/\/maps(?:\/|$)/i.test(location.pathname))return {ok:false,reason:"not-on-maps",url:location.href};
    const input=mapsSearchInput(),desired=plain(query);
    if(!input||!desired)return {ok:false,reason:input?"empty-query":"search-box-not-found",actual:mapsSearchValue()};
    const before=mapsSearchValue();
    try {
      input.focus();
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
      if(setter)setter.call(input,desired);else input.value=desired;
      input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:desired}));
      input.dispatchEvent(new Event("change",{bubbles:true}));
      input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true}));
      input.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true}));
    } catch(error) {return {ok:false,reason:String(error?.message||error),before,actual:mapsSearchValue()};}
    const started=Date.now();
    while(Date.now()-started<timeout&&!stopped) {
      const cards=selectCards();
      const routeMatches=canonical(utils.fromSearch(location.href))===canonical(desired);
      if(routeMatches&&(cards.length||hasNoMoreResults()))return {ok:true,before,actual:mapsSearchValue(),cards:cards.length,endReached:hasNoMoreResults(),routeMatches,url:location.href};
      await wait(250);
    }
    return {ok:false,before,actual:mapsSearchValue(),cards:selectCards().length,endReached:hasNoMoreResults(),routeMatches:canonical(utils.fromSearch(location.href))===canonical(desired),url:location.href};
  }
  function restoreResultsPosition(position) {
    const cards=selectCards(),scroller=getScrollTarget(cards);
    if(scroller) {
      const top=Math.min(Number(position?.top)||0,Math.max(0,scroller.scrollHeight-scroller.clientHeight));
      scroller.scrollTop=top;
      scroller.dispatchEvent(new Event("scroll",{bubbles:true}));
      return {restored:true,top:scroller.scrollTop,method:"container"};
    }
    window.scrollTo({top:Number(position?.top)||0,behavior:"instant"});
    return {restored:Boolean(cards.length),top:window.scrollY,method:"window"};
  }
  function clickMapsBackControl() {
    const candidates=[...document.querySelectorAll('button,[role="button"]')].filter(el=>{
      if(el.closest("#glcsv-float"))return false;
      const r=rect(el),label=canonical(`${el.getAttribute("aria-label")||""} ${el.getAttribute("title")||""}`);
      return r.width>0&&r.height>0&&r.top<180&&r.left<innerWidth*.62&&/(back|volver|atras|cerrar|close)/.test(label);
    }).sort((a,b)=>{
      const rank=el=>/(back|volver|atras)/.test(canonical(`${el.getAttribute("aria-label")||""} ${el.getAttribute("title")||""}`))?0:1;
      return rank(a)-rank(b)||rect(a).top-rect(b).top;
    });
    if(!candidates.length)return false;
    candidates[0].click();
    return true;
  }
  async function restoreSearchAfterRecovery(previousUrl,position,expectedQuery) {
    const started=Date.now();
    let backControlClicked=false;
    if(/\/maps\/place\//i.test(location.pathname))history.back();
    while(Date.now()-started<9000&&!stopped) {
      if(!/\/maps\/place\//i.test(location.pathname)&&selectCards().length) {
        const actualQuery=mapsSearchValue();
        if(expectedQuery&&canonical(actualQuery)!==canonical(expectedQuery)) {
          const searchResult=await submitMapsSearch(expectedQuery);
          if(!searchResult.ok)return {ok:false,url:location.href,queryMismatch:true,actualQuery,expectedQuery,searchResult};
          if(searchResult.endReached||selectCards().length)return {ok:true,queryRestored:true,searchResult,position:{restored:false,reason:"new-search"},positionAfterRender:{restored:false,reason:"new-search"},url:location.href,searchMatchesOriginal:true};
        }
        // Maps can return to its list at scrollTop=0 after history.back().
        // Restore the pre-click position before searching farther down.
        const first=restoreResultsPosition(position);
        await wait(260);
        const second=restoreResultsPosition(position);
        return {ok:true,position:first,positionAfterRender:second,url:location.href,searchMatchesOriginal:sourceKey(location.href)===sourceKey(previousUrl)};
      }
      if(!backControlClicked&&Date.now()-started>3500&&/\/maps\/place\//i.test(location.pathname))backControlClicked=clickMapsBackControl();
      await wait(180);
    }
    return {ok:false,url:location.href};
  }
  async function recoverStalledResults(recoveryTried,inspected,expectedQuery) {
    const initiallyFresh=selectCards().filter(card=>!inspected.has(card.key));
    if(hasNoMoreResults())return {recovered:false,endReached:initiallyFresh.length===0,newResults:initiallyFresh.length>0,attempted:recoveryTried.size};
    const candidates=selectCards().filter(card=>inspected.has(card.key)&&card.businessUrl).reverse();
    const attemptedNames=[];
    for(const card of candidates) {
      if(attemptedNames.length>=12)break;
      if(stopped)return {recovered:false,stopped:true,attemptedNames};
      if(recoveryTried.has(card.key)||!card.element?.isConnected)continue;
      recoveryTried.add(card.key);
      attemptedNames.push(card.name);
      const previousUrl=location.href;
      const previousPosition=captureResultsPosition();
      if(!clickCard(card,{requireMapsPlace:true}))continue;
      const started=Date.now();
      let opened=false,openedBy="";
      while(Date.now()-started<2600&&!stopped) {
        if(hasNoMoreResults()) {
          const fresh=selectCards().filter(item=>!inspected.has(item.key));
          return {recovered:false,endReached:fresh.length===0,newResults:fresh.length>0,card:card.name,attemptedNames};
        }
        const routeOpened=location.href!==previousUrl&&/\/maps\/place\//i.test(location.pathname);
        if(routeOpened){opened=true;openedBy="place-url";break;}
        if(findBusinessPanel(card.name)||cardDetailHeadingVisible(card.name)){opened=true;openedBy="business-title";break;}
        await wait(160);
      }
      if(!opened)continue;
      const restored=await restoreSearchAfterRecovery(previousUrl,previousPosition,expectedQuery);
      if(restored.ok)return {recovered:true,card:card.name,openedBy,attempted:recoveryTried.size,attemptedNames,positionBefore:previousPosition,positionAfter:restored.positionAfterRender,urlAfter:restored.url,searchMatchesOriginal:restored.searchMatchesOriginal,queryRestored:Boolean(restored.queryRestored)};
      return {recovered:false,card:card.name,openedBy,restoreFailed:true,attempted:recoveryTried.size,attemptedNames,positionBefore:previousPosition,urlAfter:restored.url,queryMismatch:restored.queryMismatch,expectedQuery,actualQuery:restored.actualQuery};
    }
    return {recovered:false,attempted:recoveryTried.size,attemptedNames};
  }
  const MAX_LOG_ENTRIES=200;
  const MAX_NO_PROGRESS=8;
  function logEvent(state,level,event,details={}) {
    const logs=Array.isArray(state.logs)?state.logs:[];
    logs.push({time:new Date().toISOString(),level,event,details});
    state.logs=logs.slice(-MAX_LOG_ENTRIES);
  }
  async function scan({limit,searchUrl,tabId,country,campaignId,campaignQuery,detailConcurrency=5}) {
    let existing=(await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
    const key=sourceKey(searchUrl);
    const canResume=existing.searchKey===key && Array.isArray(existing.rows);
    const sameCampaign=Boolean(campaignId&&existing.campaignId===campaignId&&Array.isArray(existing.rows));
    const sameCampaignQuery=sameCampaign&&existing.campaignQuery===campaignQuery;
    let campaignStage=campaignId?(sameCampaignQuery&&existing.campaignStage==="enriching"?"enriching":"collecting"):"streaming";
    const saved=campaignId?(sameCampaign?existing.rows:[]):(canResume?existing.rows:[]);
    const rows=new Map();
    for(const row of utils.dedupeRows(saved))storeUniqueRow(rows,row,country,searchUrl);
    // Datos previos a 1.2 no guardaban ubicación: revisar una vez sus fichas.
    const inspected=new Set((campaignId?sameCampaignQuery:canResume) && Number(existing.schemaVersion)>=2 ?
      (existing.inspectedIds || saved.map(row=>row.id)).filter(Boolean) : []);
    const previousQueryRows=sameCampaignQuery&&Array.isArray(existing.queryRows)?existing.queryRows:
      (!campaignId&&canResume?(Array.isArray(existing.queryRows)?existing.queryRows:saved):[]);
    const queryRows=utils.dedupeRows(previousQueryRows);
    let queryProcessed=queryRows.length;
    const keepPending=campaignId?sameCampaign:canResume;
    const pendingDetails=new Map();
    if(keepPending&&Array.isArray(existing.pendingDetails))for(const row of existing.pendingDetails)
      if(row?.businessUrl)pendingDetails.set(row.businessUrl,row);
    const detailQueue=[];
    const activeDetailTasks=new Set();
    const DETAIL_CONCURRENCY=within(Math.round(Number(detailConcurrency)||5),1,20), MAX_DETAIL_BACKLOG=Math.max(15,DETAIL_CONCURRENCY*3);
    let activeDetails=0, stopDetailQueue=false, writesSinceCheckpoint=0, lastCheckpoint=Date.now();
    let persistChain=Promise.resolve();
    const state={rows:[...rows.values()], queryRows, inspectedIds:[...inspected], pendingDetails:[...pendingDetails.values()], logs:(campaignId?sameCampaign:canResume)&&Array.isArray(existing.logs)?existing.logs:[], status:"running", message:"Buscando fichas...", searchUrl, searchKey:key, tabId, schemaVersion:6, ...(campaignId?{campaignId,campaignQuery,campaignStage}:{}), updatedAt:Date.now()};
    const snapshot=()=>({...state,rows:[...rows.values()].map(row=>({...row})),queryRows:queryRows.map(row=>({...row})),inspectedIds:[...inspected],pendingDetails:[...pendingDetails.values()].map(row=>({...row})),logs:[...(state.logs||[])]});
    const saveSnapshot=()=>{const copy=snapshot();persistChain=persistChain.catch(()=>{}).then(()=>writeState(copy));lastCheckpoint=Date.now();return persistChain;};
    const scheduleCheckpoint=(force=false)=>{
      writesSinceCheckpoint++;
      if(force||writesSinceCheckpoint>=8||Date.now()-lastCheckpoint>=2200){writesSinceCheckpoint=0;return saveSnapshot();}
      return persistChain;
    };
    const flushCheckpoint=async()=>{if(writesSinceCheckpoint){writesSinceCheckpoint=0;await saveSnapshot();}else await persistChain;};
    const mergeEnrichedRow=(base,detail)=>{
      const merged=combineRow(base,detail,country,searchUrl);
      const queryIndex=queryRows.findIndex(row=>(row.businessUrl&&row.businessUrl===merged.businessUrl)||utils.sameBusiness(row,base));
      if(queryIndex>=0)queryRows[queryIndex]=combineRow(queryRows[queryIndex],merged,country,searchUrl);
      storeUniqueRow(rows,merged,country,searchUrl);
      state.rows=[...rows.values()];state.queryRows=queryRows;
      state.message=`${rows.size} fichas · ${state.rows.filter(r=>r.phone).length} teléfonos · ${state.rows.filter(r=>r.category).length} categorías · ${state.rows.filter(r=>hasRealWebsite(r.website)).length} webs`;
    };
    const launchDetailTask=base=>{
      activeDetails++;
      const task=(async()=>{
        try{
          const result=await chrome.runtime.sendMessage({type:"GLCSV_ENRICH_DETAIL",row:base});
          if(result?.ok&&result.row){const detail={...result.row};mergeEnrichedRow(base,detail);pendingDetails.delete(base.businessUrl);logEvent(state,"info","Ficha enriquecida en segundo plano",{name:base.name,phone:Boolean(detail.phone),website:hasRealWebsite(detail.website),pending:pendingDetails.size});}
          else logEvent(state,"warn","Ficha pendiente de enriquecer; se conserva para continuar",{name:base.name,error:result?.error||"Sin datos adicionales"});
        }catch(error){logEvent(state,"warn","Ficha pendiente de enriquecer; se conserva para continuar",{name:base.name,error:String(error?.message||error)});}
        finally{
          activeDetails--;state.pendingDetails=[...pendingDetails.values()];state.updatedAt=Date.now();
          scheduleCheckpoint();pumpDetailQueue();
        }
      })();
      activeDetailTasks.add(task);task.finally(()=>activeDetailTasks.delete(task));
    };
    function pumpDetailQueue(){if(campaignId&&campaignStage==="collecting")return;while(!stopDetailQueue&&activeDetails<DETAIL_CONCURRENCY&&detailQueue.length)launchDetailTask(detailQueue.shift());}
    const enqueueDetail=base=>{
      if(!base?.businessUrl||pendingDetails.has(base.businessUrl))return;
      pendingDetails.set(base.businessUrl,base);state.pendingDetails=[...pendingDetails.values()];detailQueue.push(base);pumpDetailQueue();
      logEvent(state,"info","Ficha agregada a la cola de detalle",{name:base.name,active:activeDetails,queued:detailQueue.length});
      scheduleCheckpoint();
    };
    const drainDetailQueue=async()=>{while(detailQueue.length||activeDetails){pumpDetailQueue();if(activeDetailTasks.size)await Promise.race([...activeDetailTasks]);else await wait(100);}};
    const settleActiveDetails=async()=>{stopDetailQueue=true;while(activeDetails)if(activeDetailTasks.size)await Promise.race([...activeDetailTasks]);else await wait(100);};
    logEvent(state,"info",(campaignId?sameCampaign:canResume)?"Extracción reanudada":"Extracción iniciada",{query:utils.fromSearch(searchUrl),campaignQuery:campaignQuery||undefined,limit,detailTabs:DETAIL_CONCURRENCY,resumedRows:rows.size,alreadyInspected:inspected.size,tabId,...(campaignId?{campaignId,campaignStage}: {})});
    if(campaignId)logEvent(state,"info",campaignStage==="collecting"?
      "Campaña etapa 1/2: cargar resultados hasta que Maps confirme el final; sin abrir pestañas de enriquecimiento":
      "Campaña etapa 2/2: enriquecer las fichas guardadas antes de cambiar de ciudad",{
        campaignId,campaignStage,detailTabs:DETAIL_CONCURRENCY,resumedRows:rows.size
      });
    await writeState(state);
    showOverlay("Buscando fichas...");
    let noProgress=0;
    let iterations=0;
    let endReached=Boolean(campaignId&&sameCampaignQuery&&campaignStage==="enriching"&&existing.endReached);
    let emptyFeedRecoveryAttempts=0;
    let emptyFeedAdvance=false;
    const expectedQuery=plain(campaignQuery||utils.fromSearch(searchUrl));
    const recoveryTried=new Set();
    let finishReason="error";
    try {
      // Requeue durable work from a previous pause/reload before scanning further.
      for(const row of pendingDetails.values())detailQueue.push(row);
      pumpDetailQueue();
      while (!stopped && !endReached && (limit===0 || queryProcessed < limit)) {
        iterations++;
        const cards=selectCards();
        if(cards.length)emptyFeedRecoveryAttempts=0;
        const pending=cards.filter(c=>!inspected.has(c.key));
        if(hasNoMoreResults()&&!pending.length){endReached=true;break;}
        let count=0;
        for (const card of pending) {
          if (stopped || (limit>0 && queryProcessed>=limit)) break;
          if (!card.element.isConnected) continue;
          inspected.add(card.key);
          const add=rowFromCard(card,country,searchUrl);
          if(add.businessUrl){
            state.message=campaignId?`Resultado ${queryProcessed+1} guardado para enriquecer al final: ${card.name}`:`En cola ${activeDetails+detailQueue.length+1}: ${card.name}`;
            enqueueDetail(add);
          }else if(!campaignId){
            state.message=`Abriendo ficha ${campaignId?queryProcessed+1:rows.size+1}${limit ? "/"+limit : " (sin límite)"}: ${card.name}`;
            showOverlay(state.message);
            const clicked=clickCard(card);
            const panel=clicked ? await waitForPanel(card.name) : null;
            if (panel) {
            const detailPhone=phoneFromNode(panel);
            const detailRating=findRating(panel);
            const detailWebsite=externalWebsite(panel);
            const detailCategory=findCategory(panel,true);
            const detailAddress=findAddress(panel);
            if (detailPhone) add.phone=detailPhone;
            if (detailAddress) { add.address=detailAddress; add.location=utils.locality(detailAddress); }
            add.whatsappLink=whatsapp(add.phone,country,add.address || add.location,searchUrl);
            if (detailRating) add.rating=detailRating;
            if (detailWebsite) add.website=detailWebsite;
            if (detailCategory) add.category=detailCategory;
            }
          }else{
            logEvent(state,"warn","Ficha guardada con los datos visibles; Maps no expuso un enlace directo para enriquecerla en pestaña",{name:card.name});
          }
          const queryIndex=queryRows.findIndex(row=>utils.sameBusiness(row,add));
          const duplicateInQuery=queryIndex>=0;
          if(duplicateInQuery)queryRows[queryIndex]=combineRow(queryRows[queryIndex],add,country,searchUrl);
          else {queryRows.push({...add,id:utils.businessIdentity(add)||add.id});queryProcessed++;}
          const stored=storeUniqueRow(rows,add,country,searchUrl);
          state.rows=[...rows.values()];
          state.queryRows=queryRows;
          state.inspectedIds=[...inspected];
          state.pendingDetails=[...pendingDetails.values()];
          state.message=`${rows.size} fichas · ${state.rows.filter(r=>r.phone).length} teléfonos · ${state.rows.filter(r=>r.category).length} categorías · ${state.rows.filter(r=>hasRealWebsite(r.website)).length} webs`;
          logEvent(state,duplicateInQuery||stored.duplicate?"warn":"info",duplicateInQuery||stored.duplicate?"Ficha duplicada omitida":"Ficha guardada",{name:card.name,total:rows.size,duplicatesSkipped:duplicateInQuery||stored.duplicate,phone:Boolean(add.phone),website:hasRealWebsite(add.website),businessUrl:Boolean(add.businessUrl)});
          state.updatedAt=Date.now();
          scheduleCheckpoint();
          showOverlay(`${state.message}\nÚltima: ${card.name}`);
          count++;
          if(!campaignId&&!stopped&&detailQueue.length+activeDetails>=MAX_DETAIL_BACKLOG)
            while(!stopped&&detailQueue.length+activeDetails>=MAX_DETAIL_BACKLOG)await wait(100);
          if (!stopped&&!add.businessUrl) await wait(180);
        }
        if (stopped || (limit>0 && queryProcessed>=limit)) break;
        state.message=`Buscando más resultados... (${rows.size} guardados)`;
        await flushCheckpoint();
        showOverlay(state.message);
        const beforeNoProgress=noProgress;
        const scroll=await advanceResults(cards);
        let hasNew=selectCards().some(c=>!inspected.has(c.key));
        const endMarkerVisible=Boolean(scroll.endReached||hasNoMoreResults());
        endReached=endMarkerVisible&&!hasNew;
        let listResetRecovery=null;
        // Al volver desde una ficha, Maps puede reconstruir el feed en el
        // comienzo (por ejemplo, 118 tarjetas pasan a 8 y scrollTop a 0).
        // Recupera el tramo ya cargado antes de iniciar otro ciclo de scroll.
        const countDropped=Number(scroll.cardsBefore)>=30&&Number(scroll.cardsAfter)<Number(scroll.cardsBefore)*.45;
        const jumpedToStart=Number(scroll.topBefore)>1000&&Number(scroll.topAfter)<1000;
        if(!endReached&&!stopped&&countDropped&&jumpedToStart) {
          logEvent(state,"warn","Maps reinició la lista; recuperando el tramo cargado antes de continuar",{
            cardsBefore:scroll.cardsBefore,cardsAfter:scroll.cardsAfter,topBefore:scroll.topBefore,topAfter:scroll.topAfter
          });
          listResetRecovery=await restorePreviouslyLoadedResults(Number(scroll.cardsBefore),80);
          hasNew=selectCards().some(c=>!inspected.has(c.key));
          const restoredEnd=Boolean(listResetRecovery.endReached||hasNoMoreResults());
          endReached=restoredEnd&&!hasNew;
          if(listResetRecovery.restored)noProgress=0;
          logEvent(state,listResetRecovery.restored?"info":"warn",listResetRecovery.restored?
            "Tramo previamente cargado recuperado; retomando desde las fichas nuevas":
            "No se pudo recuperar todo el tramo anterior; se conserva la misma ciudad y se sigue cargando",{
              ...listResetRecovery,hasUnseenCard:hasNew,endReached
            });
        }
        noProgress=endReached?0:(hasNew||count>0||listResetRecovery?.restored?0:noProgress+1);
        let recovery=null, recoveryScroll=null, recoveryCycles=0;
        let recoveryWait=null;
        if(!endReached&&!stopped&&noProgress>=MAX_NO_PROGRESS) {
          state.message="Maps no agregó resultados; esperando hasta 10 segundos para que termine la carga…";
          showOverlay(state.message);
          recoveryWait=await waitForStalledFeed(inspected,10000);
          hasNew=Boolean(recoveryWait.newResults||selectCards().some(card=>!inspected.has(card.key)));
          endReached=Boolean(recoveryWait.endReached&&!hasNew);
          logEvent(state,recoveryWait.endReached?"info":"warn",recoveryWait.endReached?
            "Maps confirmó el final mientras se esperaba la carga":recoveryWait.newResults?
            "Maps cargó fichas nuevas durante la espera":"Maps no avanzó durante 10 segundos; se probarán fichas anteriores",{
              ...recoveryWait,hasUnseenCard:hasNew,scrollPosition:captureResultsPosition().top
            });
          if(hasNew||endReached)noProgress=0;
        }
        if(!endReached&&!stopped&&noProgress>=MAX_NO_PROGRESS) {
          while(!stopped&&!endReached&&!hasNew) {
            recoveryCycles++;
            state.message=`Maps sigue cargando en esta ciudad. Probando fichas recientes (${recoveryCycles})…`;
            showOverlay(state.message);
            recovery=await recoverStalledResults(recoveryTried,inspected,expectedQuery);
            if(recovery.endReached){endReached=true;break;}
            if(recovery.newResults){hasNew=true;noProgress=0;break;}
            if(recovery.restoreFailed) {
              logEvent(state,"error","No se pudo volver a la lista tras abrir una ficha; se detiene la recuperación para evitar repetir tarjetas",{name:recovery.card,openedBy:recovery.openedBy,urlAfter:recovery.urlAfter,attemptedCards:recovery.attemptedNames});
              throw new Error(`Se abrió «${recovery.card}», pero Maps no regresó a la lista de resultados.`);
            }
            if(recovery.recovered) {
              logEvent(state,"warn","Ficha reciente abierta; retomando el scroll desde la posición anterior",{name:recovery.card,openedBy:recovery.openedBy,attemptedCards:recovery.attemptedNames,positionBefore:recovery.positionBefore,positionAfter:recovery.positionAfter,urlAfter:recovery.urlAfter,searchMatchesOriginal:recovery.searchMatchesOriginal});
              recoveryScroll=await scrollUntilNewResults(inspected);
              hasNew=Boolean(recoveryScroll.newResults||selectCards().some(c=>!inspected.has(c.key)));
              endReached=Boolean(recoveryScroll.endReached&&!hasNew);
              if(endReached||hasNew){noProgress=0;break;}
            }
            if(!recovery.attemptedNames?.length) {
              if(!selectCards().length) {
                emptyFeedRecoveryAttempts++;
                const actualQuery=mapsSearchValue();
                const restoredSearch=await submitMapsSearch(expectedQuery);
                const refreshed=selectCards();
                hasNew=refreshed.some(c=>!inspected.has(c.key));
                endReached=Boolean(restoredSearch.endReached&&!hasNew);
                logEvent(state,restoredSearch.ok?"info":"warn",restoredSearch.ok?
                  "Vista sin tarjetas: se restauró la búsqueda activa de Maps":
                  "Vista sin tarjetas: se intentó restaurar la búsqueda activa",{
                    expectedQuery,actualQuery,emptyFeedRecoveryAttempts,restoredSearch,
                    refreshedCards:refreshed.length,hasUnseenCard:hasNew,endReached
                  });
                if(endReached||hasNew||refreshed.length) {noProgress=0;break;}
                if(emptyFeedRecoveryAttempts>=2) {
                  if(campaignId) {
                    emptyFeedAdvance=true;
                    logEvent(state,"warn","La lista no reapareció tras dos intentos; la campaña avanzará sin confirmar el fin de esta ciudad",{
                      campaignId,campaignQuery,expectedQuery,emptyFeedRecoveryAttempts,rows:rows.size,
                      endMarkerConfirmed:false,refreshedCards:refreshed.length
                    });
                    noProgress=0;
                    break;
                  }
                  throw new Error(`Maps no volvió a mostrar resultados para «${expectedQuery}» tras dos intentos. Los resultados guardados siguen disponibles.`);
                }
                await wait(900);
                noProgress=MAX_NO_PROGRESS;
                await scheduleCheckpoint(true);
                continue;
              }
              // Do not clear recoveryTried: that would send the recovery loop
              // back to the first cards forever. Keep moving down the feed
              // until Maps adds cards or shows its real end marker.
              recoveryScroll=await scrollUntilNewResults(inspected,20);
              hasNew=Boolean(recoveryScroll.newResults||selectCards().some(c=>!inspected.has(c.key)));
              endReached=Boolean(recoveryScroll.endReached&&!hasNew);
              if(endReached||hasNew){noProgress=0;break;}
              await wait(900);
            }
            noProgress=MAX_NO_PROGRESS;
            state.message=`Sigo en esta ciudad hasta que carguen fichas nuevas o Maps confirme “No hay más resultados”.`;
            logEvent(state,"warn","La ciudad sigue activa; no se avanza sin resultados nuevos o el marcador de fin",{recoveryCycles,attemptedCards:recovery.attemptedNames,spinnerVisible:resultsSpinnerVisible(),scrollSteps:recoveryScroll?.scrollSteps||0});
            state.updatedAt=Date.now();
            await scheduleCheckpoint(true);
          }
        }
        if(emptyFeedAdvance)break;
        state.message=endReached?`Google Maps confirmó que no hay más resultados. ${rows.size} fichas guardadas.`:
          endMarkerVisible&&hasNew?`Maps mostró el marcador de fin; procesando ${selectCards().filter(c=>!inspected.has(c.key)).length} fichas ya cargadas…`:
          recovery?.recovered?`Ficha ${recovery.card} cargada; desplazando para continuar (${selectCards().length} visibles)…`:
          `Desplazamiento ${scroll.method}: ${rows.size} fichas · ${noProgress}/${MAX_NO_PROGRESS} intentos sin avance`;
        const scrollEvent=endReached?"Fin de resultados confirmado":endMarkerVisible&&hasNew?"Marcador de fin visible; procesando fichas pendientes":"Desplazamiento para cargar más resultados";
        logEvent(state,endReached?"info":noProgress?"warn":"info",scrollEvent,{iteration:iterations,visibleCards:cards.length,processedThisPass:count,hasUnseenCard:hasNew,endMarkerVisible,noProgressBefore:beforeNoProgress,noProgressAfter:noProgress,endReached,recoveryWait,recovery,recoveryScroll,recoveryCycles,listResetRecovery,...scroll});
        state.updatedAt=Date.now();
        scheduleCheckpoint();
        await flushCheckpoint();
        showOverlay(state.message);
      }
      if(campaignId&&campaignStage==="collecting"&&!stopped&&(endReached||emptyFeedAdvance||(limit>0&&queryProcessed>=limit))) {
        campaignStage="enriching";
        state.campaignStage=campaignStage;
        state.endReached=endReached;
        state.message=`Recolección terminada: ${rows.size} fichas. Volviendo al inicio para enriquecer con ${DETAIL_CONCURRENCY} pestañas…`;
        showOverlay(state.message);
        await flushCheckpoint();
        const topPosition=restoreResultsPosition({top:0});
        logEvent(state,"info","Fin de recolección: Maps llegó al marcador final; comienza el enriquecimiento por lotes",{
          campaignId,campaignQuery,rows:rows.size,pending:pendingDetails.size,detailTabs:DETAIL_CONCURRENCY,
          endMarkerConfirmed:endReached,limitReached:limit>0&&queryProcessed>=limit,position:topPosition
        });
        await scheduleCheckpoint(true);
        pumpDetailQueue();
      }
      if(stopped)await settleActiveDetails();else await drainDetailQueue();
      // Una campaña no cambia de ciudad ni deja fichas atrás: Maps ya confirmó
      // el fin, así que reabrimos las fichas fallidas hasta completar la cola.
      // El usuario puede detener la campaña mientras espera/reintenta.
      let pendingRetryRound=0;
      while(campaignId&&(endReached||emptyFeedAdvance)&&!stopped&&pendingDetails.size){
        pendingRetryRound++;
        detailQueue.push(...pendingDetails.values());
        state.message=`Reintentando ${pendingDetails.size} fichas pendientes antes de avanzar (${pendingRetryRound})…`;
        showOverlay(state.message);
        logEvent(state,"warn","Reintentando fichas pendientes antes del cambio de ciudad",{
          campaignQuery,campaignId,retryRound:pendingRetryRound,pending:pendingDetails.size,
          businesses:[...pendingDetails.values()].map(row=>row.name).filter(Boolean).slice(0,20)
        });
        pumpDetailQueue();
        await drainDetailQueue();
        if(pendingDetails.size&&!stopped)await wait(Math.min(5000,1000*pendingRetryRound));
      }
      if(!endReached&&hasNoMoreResults()&&!selectCards().some(card=>!inspected.has(card.key)))endReached=true;
      const limitReached=limit>0&&queryProcessed>=limit;
      const detailsNeedRetry=pendingDetails.size>0;
      const limitStoppedCampaign=Boolean(campaignId&&limitReached&&!endReached);
      const stalledWithoutEnd=!stopped&&!endReached&&limitStoppedCampaign;
      const needsContinue=!stopped&&(detailsNeedRetry||stalledWithoutEnd)&&!emptyFeedAdvance;
      state.status=stopped||needsContinue?"paused":"complete";
      finishReason=stopped?"manual":emptyFeedAdvance?"empty-view":needsContinue?"error":limitReached?"limit":"complete";
      state.message=stopped?`Detenido. ${rows.size} fichas guardadas; podés descargar o continuar.`:
        emptyFeedAdvance?`Maps no recuperó la lista tras dos intentos. La campaña continúa con la próxima ciudad; ${rows.size} fichas guardadas.`:
        detailsNeedRetry?`Pausado: ${pendingDetails.size} fichas quedaron pendientes de completar. Pulsa continuar para reintentarlas; tus resultados están guardados.`:
        limitStoppedCampaign?`Límite de fichas alcanzado antes de que Maps confirmara el final. La campaña queda pausada aquí; no se iniciará otra ciudad.`:
        limitReached?`Límite alcanzado: ${rows.size} fichas. CSV disponible.`:
        stalledWithoutEnd?`Límite de fichas alcanzado antes de que Maps confirmara el final. La campaña queda aquí; no se iniciará otra ciudad.`:
        endReached?`Finalizado: Maps confirmó que no hay más resultados. ${rows.size} fichas detectadas; CSV disponible.`:
        `Finalizado: ${rows.size} fichas detectadas. CSV disponible.`;
      logEvent(state,needsContinue||emptyFeedAdvance?"warn":"info",state.message,{iterations,noProgress,limitReached,limitStoppedCampaign,stopped,endReached,endMarkerConfirmed:endReached,campaignQuery:campaignQuery||undefined,stalledWithoutEnd,detailsNeedRetry,pendingDetails:pendingDetails.size,pendingRetryRound,advancedWithoutEndMarker:emptyFeedAdvance,rows:rows.size});
    } catch(err) {
      await settleActiveDetails().catch(()=>{});
      state.status="error";
      finishReason="error";
      state.message=`Interrumpido: ${err?.message || err}. Los ${rows.size} resultados guardados siguen disponibles.`;
      logEvent(state,"error",state.message,{stack:String(err?.stack||"").slice(0,1800),iterations,rows:rows.size});
    } finally {
      state.rows=[...rows.values()];
      state.queryRows=queryRows;
      state.inspectedIds=[...inspected];
      state.pendingDetails=[...pendingDetails.values()];
      state.updatedAt=Date.now();
      await flushCheckpoint().catch(()=>{});
      showOverlay(state.message);
      if (ui?.stop) {ui.stop.disabled=true;ui.stop.textContent="Finalizado";}
      setTimeout(hideOverlay,4500);
      running=false;
      currentRun=null;
      stopped=false;
      if(campaignId)chrome.runtime.sendMessage({type:"GLCSV_CAMPAIGN_QUERY_FINISHED",campaignId,campaignQuery,reason:finishReason,endMarkerConfirmed:endReached,rows:rows.size}).catch(()=>{});
    }
  }
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
    if(message?.type==="GLCSV_DETAIL_EXTRACT"){
      extractPlaceDetails(message.row||{}).then(row=>sendResponse({ok:true,row})).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
      return true;
    } else if (message?.type==="GLCSV_START") {
      if (running) {sendResponse({ok:false,error:"Ya hay una extracción en marcha."});return;}
      if (!/(\/maps(?:\/|\?|$)|\/search\?)/.test(location.href)) {sendResponse({ok:false,error:"Abrí resultados de Google Local o Google Maps."});return;}
      running=true; stopped=false;
      const parsedLimit=Number(message.limit);
      const limit=Number.isInteger(parsedLimit) && parsedLimit>=0 ? within(parsedLimit,0,100000) : 0;
      currentRun=scan({limit,searchUrl:message.searchUrl || location.href,tabId:message.tabId,
        country:message.country || "auto",detailConcurrency:message.parallelTabs||5,campaignId:message.campaignId||"",campaignQuery:message.campaignQuery||""})
        .catch(async err=>{
          // scan() also performs storage reads before its internal try/finally.
          // Consume failures there (including a context invalidated by reload)
          // so they don't surface as an unhandled promise rejection.
          try {
            const stored=(await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
            if(!stored)return;
            const logs=Array.isArray(stored.logs)?stored.logs:[];
            logs.push({time:new Date().toISOString(),level:'error',event:'No se pudo iniciar o continuar el escaneo',details:{error:String(err?.message||err)}});
            const resumeLabel=message.campaignId?'Continuar campaña':'Continuar extracción guardada';
            await writeState({...stored,status:'paused',message:`La extensión se interrumpió. Los resultados guardados siguen disponibles; pulsa «${resumeLabel}» para retomar.`,logs:logs.slice(-MAX_LOG_ENTRIES),updatedAt:Date.now()});
          } catch {}
        })
        .finally(()=>{running=false;currentRun=null;stopped=false;});
      sendResponse({ok:true});
    } else if (message?.type==="GLCSV_STOP") {
      stopped=true;
      sendResponse({ok:true,running});
    } else if (message?.type==="GLCSV_PING") sendResponse({ok:true,running});
  });
})();
