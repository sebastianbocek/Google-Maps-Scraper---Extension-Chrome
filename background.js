/* global chrome */
'use strict';
importScripts('data_utils.js');

async function appendBackgroundLog(level,event,details={}) {
  const {glcsv_state:state={}}=await chrome.storage.local.get('glcsv_state');
  const logs=Array.isArray(state.logs)?state.logs:[];
  logs.push({time:new Date().toISOString(),level,event,details});
  state.logs=logs.slice(-200);
  state.updatedAt=Date.now();
  await chrome.storage.local.set({glcsv_state:state});
}

function searchSourceKey(url) {
  try {
    const parsed=new URL(url);
    return `${parsed.hostname}${parsed.pathname}?q=${parsed.searchParams.get('q')||parsed.searchParams.get('query')||''}&udm=${parsed.searchParams.get('udm')||''}`;
  } catch { return String(url||'').split('#')[0]; }
}

function supportedSearchUrl(url) {
  try {
    const parsed=new URL(url);
    const googleHost=/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname);
    return googleHost&&(parsed.pathname.startsWith('/maps')||(parsed.pathname==='/search'&&(parsed.searchParams.get('udm')==='local'||parsed.searchParams.get('tbm')==='lcl')));
  } catch { return false; }
}

function waitForTabComplete(tabId,timeoutMs=60000) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cleanup=()=>{
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const finish=(error,tab)=>{
      if(settled)return;
      settled=true;cleanup();
      if(error)reject(error);else resolve(tab);
    };
    const onUpdated=(id,changeInfo,tab)=>{
      if(id===tabId&&changeInfo.status==="complete")finish(null,tab);
    };
    const onRemoved=id=>{if(id===tabId)finish(new Error("La pestaña de Google Maps se cerró antes de cargar."));};
    const timer=setTimeout(()=>finish(new Error("Google Maps tardó demasiado en cargar.")),timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(tab=>{if(tab.status==="complete")finish(null,tab);}).catch(error=>finish(error));
  });
}

async function openMapsSearchAndStart(message) {
  const query=String(message.query||'').trim();
  if(!query)throw new Error('Escribí una búsqueda antes de comenzar.');
  const url=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  const tab=await chrome.tabs.create({url,active:true});
  if(tab.id==null)throw new Error('Chrome no pudo crear la pestaña de Google Maps.');
  await waitForTabComplete(tab.id);
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['data_utils.js','content.js']});
  const loadedTab=await chrome.tabs.get(tab.id);
  const finalKey=searchSourceKey(loadedTab.url||url);
  const {glcsv_filters:savedFilters}=await chrome.storage.local.get('glcsv_filters');
  if(savedFilters&&savedFilters.searchKey!==finalKey)
    await chrome.storage.local.set({glcsv_filters:{...savedFilters,searchKey:finalKey}});
  const result=await chrome.tabs.sendMessage(tab.id,{
    type:'GLCSV_START',
    limit:message.limit,
    country:message.country||'auto',
    searchUrl:loadedTab.url||url,
    tabId:tab.id
  });
  if(!result?.ok)throw new Error(result?.error||'Google Maps no pudo iniciar la extracción.');
  return {ok:true,tabId:tab.id};
}

async function continueSavedSearch() {
  const stored=await chrome.storage.local.get(['glcsv_state','glcsv_settings']);
  const state=stored.glcsv_state||{};
  const settings=stored.glcsv_settings||{};
  if(!state.searchUrl)throw new Error('Todavía no hay una búsqueda guardada para continuar.');
  let tab=null;
  if(Number.isInteger(state.tabId)) {
    try {
      const candidate=await chrome.tabs.get(state.tabId);
      if(supportedSearchUrl(candidate.url)&&searchSourceKey(candidate.url)===state.searchKey)tab=candidate;
    } catch {}
  }
  if(tab) {
    try {
      const ping=await chrome.tabs.sendMessage(tab.id,{type:'GLCSV_PING'});
      if(ping?.running) {
        await appendBackgroundLog('info','Continuación solicitada; la extracción sigue activa',{tabId:tab.id,rows:state.rows?.length||0});
        return {ok:true,alreadyRunning:true,tabId:tab.id};
      }
    } catch {}
  } else {
    tab=await chrome.tabs.create({url:state.searchUrl,active:false});
    if(tab.id==null)throw new Error('Chrome no pudo recuperar la pestaña de Maps.');
  }
  if(tab.status!=='complete')await waitForTabComplete(tab.id);
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['data_utils.js','content.js']});
  const result=await chrome.tabs.sendMessage(tab.id,{
    type:'GLCSV_START',
    limit:settings.limit??0,
    country:settings.country||'auto',
    searchUrl:state.searchUrl,
    tabId:tab.id
  });
  if(!result?.ok)throw new Error(result?.error||'No se pudo reanudar la extracción.');
  return {ok:true,tabId:tab.id};
}

