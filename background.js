/* global chrome */
'use strict';
importScripts('data_utils.js');

chrome.runtime.onMessage.addListener((message, sender, respond) => {
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
