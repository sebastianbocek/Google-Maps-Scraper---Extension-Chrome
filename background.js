/* global chrome */
'use strict';
importScripts('data_utils.js');
const CAMPAIGN_KEY='glcsv_campaign';
const CAMPAIGN_LOG_KEY='glcsv_campaign_logs';
const MAPS_RELOAD_KEY='glcsv_maps_reload_recovery';
const debuggerWheelTabs=new Set();
const reloadResumeTabs=new Set();

chrome.debugger.onDetach.addListener(source=>{
  if(Number.isInteger(source.tabId))debuggerWheelTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener(tabId=>{
  if(!debuggerWheelTabs.has(tabId))return;
  debuggerWheelTabs.delete(tabId);
  chrome.debugger.detach({tabId}).catch(()=>{});
});

async function beginMapsWheelSession(sender) {
  const tabId=sender.tab?.id;
  if(!Number.isInteger(tabId))throw new Error('No pude identificar la pestaña de Google Maps para iniciar el scroll.');
  const tab=await chrome.tabs.get(tabId);
  const parsed=new URL(tab.url||sender.tab.url||'');
  const localSearch=parsed.pathname==='/search'&&['local','lcl'].includes(parsed.searchParams.get('udm')||parsed.searchParams.get('tbm'));
  if(!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)||(!parsed.pathname.startsWith('/maps')&&!localSearch))
    throw new Error('El scroll con rueda solo se habilita en la pestaña de resultados de Google Maps.');
  if(debuggerWheelTabs.has(tabId))return {ok:true,alreadyAttached:true};
  await chrome.debugger.attach({tabId},'1.3');
  debuggerWheelTabs.add(tabId);
  return {ok:true,tabId};
}

async function dispatchMapsWheel(message,sender) {
  const tabId=sender.tab?.id;
  if(!Number.isInteger(tabId)||!debuggerWheelTabs.has(tabId))
    throw new Error('La sesión de rueda de Google Maps no está activa.');
  const x=Number(message.x),y=Number(message.y);
  const deltas=(Array.isArray(message.deltas)?message.deltas:[message.deltaY]).map(Number);
  const tab=await chrome.tabs.get(tabId);
  if(![x,y,...deltas].every(Number.isFinite)||!deltas.length||deltas.length>5||deltas.some(delta=>delta===0)||x<0||y<0||x>(tab.width||10000)||y>(tab.height||10000))
    throw new Error('Las coordenadas o el desplazamiento de la rueda no son válidos.');
  const sent=[];
  for(const deltaY of deltas) {
    const step=Math.max(-450,Math.min(450,deltaY));
    await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{
      type:'mouseWheel',x,y,deltaX:0,deltaY:step,pointerType:'mouse'
    });
    sent.push(step);
    if(sent.length<deltas.length)await new Promise(resolve=>setTimeout(resolve,45));
  }
  return {ok:true,x,y,deltas:sent,totalDeltaY:sent.reduce((total,delta)=>total+delta,0)};
}

async function endMapsWheelSession(sender) {
  const tabId=sender.tab?.id;
  if(!Number.isInteger(tabId)||!debuggerWheelTabs.has(tabId))return {ok:true,alreadyDetached:true};
  debuggerWheelTabs.delete(tabId);
  await chrome.debugger.detach({tabId}).catch(()=>{});
  return {ok:true,tabId};
}

async function pauseInterruptedWork(reason) {
  const stored=await chrome.storage.local.get([CAMPAIGN_KEY,'glcsv_state']);
  const campaign=stored[CAMPAIGN_KEY];
  const state=stored.glcsv_state;
  const now=Date.now();
  const logEntry={time:new Date(now).toISOString(),level:'warn',event:'La extensión se recargó; progreso recuperable guardado',details:{reason}};
  const updates={};
  if(campaign&&['starting','running'].includes(campaign.status)) {
    updates[CAMPAIGN_KEY]={...campaign,status:'paused',message:'Chrome recargó la extensión durante la campaña. El progreso guardado está disponible; pulsa «Continuar campaña».',updatedAt:now};
  }
  if(state?.status==='running') {
    const logs=Array.isArray(state.logs)?state.logs:[];
    logs.push(logEntry);
    updates.glcsv_state={...state,status:'paused',message:'Chrome recargó la extensión. Los resultados guardados siguen disponibles; puedes continuar desde el progreso guardado.',logs:logs.slice(-200),updatedAt:now};
  } else if(updates[CAMPAIGN_KEY]&&state) {
    const logs=Array.isArray(state.logs)?state.logs:[];
    logs.push(logEntry);
    updates.glcsv_state={...state,logs:logs.slice(-200),updatedAt:now};
  }
  if(Object.keys(updates).length)await chrome.storage.local.set(updates);
}

