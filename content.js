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
      return `${u.hostname}${u.pathname}?q=${u.searchParams.get("q") || u.searchParams.get("query") || ""}&udm=${u.searchParams.get("udm") || ""}`;
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
  function clickCard(card) {
    const root = card.element;
    if (!root?.isConnected) return false;
    try {
      let target = root.querySelector(".dbg0pd, .fontHeadlineSmall, .qBF1Pd, a.hfpxzc") || root;
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
      await wait(1700);
      const afterCount=selectCards().length;
      const after=scroller.scrollTop;
      return {moved:after!==old||afterCount>beforeCount,method:"container",target:`${scroller.tagName.toLowerCase()}${scroller.id?`#${scroller.id}`:""}${typeof scroller.className==="string"&&scroller.className?`.${scroller.className.trim().split(/\s+/).slice(0,3).join(".")}`:""}`,topBefore:old,topAfter:after,maxTop,clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,cardsBefore:beforeCount,cardsAfter:afterCount};
    }
    const old=window.scrollY;
    const step=Math.max(520,window.innerHeight*.78);
    cards.at(-1)?.element?.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,view:window,deltaY:step}));
    window.scrollBy({top:step,behavior:"instant"});
    await wait(1700);
    const afterCount=selectCards().length;
    return {moved:window.scrollY!==old||afterCount>beforeCount,method:"window-fallback",topBefore:old,topAfter:window.scrollY,cardsBefore:beforeCount,cardsAfter:afterCount};
  }
  const MAX_LOG_ENTRIES=200;
  const MAX_NO_PROGRESS=8;
  function logEvent(state,level,event,details={}) {
    const logs=Array.isArray(state.logs)?state.logs:[];
    logs.push({time:new Date().toISOString(),level,event,details});
    state.logs=logs.slice(-MAX_LOG_ENTRIES);
  }
  async function scan({limit,searchUrl,tabId,country,campaignId,campaignQuery}) {
    let existing=(await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
    const key=sourceKey(searchUrl);
    const canResume=existing.searchKey===key && Array.isArray(existing.rows);
    const sameCampaign=Boolean(campaignId&&existing.campaignId===campaignId&&Array.isArray(existing.rows));
    const sameCampaignQuery=sameCampaign&&existing.campaignQuery===campaignQuery;
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
    const state={rows:[...rows.values()], queryRows, inspectedIds:[...inspected], logs:(campaignId?sameCampaign:canResume)&&Array.isArray(existing.logs)?existing.logs:[], status:"running", message:"Buscando fichas...", searchUrl, searchKey:key, tabId, schemaVersion:3, ...(campaignId?{campaignId,campaignQuery}:{}), updatedAt:Date.now()};
    logEvent(state,"info",(campaignId?sameCampaign:canResume)?"Extracción reanudada":"Extracción iniciada",{query:utils.fromSearch(searchUrl),limit,resumedRows:rows.size,alreadyInspected:inspected.size,tabId,...(campaignId?{campaignId}: {})});
    await writeState(state);
    showOverlay("Buscando fichas...");
    let noProgress=0;
    let iterations=0;
    let finishReason="error";
    try {
      while (!stopped && (limit===0 || queryProcessed < limit) && noProgress < MAX_NO_PROGRESS && iterations < 10000) {
        iterations++;
        const cards=selectCards();
        const pending=cards.filter(c=>!inspected.has(c.key));
        let count=0;
        for (const card of pending) {
          if (stopped || (limit>0 && queryProcessed>=limit)) break;
          if (!card.element.isConnected) continue;
          inspected.add(card.key);
          state.message=`Abriendo ficha ${campaignId?queryProcessed+1:rows.size+1}${limit ? "/"+limit : " (sin límite)"}: ${card.name}`;
          showOverlay(state.message);
          const clicked=clickCard(card);
          const panel=clicked ? await waitForPanel(card.name) : null;
          const add=rowFromCard(card,country,searchUrl);
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
          const queryIndex=queryRows.findIndex(row=>utils.sameBusiness(row,add));
          const duplicateInQuery=queryIndex>=0;
          if(duplicateInQuery)queryRows[queryIndex]=combineRow(queryRows[queryIndex],add,country,searchUrl);
          else {queryRows.push({...add,id:utils.businessIdentity(add)||add.id});queryProcessed++;}
          const stored=storeUniqueRow(rows,add,country,searchUrl);
          state.rows=[...rows.values()];
          state.queryRows=queryRows;
          state.inspectedIds=[...inspected];
          state.message=`${rows.size} fichas · ${state.rows.filter(r=>r.phone).length} teléfonos · ${state.rows.filter(r=>r.category).length} categorías · ${state.rows.filter(r=>hasRealWebsite(r.website)).length} webs`;
          logEvent(state,duplicateInQuery||stored.duplicate?"warn":"info",duplicateInQuery||stored.duplicate?"Ficha duplicada omitida":"Ficha guardada",{name:card.name,total:rows.size,duplicatesSkipped:duplicateInQuery||stored.duplicate,phone:Boolean(add.phone),website:hasRealWebsite(add.website),businessUrl:Boolean(add.businessUrl)});
          state.updatedAt=Date.now();
          await writeState(state);
          showOverlay(`${state.message}\nÚltima: ${card.name}`);
          count++;
          if (!stopped) await wait(750);
        }
        if (stopped || (limit>0 && queryProcessed>=limit)) break;
        state.message=`Buscando más resultados... (${rows.size} guardados)`;
        await writeState(state);
        showOverlay(state.message);
        const beforeNoProgress=noProgress;
        const scroll=await advanceResults(cards);
        const hasNew=selectCards().some(c=>!inspected.has(c.key));
        noProgress=hasNew||count>0||scroll.moved?0:noProgress+1;
        state.message=`Desplazamiento ${scroll.method}: ${rows.size} fichas · ${noProgress}/${MAX_NO_PROGRESS} intentos sin avance`;
        logEvent(state,noProgress?"warn":"info","Desplazamiento para cargar más resultados",{iteration:iterations,visibleCards:cards.length,processedThisPass:count,hasUnseenCard:hasNew,noProgressBefore:beforeNoProgress,noProgressAfter:noProgress,...scroll});
        state.updatedAt=Date.now();
        await writeState(state);
        showOverlay(state.message);
      }
      const limitReached=limit>0&&queryProcessed>=limit;
      const needsContinue=!stopped&&!limitReached&&(noProgress>=MAX_NO_PROGRESS||iterations>=10000);
      state.status=stopped||needsContinue?"paused":"complete";
      finishReason=stopped?"manual":needsContinue?"exhausted":limitReached?"limit":"complete";
      state.message=stopped?`Detenido. ${rows.size} fichas guardadas; podés descargar o continuar.`:
        limitReached?`Límite alcanzado: ${rows.size} fichas. CSV disponible.`:
        needsContinue?`Pausado: Maps no cargó nuevos resultados tras ${noProgress} intentos. ${rows.size} fichas guardadas; podés continuar.`:
        `Finalizado: ${rows.size} fichas detectadas. CSV disponible.`;
      logEvent(state,needsContinue?"warn":"info",state.message,{iterations,noProgress,limitReached,stopped,rows:rows.size});
    } catch(err) {
      state.status="error";
      finishReason="error";
      state.message=`Interrumpido: ${err?.message || err}. Los ${rows.size} resultados guardados siguen disponibles.`;
      logEvent(state,"error",state.message,{stack:String(err?.stack||"").slice(0,1800),iterations,rows:rows.size});
    } finally {
      state.rows=[...rows.values()];
      state.queryRows=queryRows;
      state.inspectedIds=[...inspected];
      state.updatedAt=Date.now();
      await writeState(state).catch(()=>{});
      showOverlay(state.message);
      if (ui?.stop) {ui.stop.disabled=true;ui.stop.textContent="Finalizado";}
      setTimeout(hideOverlay,4500);
      running=false;
      currentRun=null;
      stopped=false;
      if(campaignId)chrome.runtime.sendMessage({type:"GLCSV_CAMPAIGN_QUERY_FINISHED",campaignId,campaignQuery,reason:finishReason,rows:rows.size}).catch(()=>{});
    }
  }
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
    if (message?.type==="GLCSV_START") {
      if (running) {sendResponse({ok:false,error:"Ya hay una extracción en marcha."});return;}
      if (!/(\/maps(?:\/|\?|$)|\/search\?)/.test(location.href)) {sendResponse({ok:false,error:"Abrí resultados de Google Local o Google Maps."});return;}
      running=true; stopped=false;
      const parsedLimit=Number(message.limit);
      const limit=Number.isInteger(parsedLimit) && parsedLimit>=0 ? within(parsedLimit,0,100000) : 0;
      currentRun=scan({limit,searchUrl:message.searchUrl || location.href,tabId:message.tabId,
        country:message.country || "auto",campaignId:message.campaignId||"",campaignQuery:message.campaignQuery||""});
      sendResponse({ok:true});
    } else if (message?.type==="GLCSV_STOP") {
      stopped=true;
      sendResponse({ok:true,running});
    } else if (message?.type==="GLCSV_PING") sendResponse({ok:true,running});
  });
})();
