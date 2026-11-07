/* global chrome, GLCSVUtil */
(() => {
  "use strict";
  if (globalThis.__GLCSV_QUICK_WHATSAPP__) return;
  globalThis.__GLCSV_QUICK_WHATSAPP__ = true;

  // Alt + clic sobre teléfonos visibles en fichas de Google Local y Maps.
  // No interfiere con el clic normal, el extractor ni otros enlaces de la página.
  const PHONE_CHARS = /^[+\d\s().\-\u00a0\u2010-\u2015\u2212]+$/u;
  const PREFIX = /^(?:tel[eé]fono|telefone|telephone|phone|tel\.?|llamar|call|ligar)\s*:?\s*/i;
  const PHONE_ARIA = /(?:tel[eé]fono|telefone|telephone|phone|llamar|call|ligar)/i;
  const ADDRESS_SELECTOR = '[data-item-id="address"],[data-item-id^="address:"],[aria-label^="Dirección:" i],[aria-label^="Address:" i],[aria-label^="Endereço:" i]';

  function asPhone(input) {
    if (typeof input !== 'string') return '';
    const value=input.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim().replace(PREFIX,'').trim();
    const digits=value.replace(/\D/g,'');
    return value.length <= 80 && PHONE_CHARS.test(value) && digits.length>=8 && digits.length<=15 ? value : '';
  }
  function attrPhone(element) {
    const href=element.getAttribute('href') || '';
    if (/^tel:/i.test(href)) {
      let value=href.slice(4).split(/[;?]/,1)[0];
      try {value=decodeURIComponent(value);} catch (_) {}
      if (asPhone(value)) return asPhone(value);
    }
    const id=element.getAttribute('data-item-id')||'';
    if (id.startsWith('phone:tel:') && asPhone(id.slice(10))) return asPhone(id.slice(10));
    const aria=element.getAttribute('aria-label')||'';
    if (PHONE_ARIA.test(aria)) {
      const match=aria.match(/\+?\d[\d\s().\-]{6,}\d/);
      if (match && asPhone(match[0])) return asPhone(match[0]);
    }
    return '';
  }
  function clickedPhone(node) {
    if (!(node instanceof Element)) return '';
    if (node.closest('#glcsv-float,input,textarea,select,[contenteditable="true"],[role="textbox"]')) return '';
    let el=node;
    for(let level=0; el && level<12 && el!==document.body; el=el.parentElement,level++) {
      const attr=attrPhone(el);
      if(attr)return attr;
      // Evita recoger una dirección/valoración que contenga números.
      const text=el.textContent?.trim()||'';
      if (text.length<=80 && asPhone(text)) return asPhone(text);
    }
    return '';
  }
  function locationHint(target) {
    // Priorizar la dirección del panel al que pertenece el teléfono clickeado.
    // Es fundamental cuando aparecen resultados de Encarnación en una búsqueda de Posadas.
    let current=target;
    for (let steps=0;current && steps<18;current=current.parentElement,steps++) {
      if (current === document.body) break;
      const nodes=[...current.querySelectorAll(ADDRESS_SELECTOR)];
      if (nodes.length!==1) continue;
      for (const value of [nodes[0].innerText, nodes[0].getAttribute('aria-label')]) {
        const cleaned=globalThis.GLCSVUtil?.cleanAddress(value);
        if(cleaned && (cleaned.includes(',') || globalThis.GLCSVUtil?.inferCountry(cleaned))) return cleaned;
      }
    }
    // Si la página contiene una única ficha activa, su dirección alcanza.
    const visible=[...document.querySelectorAll(ADDRESS_SELECTOR)]
      .filter(el=>el.getClientRects().length>0);
    if(visible.length===1) {
      return globalThis.GLCSVUtil?.cleanAddress(visible[0].innerText||visible[0].getAttribute('aria-label'))||'';
    }
    return '';
  }
  function toast(message) {
    let el=document.getElementById('glcsv-wa-notice');
    if (!el) {
      el=document.createElement('div');el.id='glcsv-wa-notice';
      Object.assign(el.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:'2147483647',
        background:'#153c33',color:'#fff',padding:'10px 14px',font:'13px Arial,sans-serif',
        borderRadius:'9px',maxWidth:'350px',boxShadow:'0 7px 22px #0003'});
      document.documentElement.appendChild(el);
    }
    el.textContent=message;
    setTimeout(()=>el?.remove(),4300);
  }
  document.addEventListener('click', event=> {
    if (!event.isTrusted || !event.altKey || event.button!==0 || event.ctrlKey || event.metaKey) return;
    const phone=clickedPhone(event.target);
    if(!phone)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    chrome.runtime.sendMessage({
      type:'GLCSV_OPEN_WHATSAPP',rawPhone:phone,place:locationHint(event.target),
      searchUrl:location.href, fixedArgentina:!!event.shiftKey
    }, response=>{
      if(chrome.runtime.lastError || !response?.ok) {
        toast(response?.error || 'No se pudo abrir WhatsApp. Verificá el país en la extensión.');
      }
    });
  },true);
})();