chrome.runtime.onInstalled.addListener(details=>{
  if(details.reason==='update')pauseInterruptedWork('extension_update').catch(()=>{});
});
chrome.runtime.onStartup.addListener(()=>pauseInterruptedWork('browser_startup').catch(()=>{}));

async function appendBackgroundLog(level,event,details={}) {
  const stored=await chrome.storage.local.get(['glcsv_state',CAMPAIGN_LOG_KEY]);
  const state=stored.glcsv_state||{};
  const entry={time:new Date().toISOString(),level,event,details,...(details.campaignId?{campaignEvent:true}:{})};
  const logs=Array.isArray(state.logs)?state.logs:[];
  logs.push(entry);
  state.logs=logs.slice(-200);
  state.updatedAt=Date.now();
  const updates={glcsv_state:state};
  if(details.campaignId) {
    const campaignLogs=Array.isArray(stored[CAMPAIGN_LOG_KEY])?stored[CAMPAIGN_LOG_KEY]:[];
    campaignLogs.push(entry);
    updates[CAMPAIGN_LOG_KEY]=campaignLogs.slice(-5000);
  }
  await chrome.storage.local.set(updates);
}

function searchSourceKey(url) {
  try {
    const parsed=new URL(url);
    const query=parsed.searchParams.get('q')||parsed.searchParams.get('query')||decodeURIComponent(parsed.pathname.match(/\/maps\/search\/([^/]+)/)?.[1]||'');
    return query?`${parsed.hostname}/maps/search?q=${encodeURIComponent(query)}`:`${parsed.hostname}${parsed.pathname}?udm=${parsed.searchParams.get('udm')||''}`;
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

async function resumeAfterMapsReload(tabId) {
  if(reloadResumeTabs.has(tabId))return;
  reloadResumeTabs.add(tabId);
  try {
    const stored=await chrome.storage.local.get([MAPS_RELOAD_KEY,CAMPAIGN_KEY,'glcsv_state']);
    const marker=stored[MAPS_RELOAD_KEY];
    if(!marker||marker.tabId!==tabId)return;
    if(marker.resuming&&Date.now()-Number(marker.resumeStartedAt||0)<90000)return;
    const state=stored.glcsv_state||{};
    const campaign=stored[CAMPAIGN_KEY];
    if(marker.campaignId) {
      const activeItem=campaign?.queries?.[campaign.index];
      if(campaign?.id!==marker.campaignId||campaign.status==='paused'||activeItem?.query!==marker.campaignQuery) {
        await chrome.storage.local.remove(MAPS_RELOAD_KEY);
        return;
      }
    } else if(state.status!=='running') {
      await chrome.storage.local.remove(MAPS_RELOAD_KEY);
      return;
    }
    await chrome.storage.local.set({[MAPS_RELOAD_KEY]:{...marker,resuming:true,resumeStartedAt:Date.now()}});
    let tab=await chrome.tabs.get(tabId);
    if(!supportedSearchUrl(tab.url||''))throw new Error('La pestaña recargada ya no está en una búsqueda de Google Maps.');
    if(searchSourceKey(tab.url||'')!==marker.searchKey)
      throw new Error('La búsqueda cambió durante la recarga; no inicié otra consulta para proteger el progreso.');

    const expected=String(marker.expectedQuery||'').trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
    let ready=false,feedState=null;
    const readyDeadline=Date.now()+45000;
    while(Date.now()<readyDeadline) {
      try {
        const [result]=await chrome.scripting.executeScript({target:{tabId},func:()=>{
          const input=document.querySelector('input#searchboxinput,input[role="combobox"]');
          const query=String(input?.value||'').trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
          const cards=document.querySelectorAll('.VkpGBb,.Nv2PK,.THOPZb,div[role="article"],a.hfpxzc,.rllt__link,.dbg0pd').length;
          const text=(document.querySelector('div[role="feed"]')||document.body)?.innerText||'';
          const end=/no hay más resultados|no more results/i.test(text);
          return {hasSearch:Boolean(input),query,cards,end};
        }});
        feedState=result?.result||null;
        if(feedState?.hasSearch&&feedState.query===expected&&(feedState.cards>0||feedState.end)){ready=true;break;}
        if(feedState?.hasSearch&&feedState.query&&feedState.query!==expected)
          throw new Error(`Maps reabrió otra búsqueda («${feedState.query}»); se esperaba «${expected}».`);
      } catch(error) {
        if(String(error?.message||error).includes('se esperaba'))throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!ready) {
      if(!feedState?.hasSearch||feedState.query!==expected)
        throw new Error('Maps no restauró el cuadro de búsqueda esperado después de 45 segundos.');
      await appendBackgroundLog('warn','Maps recargó, pero todavía no mostró tarjetas ni el marcador final; se reanuda para que el escáner siga esperando',{
        campaignId:marker.campaignId||undefined,query:marker.expectedQuery,feedState
      });
    }

    tab=await chrome.tabs.get(tabId);
    await chrome.scripting.executeScript({target:{tabId},files:['data_utils.js','content.js']});
    const startMessage={
      type:'GLCSV_START',limit:marker.limit??0,country:marker.country||'auto',
      parallelTabs:marker.parallelTabs??5,searchUrl:tab.url||marker.searchUrl,tabId,
      campaignId:marker.campaignId||'',campaignQuery:marker.campaignQuery||''
    };
    const result=await chrome.tabs.sendMessage(tabId,startMessage);
    if(!result?.ok)throw new Error(result?.error||'El scraper no aceptó la reanudación después de recargar Maps.');
    await chrome.storage.local.remove(MAPS_RELOAD_KEY);
    if(marker.campaignId) {
      const latest=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
      if(latest?.id===marker.campaignId&&latest.status!=='paused')
        await chrome.storage.local.set({[CAMPAIGN_KEY]:{...latest,tabId,status:'running',message:`Reanudando ${latest.queries[latest.index]?.label||'la búsqueda actual'} después de recuperar Maps…`,updatedAt:Date.now()}});
    }
    await appendBackgroundLog('info','Maps recargó y la extracción se reanudó automáticamente',{
      campaignId:marker.campaignId||undefined,query:marker.expectedQuery,tabId,
      preservedRows:state.rows?.length||0,alreadyInspected:state.inspectedIds?.length||0,
      pendingDetails:state.pendingDetails?.length||0,scrollTopBeforeReload:marker.scrollTop
    });
  } catch(error) {
    const message=String(error?.message||error);
    await appendBackgroundLog('error','No se pudo reanudar automáticamente después de recargar Maps',{
      tabId,error:message
    }).catch(()=>{});
    const stored=await chrome.storage.local.get([MAPS_RELOAD_KEY,CAMPAIGN_KEY,'glcsv_state']);
    const marker=stored[MAPS_RELOAD_KEY];
    if(marker?.tabId===tabId) {
      await chrome.storage.local.remove(MAPS_RELOAD_KEY);
      const state=stored.glcsv_state||{};
      const logs=Array.isArray(state.logs)?state.logs:[];
      logs.push({time:new Date().toISOString(),level:'error',event:'Reanudación automática tras recargar Maps falló',details:{error:message}});
      await chrome.storage.local.set({glcsv_state:{...state,status:'paused',message:`Maps se recargó, pero el scraper no pudo reanudarse: ${message}. El progreso guardado sigue disponible.`,logs:logs.slice(-200),updatedAt:Date.now()}});
      const campaign=stored[CAMPAIGN_KEY];
      if(marker.campaignId&&campaign?.id===marker.campaignId&&campaign.status!=='paused')
        await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status:'paused',message:`La recuperación automática de Maps falló: ${message}. Puedes continuar desde el progreso guardado.`,updatedAt:Date.now()}});
    }
  } finally {
    reloadResumeTabs.delete(tabId);
  }
}

chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(changeInfo.status!=='complete')return;
  chrome.storage.local.get(MAPS_RELOAD_KEY).then(stored=>{
    if(stored[MAPS_RELOAD_KEY]?.tabId===tabId)resumeAfterMapsReload(tabId);
  }).catch(()=>{});
});

async function enrichPlaceInWorkerTab(row) {
  const url=String(row?.businessUrl||'');
  let parsed;
  try {parsed=new URL(url);} catch {throw new Error('La ficha no tiene una URL válida de Google Maps.');}
  if(!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)||!parsed.pathname.startsWith('/maps/'))
    throw new Error('La URL de detalle no pertenece a una ficha pública de Google Maps.');
  let lastError;
  for(let attempt=1;attempt<=2;attempt++) {
    let tabId=null;
    try {
      const tab=await chrome.tabs.create({url,active:false});
      tabId=tab.id;
      if(tabId==null)throw new Error('Chrome no pudo abrir la ficha en segundo plano.');
      await waitForTabComplete(tabId,35000);
      await chrome.scripting.executeScript({target:{tabId},files:['data_utils.js','content.js']});
      const result=await chrome.tabs.sendMessage(tabId,{type:'GLCSV_DETAIL_EXTRACT',row});
      if(!result?.ok)throw new Error(result?.error||'No se pudieron leer los datos de la ficha.');
      return result.row;
    } catch(error) {
      lastError=error;
    } finally {
      if(tabId!=null)await chrome.tabs.remove(tabId).catch(()=>{});
    }
  }
  throw lastError||new Error('No se pudieron leer los datos de la ficha.');
}