async function stopSavedSearch() {
  const {glcsv_state:state={}}=await chrome.storage.local.get('glcsv_state');
  if(!state.searchUrl)throw new Error('No hay una extracción para detener.');
  let stillRunning=false;
  if(Number.isInteger(state.tabId)) {
    try {
      const result=await chrome.tabs.sendMessage(state.tabId,{type:'GLCSV_STOP'});
      stillRunning=Boolean(result?.ok&&result.running);
    } catch {}
  }
  const next={...state,status:stillRunning?'running':'paused',message:stillRunning?'Deteniendo extracción. El progreso quedó guardado.':'Extracción detenida. Puedes continuar desde el progreso guardado.',updatedAt:Date.now()};
  const logs=Array.isArray(next.logs)?next.logs:[];
  logs.push({time:new Date().toISOString(),level:'info',event:'Solicitud para detener la extracción',details:{tabId:state.tabId,stillRunning,rows:state.rows?.length||0}});
  next.logs=logs.slice(-200);
  await chrome.storage.local.set({glcsv_state:next});
  return {ok:true};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'GLCSV_SEARCH_AND_START') {
    openMapsSearchAndStart(message).then(respond).catch(async error=>{
      const messageText=String(error?.message||error);
      await appendBackgroundLog('error','No se pudo abrir Maps e iniciar la extracción',{query:String(message.query||''),error:messageText}).catch(()=>{});
      respond({ok:false,error:messageText});
    });
    return true;
  }
  if (message?.type === 'GLCSV_CONTINUE_SAVED') {
    continueSavedSearch().then(respond).catch(async error=>{
      const messageText=String(error?.message||error);
      await appendBackgroundLog('error','No se pudo reanudar la extracción',{error:messageText}).catch(()=>{});
      respond({ok:false,error:messageText});
    });
    return true;
  }
  if (message?.type === 'GLCSV_STOP_SAVED') {
    stopSavedSearch().then(respond).catch(async error=>{
      const messageText=String(error?.message||error);
      await appendBackgroundLog('error','No se pudo detener la extracción',{error:messageText}).catch(()=>{});
      respond({ok:false,error:messageText});
    });
    return true;
  }
  if (message?.type !== 'GLCSV_OPEN_WHATSAPP') return false;
  (async () => {
    const {glcsv_settings:config={}}=await chrome.storage.local.get('glcsv_settings');
    const util=globalThis.GLCSVUtil;
    const country=config.country||'auto';
    let number=util.normalizePhone(String(message.rawPhone||''),country,
      String(message.place||''),String(message.searchUrl||''));
    if(message.fixedArgentina && /^549\d{10}$/.test(number)) {
      number='54'+number.slice(3);
    } else if(message.fixedArgentina && /^54\d{10}$/.test(number)) {
      number='549'+number.slice(2);
    }
    if(!/^\d{8,15}$/.test(number)) {
      throw new Error('No pude identificar el país del teléfono. Elegí el país en la extensión e intentá otra vez.');
    }
    const url='https://web.whatsapp.com/send?phone='+number;
    // Crear siempre otra pestaña. Nunca navegar en la pestaña original de Maps.
    await chrome.tabs.create({url,active:true,...(sender.tab?.windowId != null ? {windowId:sender.tab.windowId}: {})});
    return {ok:true,phone:number};
  })().then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
  return true;
});
