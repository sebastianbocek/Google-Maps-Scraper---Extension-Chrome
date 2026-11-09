/* global chrome */
'use strict';
importScripts('data_utils.js');
const CAMPAIGN_KEY='glcsv_campaign';

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

async function launchCampaignQuery(campaign) {
  const current=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!current||current.id!==campaign.id||current.status==='paused')return {ok:true,paused:true};
  const item=current.queries[current.index];
  if(!item)throw new Error('No quedan ubicaciones en la campaña.');
  const url=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.query)}`;
  const {glcsv_state:savedState={}}=await chrome.storage.local.get('glcsv_state');
  // Al abrir una ficha, Maps cambia /maps/search/ por /maps/place/ aunque la
  // lista y su posición sigan vivas en la pestaña. Al reanudar la misma query,
  // conservar esa pestaña permite seguir desde el último resultado procesado.
  const resumeSameQuery=savedState.campaignId===current.id&&
    savedState.campaignQuery===item.query&&Array.isArray(savedState.inspectedIds);
  let tab=null;
  if(Number.isInteger(current.tabId)) {
    try {tab=await chrome.tabs.get(current.tabId);} catch {}
  }
  if(tab) {
    const keepCurrentMapsState=resumeSameQuery&&supportedSearchUrl(tab.url||'');
    const sameSearch=searchSourceKey(tab.url||'')===searchSourceKey(url);
    await chrome.tabs.update(tab.id,{...((sameSearch||keepCurrentMapsState)?{}:{url}),active:false});
    if(keepCurrentMapsState) {
      await appendBackgroundLog('info','Reanudando campaña en la pestaña y posición guardadas',{
        campaignId:current.id,query:item.query,tabId:tab.id,
        inspected:savedState.inspectedIds.length,rows:savedState.rows?.length||0
      });
    }
  } else {
    tab=await chrome.tabs.create({url,active:current.index===0});
  }
  if(tab.id==null)throw new Error('Chrome no pudo abrir Google Maps para la campaña.');
  const beforeWait=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!beforeWait||beforeWait.id!==current.id||beforeWait.status==='paused')return {ok:true,paused:true,tabId:tab.id};
  await chrome.storage.local.set({[CAMPAIGN_KEY]:{...beforeWait,tabId:tab.id,status:'starting',message:`Abriendo ${item.label} (${current.index+1} de ${current.queries.length})…`,updatedAt:Date.now()}});
  await waitForTabComplete(tab.id);
  const latest=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!latest||latest.id!==current.id||latest.status==='paused')return {ok:true,paused:true,tabId:tab.id};
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['data_utils.js','content.js']});
  const beforeStart=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!beforeStart||beforeStart.id!==current.id||beforeStart.status==='paused')return {ok:true,paused:true,tabId:tab.id};
  const result=await chrome.tabs.sendMessage(tab.id,{
    type:'GLCSV_START',limit:beforeStart.limit,country:beforeStart.phoneCountry||'auto',
    searchUrl:(await chrome.tabs.get(tab.id)).url||url,tabId:tab.id,campaignId:beforeStart.id,campaignQuery:item.query
  });
  if(!result?.ok)throw new Error(result?.error||`No se pudo iniciar la búsqueda de ${item.label}.`);
  const finalCampaign=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(finalCampaign?.id===beforeStart.id&&finalCampaign.status!=='paused')await chrome.storage.local.set({[CAMPAIGN_KEY]:{...finalCampaign,status:'running',message:`Buscando ${item.label} (${beforeStart.index+1} de ${beforeStart.queries.length})…`,updatedAt:Date.now()}});
  else if(finalCampaign?.id===beforeStart.id&&finalCampaign.status==='paused')await chrome.tabs.sendMessage(tab.id,{type:'GLCSV_STOP'}).catch(()=>{});
  return {ok:true,tabId:tab.id,index:beforeStart.index};
}

async function startCampaign(message) {
  const business=String(message.business||'').trim();
  const queries=(Array.isArray(message.queries)?message.queries:[])
    .map(item=>({label:String(item?.label||'').trim(),query:String(item?.query||'').trim()}))
    .filter(item=>item.label&&item.query).slice(0,500);
  if(!business)throw new Error('Escribí un rubro o negocio para la campaña.');
  if(!queries.length)throw new Error('Elegí al menos una provincia o una búsqueda nacional.');
  const id=`campaign-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  const campaign={id,business,country:message.country||'AR',queries,index:0,status:'starting',message:`Preparando ${queries[0].label} (1 de ${queries.length})…`,limit:Number(message.limit)||0,phoneCountry:message.phoneCountry||'auto',tabId:null,createdAt:Date.now(),updatedAt:Date.now()};
  await chrome.storage.local.set({[CAMPAIGN_KEY]:campaign});
  try {return await launchCampaignQuery(campaign);}
  catch(error) {
    const latest=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY]||campaign;
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...latest,status:'paused',message:`Error al iniciar la campaña: ${error.message||error}`,updatedAt:Date.now()}});
    throw error;
  }
}

