/* global chrome, GLCSVUtil */
(() => {
  "use strict";
  const util=globalThis.GLCSVUtil;
  const $=id=>document.getElementById(id);
  const names=["page","searchQuery","searchStart","resume","logPanel","logCount","logOutput","copyLog","total","phoneCount","webCount","status","limit","start","stop","download","clear",
    "categories","categoryCount","locations","locationCount","targetLocation","strictLocation","locationHint","country","whatsappMessage","exportCount","websiteMode","phoneMode"];
  const els=Object.fromEntries(names.map(id=>[id,$(id)]));
  const STATE_KEY="glcsv_state", FILTER_KEY="glcsv_filters", SETTINGS_KEY="glcsv_settings";
  const initial=()=>({rows:[], logs:[], status:"idle", message:"Listo para comenzar.", searchUrl:"",searchKey:""});
  const blankFilters=key=>({searchKey:key||"",excludedCategories:[],excludedLocations:[],targetLocation:"",targetTouched:false,strictLocation:true,websiteMode:"all",phoneMode:"all"});
  let activeTab=null, pageSupported=false, state=initial();
  let filters=blankFilters(""), settings={country:"auto",limit:0,searchQuery:"",whatsappMessage:""};
  let loading=true;
  const UNKNOWN="__unknown__";
  function sourceKey(url) {
    try { const u=new URL(url); return `${u.hostname}${u.pathname}?q=${u.searchParams.get("q")||u.searchParams.get("query")||""}&udm=${u.searchParams.get("udm")||""}`; }
    catch { return (url||"").split("#")[0]; }
  }
  function supported(url) {
    try {
      const u=new URL(url);
      return /(^|\.)google\.[a-z.]+$/i.test(u.hostname) &&
        (u.pathname.startsWith("/maps") || (u.pathname==="/search" && (u.searchParams.get("udm")==="local" || u.searchParams.get("tbm")==="lcl")));
    } catch { return false; }
  }
  const rows=()=>Array.isArray(state.rows)?state.rows:[];
  function rowLocation(row) {return (row.location || util.locality(row.address || "") || "").trim();}
  function rowCategory(row) {return (row.category||"").trim();}
  function groupKey(s) {return util.norm(s)||UNKNOWN;}
  function groups(items,getValue) {
    const g=new Map();
    for(const row of items) {
      const name=getValue(row)||"Sin identificar";
      const key=name==="Sin identificar"?UNKNOWN:groupKey(name);
      if(!g.has(key)) g.set(key,{key,name,count:0});
      g.get(key).count++;
    }
    return [...g.values()].sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name,"es"));
  }
  const currentAutoTarget=()=>util.suggestedTarget(rows(),state.searchUrl);
  function target() {return filters.targetTouched ? (filters.targetLocation||"").trim() : currentAutoTarget();}
  function inTarget(row,desired) {
    const actual=util.norm(rowLocation(row));
    const targetText=util.norm(desired);
    if(!targetText) return true;
    if(!actual) return false;
    return actual===targetText || targetText.startsWith(actual+",") || targetText.startsWith(actual+" ");
  }
  function includedRows() {
    const badCats=new Set(filters.excludedCategories||[]),badCities=new Set(filters.excludedLocations||[]);
    const targetCity=filters.strictLocation?target():"";
    const websiteMode=filters.websiteMode||"all",phoneMode=filters.phoneMode||"all";
    return rows().filter(row=>!badCats.has(groupKey(rowCategory(row))) &&
      !badCities.has(groupKey(rowLocation(row))) && inTarget(row,targetCity) &&
      (websiteMode==="all" || (websiteMode==="with" ? Boolean(String(row.website||"").trim()) : !String(row.website||"").trim())) &&
      (phoneMode==="all" || (phoneMode==="with" ? Boolean(String(row.phone||"").trim()) : !String(row.phone||"").trim())));
  }
  function rowCsv(row) {
    const link=util.whatsapp(row.phone||"",settings.country||"auto",row.address || rowLocation(row),state.searchUrl,settings.whatsappMessage) || row.whatsappLink || "";
    return [row.name,row.phone,row.rating,row.category,row.website,link,row.businessUrl||""];
  }
  function csvCell(value) {
    let s=String(value ?? "").replace(/\r?\n/g," ").trim();
    if(/^[\s\uFEFF]*[=+\-@]/.test(s)) s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function buildCsv(items) {
    const header=["nombre","telefono","rating","categoria","website","whatsapp_link","url_negocio"];
    return "\uFEFF"+[header,...items.map(rowCsv)].map(r=>r.map(csvCell).join(",")).join("\r\n")+"\r\n";
  }
  function fileSlug(input) {
    return (input||"negocios").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .replace(/[^a-z0-9_-]+/gi,"_").replace(/^_+|_+$/g,"").slice(0,62)||"negocios";
  }
  function message(str) {els.status.textContent=str;}
  function formatLog(entry) {
    const time=entry.time||new Date().toISOString();
    const level=String(entry.level||"info").toUpperCase();
    const details=entry.details&&Object.keys(entry.details).length?` ${JSON.stringify(entry.details)}`:"";
    return `[${time}] [${level}] ${entry.event||"Evento"}${details}`;
  }
  function renderLog(entries) {
    const logs=Array.isArray(entries)?entries:[];
    els.logCount.textContent=`${logs.length} evento${logs.length===1?"":"s"}`;
    els.logOutput.value=logs.slice(-40).map(formatLog).join("\n")||"Todavía no hay eventos registrados.";
    els.logOutput.scrollTop=els.logOutput.scrollHeight;
  }
  const trash='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v7m4-7v7"/></svg>';
  const undo='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2"/></svg>';
  function drawList(container,items,kind,exclusions) {
    const prevScroll=container.scrollTop;
    container.replaceChildren();
    if(!items.length) {
      const p=document.createElement("p");p.className="empty";
      p.textContent=kind==="category"?"Todavía no hay categorías detectadas.":"Todavía no hay ubicaciones detectadas.";
      container.appendChild(p);return;
    }
    for(const item of items) {
      const excluded=exclusions.includes(item.key);
      const row=document.createElement("div");row.className="filter-row"+(excluded?" excluded":"");
      const name=document.createElement("span");name.className="filter-name";name.textContent=item.name;
      const count=document.createElement("span");count.className="filter-num";count.textContent=String(item.count);
      const button=document.createElement("button");button.type="button";
      button.dataset.kind=kind;button.dataset.key=item.key;
      button.setAttribute("aria-label",(excluded?"Restaurar ":"Excluir del CSV ")+item.name);
      button.title=(excluded?"Restaurar ":"Excluir del CSV ")+item.name;
      button.innerHTML=excluded?undo:trash;
      row.append(name,count,button);container.appendChild(row);
    }
    container.scrollTop=prevScroll;
  }
  function render() {
    if(loading) return;
    const data=rows(), kept=includedRows();
    renderLog(state.logs);
    els.total.textContent=String(data.length);
    els.phoneCount.textContent=String(data.filter(r=>r.phone).length);
    els.webCount.textContent=String(data.filter(r=>r.website).length);
    const cGroups=groups(data,rowCategory), lGroups=groups(data,rowLocation);
    els.categoryCount.textContent=String(cGroups.length);
    els.locationCount.textContent=String(lGroups.length);
    drawList(els.categories,cGroups,"category",filters.excludedCategories||[]);
    drawList(els.locations,lGroups,"location",filters.excludedLocations||[]);
    els.exportCount.textContent=`${kept.length} / ${data.length}`;
    els.exportCount.title="Fichas que se exportarán / fichas detectadas";
    const suggest=currentAutoTarget();
    if(document.activeElement!==els.targetLocation) els.targetLocation.value=target();
    els.targetLocation.placeholder=suggest?`Ej.: ${suggest}`:"Ej.: Posadas";
    els.strictLocation.checked=filters.strictLocation!==false;
    els.websiteMode.value=filters.websiteMode||"all";
    els.phoneMode.value=filters.phoneMode||"all";
    els.country.value=settings.country||"auto";
    if(document.activeElement!==els.whatsappMessage) els.whatsappMessage.value=settings.whatsappMessage||"";
    if(document.activeElement!==els.searchQuery) els.searchQuery.value=settings.searchQuery||"";
    if(document.activeElement!==els.limit) els.limit.value=String(settings.limit??0);
    const unknown=data.filter(r=>!rowLocation(r)).length;
    els.locationHint.textContent=!data.length?"Para filtrar por ciudad se utiliza la dirección pública de cada ficha.":
      (unknown?`${unknown} ficha(s) sin ciudad identificable. `:"")+
      (filters.strictLocation && target()?`Solo se exportarán negocios de ${target()}.`:
       suggest&&!filters.strictLocation?`Objetivo sugerido: ${suggest}. El filtro está desactivado.`:
       "Escribí una ciudad para activar el filtro geográfico; también podés usar las papeleras.");
    message(state.message||"Listo para comenzar.");
    els.start.disabled=!pageSupported || state.status==="running";
    els.stop.disabled=state.status!=="running";
    els.download.disabled=kept.length===0;
    els.limit.disabled=state.status==="running";
    els.country.disabled=state.status==="running";
    els.searchQuery.disabled=state.status==="running";
    els.searchStart.disabled=state.status==="running" || !els.searchQuery.value.trim();
    els.resume.hidden=!state.searchUrl;
    els.resume.textContent=state.status==="running"?"● Comprobar extracción en segundo plano":"↻ Continuar extracción guardada";
    els.start.textContent=state.status==="running"?"● Extracción en curso":
      data.length && state.searchKey===sourceKey(activeTab?.url||"")?"▶ Continuar en esta pestaña":"▶ Iniciar en esta pestaña";
  }
  async function readData() {
    const stored=await chrome.storage.local.get([STATE_KEY,FILTER_KEY,SETTINGS_KEY]);
    state=stored[STATE_KEY]||initial();
    filters=stored[FILTER_KEY]||blankFilters(state.searchKey);
    if(filters.searchKey!==state.searchKey) filters=blankFilters(state.searchKey);
    settings={country:"auto",limit:0,searchQuery:"",whatsappMessage:"",...(stored[SETTINGS_KEY]||{})};
    loading=false;
    render();
  }
  async function appendUiLog(level,event,details={}) {
    const stored=await chrome.storage.local.get(STATE_KEY);
    const latest=stored[STATE_KEY]||state;
    const logs=Array.isArray(latest.logs)?latest.logs:[];
    logs.push({time:new Date().toISOString(),level,event,details});
    latest.logs=logs.slice(-200);
    await chrome.storage.local.set({[STATE_KEY]:latest});
  }
  async function currentTab() {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    activeTab=tab||null;pageSupported=Boolean(activeTab&&supported(activeTab.url));
    els.page.textContent=pageSupported ?
      (util.fromSearch(activeTab.url) || "Google Maps") : "Escribí una búsqueda o abrí Google Maps";
    els.page.title=activeTab?.url||"";
    render();
  }
  async function send(type,extra={}) {
    if(!activeTab?.id) throw new Error("No se detectó una pestaña activa.");
    await chrome.scripting.executeScript({target:{tabId:activeTab.id},files:["data_utils.js","content.js"]});
    return await chrome.tabs.sendMessage(activeTab.id,{type,...extra});
  }
  async function saveFilters() {await chrome.storage.local.set({[FILTER_KEY]:filters});}
  async function saveSettings() {await chrome.storage.local.set({[SETTINGS_KEY]:settings});}
  for(const list of [els.categories,els.locations]) {
    list.addEventListener("click",async event=>{
      const button=event.target.closest("button[data-kind][data-key]");if(!button)return;
      const field=button.dataset.kind==="category"?"excludedCategories":"excludedLocations";
      const set=new Set(filters[field]||[]);const key=button.dataset.key;
      if(set.has(key))set.delete(key);else set.add(key);
      filters[field]=[...set];render();await saveFilters();
    });
  }
  els.strictLocation.addEventListener("change",async ()=>{
    filters.strictLocation=els.strictLocation.checked;render();await saveFilters();
  });
  for(const field of ["websiteMode","phoneMode"]) {
    els[field].addEventListener("change",async ()=>{
      filters[field]=els[field].value;render();await saveFilters();
    });
  }
  els.targetLocation.addEventListener("input",()=>{
    filters.targetTouched=true;filters.targetLocation=els.targetLocation.value.trim();
    // Renderiza conteos y filas, sin reemplazar el texto bajo edición.
    render();
  });
  els.targetLocation.addEventListener("change",saveFilters);
  els.targetLocation.addEventListener("blur",saveFilters);
  els.country.addEventListener("change",async ()=>{
    settings.country=els.country.value;render();await saveSettings();
  });
  els.whatsappMessage.addEventListener("change",async ()=>{
    settings.whatsappMessage=els.whatsappMessage.value.slice(0,1000);
    await saveSettings();
    render();
  });
  els.limit.addEventListener("change",async ()=>{
    let v=Number.parseInt(els.limit.value,10);
    if(!Number.isFinite(v)||v<0)v=0;
    settings.limit=Math.min(100000,v);render();await saveSettings();
  });
  async function startSearchFromPopup() {
    const query=els.searchQuery.value.trim();
    if(!query) {message("Escribí qué negocio o categoría querés buscar.");return;}
    if(state.status==="running") {message("Esperá a que termine o detené la extracción actual.");return;}
    const mapsUrl=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    const sameSearch=rows().length>0 && util.norm(util.fromSearch(state.searchUrl))===util.norm(query);
    const key=sameSearch?state.searchKey:sourceKey(mapsUrl);
    if(rows().length&&state.searchKey&&state.searchKey!==key &&
      !confirm("Hay resultados de otra búsqueda. Descargá el CSV antes: esta búsqueda reemplazará los datos guardados. ¿Continuar?"))return;
    let limit=Number.parseInt(els.limit.value,10);
    if(!Number.isFinite(limit)||limit<0)limit=0;
    settings.limit=Math.min(100000,limit);
    settings.searchQuery=query;
    await saveSettings();
    if(filters.searchKey!==key) {filters=blankFilters(key);await saveFilters();}
    els.searchStart.disabled=true;
    message(`Abriendo Google Maps para “${query}” e iniciando la extracción…`);
    try {
      const result=await chrome.runtime.sendMessage({type:"GLCSV_SEARCH_AND_START",query,limit:settings.limit,country:settings.country||"auto"});
      if(!result?.ok)throw new Error(result?.error||"No se pudo abrir la búsqueda.");
      message("Búsqueda abierta. La extracción ya está en marcha en la nueva pestaña.");
      await readData();
    } catch(err) {
      await appendUiLog("error","No se pudo iniciar la búsqueda",{query,error:err.message||String(err)});
      render();message("Error al iniciar la búsqueda: "+(err.message||String(err)));
    }
  }
  els.searchStart.addEventListener("click",startSearchFromPopup);
  els.searchQuery.addEventListener("input",()=>{
    settings.searchQuery=els.searchQuery.value;
    els.searchStart.disabled=state.status==="running" || !els.searchQuery.value.trim();
  });
  els.searchQuery.addEventListener("keydown",event=>{
    if(event.key==="Enter") {event.preventDefault();startSearchFromPopup();}
  });
  els.resume.addEventListener("click",async ()=>{
    els.resume.disabled=true;
    message("Comprobando la pestaña de Maps y el progreso guardado…");
    try {
      const result=await chrome.runtime.sendMessage({type:"GLCSV_CONTINUE_SAVED"});
      if(!result?.ok)throw new Error(result?.error||"No se pudo continuar la extracción.");
      if(result.alreadyRunning)message("La extracción sigue activa en la pestaña de Maps.");
      else message("Extracción reanudada desde el último progreso guardado en Maps.");
      await readData();
    } catch(err) {await appendUiLog("error","No se pudo continuar la extracción",{error:err.message||String(err)});render();message("Error al continuar: "+(err.message||String(err)));}
    finally {els.resume.disabled=false;}
  });
  els.copyLog.addEventListener("click",async ()=>{
    const text=(Array.isArray(state.logs)?state.logs:[]).map(formatLog).join("\n")||"Sin eventos registrados.";
    els.logPanel.open=true;
    try {
      await navigator.clipboard.writeText(text);
      message("Log copiado al portapapeles.");
    } catch {
      els.logOutput.value=text;els.logOutput.focus();els.logOutput.select();
      const copied=document.execCommand("copy");
      els.logOutput.setSelectionRange(0,0);
      message(copied?"Log copiado al portapapeles.":"No se pudo copiar automáticamente; seleccioná el texto del log.");
    }
  });
  els.start.addEventListener("click",async ()=>{
    if(!pageSupported)return;
    try {
      let limit=Number.parseInt(els.limit.value,10);
      if(!Number.isFinite(limit)||limit<0)limit=0;
      settings.limit=Math.min(100000,limit);
      await saveSettings();
      const key=sourceKey(activeTab.url);
      if(rows().length&&state.searchKey&&state.searchKey!==key &&
        !confirm("Hay resultados de otra búsqueda. Descargar el CSV antes: iniciar esta búsqueda reemplazará los datos guardados. ¿Continuar?"))return;
      if(filters.searchKey!==key) {filters=blankFilters(key);await saveFilters();}
      els.start.disabled=true;
      const result=await send("GLCSV_START",{limit:settings.limit,country:settings.country,searchUrl:activeTab.url,tabId:activeTab.id});
      if(!result?.ok)throw new Error(result?.error||"Google no aceptó el inicio.");
      await readData();
    } catch(err){await appendUiLog("error","Error al iniciar en esta pestaña",{error:err.message||String(err)});render();message("Error: "+(err.message||String(err)));}
  });
  els.stop.addEventListener("click",async ()=>{
    try { const result=await chrome.runtime.sendMessage({type:"GLCSV_STOP_SAVED"});if(!result?.ok)throw new Error(result?.error||"No había extracción activa.");await readData(); }
    catch(err) {await appendUiLog("error","Error al detener extracción",{error:err.message||String(err)});message("Error al detener: "+(err.message||String(err)));}
  });
  els.download.addEventListener("click",async ()=>{
    try {
      const selected=includedRows();
      if(!selected.length) {message("No hay fichas que cumplan los filtros.");return;}
      const q=util.fromSearch(state.searchUrl)||"google_maps";
      const suffix=new Date().toISOString().slice(0,10);
      const blob=new Blob([buildCsv(selected)],{type:"text/csv;charset=utf-8"});
      const url=URL.createObjectURL(blob);
      try {
        await chrome.downloads.download({url,filename:`negocios_${fileSlug(q)}_${suffix}.csv`,saveAs:true,conflictAction:"uniquify"});
        message(`CSV preparado: ${selected.length} de ${rows().length} fichas. Excluidas: ${rows().length-selected.length}.`);
      } finally {setTimeout(()=>URL.revokeObjectURL(url),60000);}
    } catch(err) {message("Error al descargar: "+(err.message||String(err)));}
  });
  els.clear.addEventListener("click",async ()=>{
    if(state.status==="running") {message("Detené la extracción antes de borrar.");return;}
    if(rows().length&&!confirm("¿Borrar definitivamente las fichas guardadas? Las exclusiones de categorías y ciudades se pueden deshacer; este borrado completo no."))return;
    state=initial();filters=blankFilters("");
    await chrome.storage.local.set({[STATE_KEY]:state,[FILTER_KEY]:filters});
    render();
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=="local")return;
    if(changes[STATE_KEY]) {
      state=changes[STATE_KEY].newValue||initial();
      if(filters.searchKey!==state.searchKey)filters=blankFilters(state.searchKey);
    }
    if(changes[FILTER_KEY])filters=changes[FILTER_KEY].newValue||blankFilters(state.searchKey);
    if(changes[SETTINGS_KEY])settings={country:"auto",limit:0,whatsappMessage:"",...(changes[SETTINGS_KEY].newValue||{})};
    render();
  });
  Promise.all([currentTab(),readData()]).catch(err=>message("Error de Chrome: "+(err.message||String(err))));
})();