async function openMapsSearchAndStart(message) {
  const query=String(message.query||'').trim();
  if(!query)throw new Error('Escribí una búsqueda antes de comenzar.');
  const url=`https://www.google.com/maps/search/${encodeURIComponent(query)}`;
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
    parallelTabs:message.parallelTabs??5,
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
  await appendBackgroundLog('info','Iniciando búsqueda de ciudad',{
    campaignId:current.id,index:current.index+1,total:current.queries.length,
    location:item.label,query:item.query
  });
  const url=`https://www.google.com/maps/search/${encodeURIComponent(item.query)}`;
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
    const sameSearch=searchSourceKey(tab.url||'')===searchSourceKey(url);
    let visibleMapsQuery='';
    if(resumeSameQuery&&supportedSearchUrl(tab.url||'')) {
      try {
        const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>document.querySelector('input#searchboxinput,input[role="combobox"]')?.value||''});
        visibleMapsQuery=String(result?.result||'').trim();
      } catch {}
    }
    const normalizeQuery=value=>String(value||'').trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
    const placePage=/\/maps\/place\//i.test(new URL(tab.url||url).pathname);
    const keepCurrentMapsState=resumeSameQuery&&supportedSearchUrl(tab.url||'')&&
      (sameSearch||(placePage&&normalizeQuery(visibleMapsQuery)===normalizeQuery(item.query)));
    if(resumeSameQuery&&supportedSearchUrl(tab.url||'')&&!sameSearch&&!keepCurrentMapsState)
      await appendBackgroundLog('warn','La pestaña tenía otra búsqueda; restaurando la consulta de la campaña',{
        campaignId:current.id,location:item.label,expectedQuery:item.query,visibleMapsQuery,url:tab.url
      });
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
    parallelTabs:beforeStart.parallelTabs??5,
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
  const requestedParallelTabs=Number.parseInt(message.parallelTabs,10);
  const campaign={id,business,country:message.country||'AR',queries,index:0,status:'starting',message:`Preparando ${queries[0].label} (1 de ${queries.length})…`,limit:Number(message.limit)||0,phoneCountry:message.phoneCountry||'auto',parallelTabs:Number.isFinite(requestedParallelTabs)?Math.max(1,Math.min(20,requestedParallelTabs)):5,tabId:null,createdAt:Date.now(),updatedAt:Date.now()};
  await chrome.storage.local.set({[CAMPAIGN_KEY]:campaign});
  try {return await launchCampaignQuery(campaign);}
  catch(error) {
    const latest=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY]||campaign;
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...latest,status:'paused',message:`Error al iniciar la campaña: ${error.message||error}`,updatedAt:Date.now()}});
    throw error;
  }
}