async function finishCampaignQuery(message) {
  const campaign=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!campaign||campaign.id!==message.campaignId||campaign.status==='paused'||campaign.status==='complete')return {ok:true,ignored:true};
  if(message.campaignQuery&&campaign.queries[campaign.index]?.query!==message.campaignQuery)return {ok:true,ignored:true,stale:true};
  if(message.reason==='manual'||message.reason==='error') {
    const status='paused';
    const label=campaign.queries[campaign.index]?.label||'la ubicación actual';
    const text=message.reason==='manual'?`Campaña pausada en ${label}. Podés continuar desde ahí.`:`La búsqueda de ${label} tuvo un error. La campaña quedó pausada y se puede continuar.`;
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status,message:text,updatedAt:Date.now()}});
    return {ok:true,paused:true};
  }
  const nextIndex=campaign.index+1;
  if(nextIndex>=campaign.queries.length) {
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status:'complete',index:campaign.index,message:`Campaña completa: ${campaign.queries.length} ubicaciones procesadas.`,updatedAt:Date.now()}});
    return {ok:true,complete:true};
  }
  const next={...campaign,index:nextIndex,status:'starting',message:`Ubicación terminada. Siguiente: ${campaign.queries[nextIndex].label} (${nextIndex+1} de ${campaign.queries.length})…`,updatedAt:Date.now()};
  await chrome.storage.local.set({[CAMPAIGN_KEY]:next});
  try {return await launchCampaignQuery(next);}
  catch(error) {
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...next,status:'paused',message:`Error al abrir ${next.queries[nextIndex].label}: ${error.message||error}. Podés continuar.`,updatedAt:Date.now()}});
    return {ok:false,error:String(error.message||error)};
  }
}

async function pauseCampaign() {
  const campaign=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!campaign||!['starting','running'].includes(campaign.status))throw new Error('No hay una campaña activa para pausar.');
  await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status:'paused',message:'Pausando campaña…',updatedAt:Date.now()}});
  if(Number.isInteger(campaign.tabId)) {
    try {await chrome.tabs.sendMessage(campaign.tabId,{type:'GLCSV_STOP'});} catch {}
  }
  const latest=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(latest?.id===campaign.id&&latest.status==='paused')await chrome.storage.local.set({[CAMPAIGN_KEY]:{...latest,message:`Campaña pausada en ${campaign.queries[campaign.index]?.label||'la ubicación actual'}. Podés continuar desde ahí.`,updatedAt:Date.now()}});
  return {ok:true};
}

async function continueCampaign() {
  const campaign=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!campaign||campaign.status!=='paused')throw new Error('No hay una campaña pausada para continuar.');
  const next={...campaign,status:'starting',message:`Continuando ${campaign.queries[campaign.index]?.label||'la búsqueda actual'}…`,updatedAt:Date.now()};
  await chrome.storage.local.set({[CAMPAIGN_KEY]:next});
  try {return await launchCampaignQuery(next);}
  catch(error) {
    const latest=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY]||next;
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...latest,status:'paused',message:`Error al continuar: ${error.message||error}`,updatedAt:Date.now()}});
    throw error;
  }
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
  if (message?.type === 'GLCSV_CAMPAIGN_START') {
    startCampaign(message).then(respond).catch(async error=>{
      const messageText=String(error?.message||error);
      await appendBackgroundLog('error','No se pudo iniciar la búsqueda por ciudades',{error:messageText}).catch(()=>{});
      respond({ok:false,error:messageText});
    });
    return true;
  }
  if (message?.type === 'GLCSV_CAMPAIGN_PAUSE') {
    pauseCampaign().then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if (message?.type === 'GLCSV_CAMPAIGN_CONTINUE') {
    continueCampaign().then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if (message?.type === 'GLCSV_CAMPAIGN_QUERY_FINISHED') {
    finishCampaignQuery(message).then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
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