async function finishCampaignQuery(message) {
  const pendingReload=(await chrome.storage.local.get(MAPS_RELOAD_KEY))[MAPS_RELOAD_KEY];
  if(pendingReload?.campaignId===message.campaignId&&pendingReload.campaignQuery===message.campaignQuery)
    return {ok:true,reloading:true};
  const campaign=(await chrome.storage.local.get(CAMPAIGN_KEY))[CAMPAIGN_KEY];
  if(!campaign||campaign.id!==message.campaignId||campaign.status==='paused'||campaign.status==='complete')return {ok:true,ignored:true};
  if(message.campaignQuery&&campaign.queries[campaign.index]?.query!==message.campaignQuery)return {ok:true,ignored:true,stale:true};
  if(message.reason==='manual'||message.reason==='error') {
    const status='paused';
    const label=campaign.queries[campaign.index]?.label||'la ubicación actual';
    const text=message.reason==='manual'?`Campaña pausada en ${label}. Podés continuar desde ahí.`:`La búsqueda de ${label} tuvo un error. La campaña quedó pausada y se puede continuar.`;
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status,message:text,updatedAt:Date.now()}});
    await appendBackgroundLog(message.reason==='error'?'error':'warn',message.reason==='error'?'Ciudad pausada por error':'Ciudad pausada manualmente',{
      campaignId:campaign.id,index:campaign.index+1,total:campaign.queries.length,
      location:label,reason:message.reason,rows:message.rows||0,endMarkerConfirmed:Boolean(message.endMarkerConfirmed)
    });
    return {ok:true,paused:true};
  }
  const currentItem=campaign.queries[campaign.index];
  const currentLabel=currentItem?.label||'ubicación actual';
  const confirmedEnd=Boolean(message.endMarkerConfirmed&&['complete','limit'].includes(message.reason));
  const emptyViewAdvance=message.reason==='empty-view'&&!message.endMarkerConfirmed;
  if(!confirmedEnd&&!emptyViewAdvance) {
    const text=`La búsqueda de ${currentLabel} no confirmó “No hay más resultados”; no se avanzó a otra ciudad. Podés continuar desde aquí.`;
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status:'paused',message:text,updatedAt:Date.now()}});
    await appendBackgroundLog('error','Avance de ciudad bloqueado: falta confirmar el marcador de fin',{
      campaignId:campaign.id,index:campaign.index+1,total:campaign.queries.length,
      location:currentLabel,reason:message.reason,rows:message.rows||0,
      endMarkerConfirmed:Boolean(message.endMarkerConfirmed)
    });
    return {ok:true,paused:true,blocked:true};
  }
  await appendBackgroundLog(emptyViewAdvance?'warn':'info',emptyViewAdvance?
    'Ciudad sin lista recuperable; se avanza tras dos intentos':'Ciudad completada: Google Maps confirmó el fin de resultados',{
      campaignId:campaign.id,index:campaign.index+1,total:campaign.queries.length,
      location:currentLabel,query:currentItem?.query,reason:message.reason,
      endMarkerConfirmed:Boolean(message.endMarkerConfirmed),advancedWithoutEndMarker:emptyViewAdvance,
      rows:message.rows||0
    });
  const nextIndex=campaign.index+1;
  if(nextIndex>=campaign.queries.length) {
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...campaign,status:'complete',index:campaign.index,message:`Campaña completa: ${campaign.queries.length} ubicaciones procesadas.`,updatedAt:Date.now()}});
    await appendBackgroundLog('info',emptyViewAdvance?
      'Campaña completa; la última ciudad avanzó tras quedarse sin lista recuperable':
      'Campaña completa: todas las ciudades terminaron con marcador confirmado',{
      campaignId:campaign.id,total:campaign.queries.length,finalLocation:currentLabel,
      finalCityEndMarkerConfirmed:Boolean(message.endMarkerConfirmed)
    });
    return {ok:true,complete:true};
  }
  const nextItem=campaign.queries[nextIndex];
  await appendBackgroundLog('info','Avance automático a la siguiente ciudad',{
    campaignId:campaign.id,fromIndex:campaign.index+1,toIndex:nextIndex+1,
    total:campaign.queries.length,from:currentLabel,to:nextItem.label,
    reason:emptyViewAdvance?'Lista no recuperable tras dos intentos':'No hay más resultados confirmado',
    endMarkerConfirmed:Boolean(message.endMarkerConfirmed),advancedWithoutEndMarker:emptyViewAdvance,rows:message.rows||0
  });
  const next={...campaign,index:nextIndex,status:'starting',message:`${emptyViewAdvance?'Lista de Maps no recuperable. ':''}Siguiente: ${campaign.queries[nextIndex].label} (${nextIndex+1} de ${campaign.queries.length})…`,updatedAt:Date.now()};
  await chrome.storage.local.set({[CAMPAIGN_KEY]:next});
  try {return await launchCampaignQuery(next);}
  catch(error) {
    await chrome.storage.local.set({[CAMPAIGN_KEY]:{...next,status:'paused',message:`Error al abrir ${next.queries[nextIndex].label}: ${error.message||error}. Podés continuar.`,updatedAt:Date.now()}});
    return {ok:false,error:String(error.message||error)};
  }
}

async function reloadMapsForRecovery(message,sender) {
  const tabId=sender.tab?.id;
  if(!Number.isInteger(tabId))throw new Error('No pude identificar la pestaña de Maps que se debe recuperar.');
  const tab=await chrome.tabs.get(tabId);
  if(!supportedSearchUrl(tab.url||''))throw new Error('La pestaña actual ya no muestra una búsqueda compatible de Google Maps.');
  const params=message.params||{};
  const searchUrl=String(params.searchUrl||tab.url||'');
  if(searchSourceKey(searchUrl)!==searchSourceKey(tab.url||''))
    throw new Error('La URL cambió antes de guardar la recarga; no se modificó la búsqueda.');
  const stored=await chrome.storage.local.get([CAMPAIGN_KEY,'glcsv_state']);
  const state=stored.glcsv_state||{};
  const campaign=stored[CAMPAIGN_KEY];
  if(params.campaignId) {
    const activeItem=campaign?.queries?.[campaign.index];
    if(campaign?.id!==params.campaignId||campaign.status==='paused'||activeItem?.query!==params.campaignQuery)
      throw new Error('La campaña se pausó o cambió de ciudad antes de la recuperación.');
  } else if(state.status!=='running'||state.tabId!==tabId) {
    throw new Error('La extracción ya no está activa en esta pestaña.');
  }
  const marker={
    tabId,searchUrl,searchKey:searchSourceKey(searchUrl),expectedQuery:String(params.expectedQuery||''),
    limit:Math.max(0,Number(params.limit)||0),country:String(params.country||'auto'),
    parallelTabs:Math.max(1,Math.min(20,Number(params.parallelTabs)||5)),
    campaignId:String(params.campaignId||''),campaignQuery:String(params.campaignQuery||''),
    scrollTop:Math.max(0,Number(params.scrollTop)||0),createdAt:Date.now(),resuming:false
  };
  await chrome.storage.local.set({[MAPS_RELOAD_KEY]:marker});
  await appendBackgroundLog('warn','Recarga automática de Maps programada para destrabar el feed',{
    campaignId:marker.campaignId||undefined,query:marker.expectedQuery,tabId,
    rows:state.rows?.length||0,inspected:state.inspectedIds?.length||0,
    pendingDetails:state.pendingDetails?.length||0,scrollTop:marker.scrollTop,url:searchUrl
  });
  await endMapsWheelSession({tab:{id:tabId}});
  await chrome.tabs.reload(tabId,{bypassCache:false});
  return {ok:true,reloading:true,tabId};
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
  const {glcsv_settings:settings={}}=await chrome.storage.local.get('glcsv_settings');
  const requestedParallelTabs=Number.parseInt(settings.parallelTabs,10);
  const next={...campaign,parallelTabs:Number.isFinite(requestedParallelTabs)?Math.max(1,Math.min(20,requestedParallelTabs)):campaign.parallelTabs??5,status:'starting',message:`Continuando ${campaign.queries[campaign.index]?.label||'la búsqueda actual'}…`,updatedAt:Date.now()};
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
    parallelTabs:settings.parallelTabs??5,
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
  if(message?.type==='GLCSV_WHEEL_BEGIN') {
    beginMapsWheelSession(sender).then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type==='GLCSV_WHEEL') {
    dispatchMapsWheel(message,sender).then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type==='GLCSV_WHEEL_END') {
    endMapsWheelSession(sender).then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(message?.type==='GLCSV_MAPS_RELOAD_RECOVERY') {
    reloadMapsForRecovery(message,sender).then(respond).catch(async error=>{
      const messageText=String(error?.message||error);
      await appendBackgroundLog('error','No se pudo programar la recuperación de Maps por recarga',{tabId:sender.tab?.id,error:messageText}).catch(()=>{});
      respond({ok:false,error:messageText});
    });
    return true;
  }
  if(message?.type==='GLCSV_ENRICH_DETAIL') {
    enrichPlaceInWorkerTab(message.row).then(row=>respond({ok:true,row})).catch(async error=>{
      const messageText=String(error?.message||error);
      await appendBackgroundLog('warn','No se pudo enriquecer una ficha en segundo plano',{name:message.row?.name||'',error:messageText}).catch(()=>{});
      respond({ok:false,error:messageText});
    });
    return true;
  }
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
