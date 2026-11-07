/* Utilidades compartidas por el popup y el extractor. No envían datos a servidores. */
(() => {
  "use strict";
  if (globalThis.GLCSVUtil) return;
  const norm = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g," ").trim();
  const countryTable = [
    {dial:"595",name:"Paraguay", min:9,max:9},
    {dial:"598",name:"Uruguay", min:8,max:9},
    {dial:"591",name:"Bolivia", min:8,max:8},
    {dial:"593",name:"Ecuador", min:9,max:9},
    {dial:"502",name:"Guatemala",min:8,max:8},
    {dial:"507",name:"Panamá",min:8,max:8},
    {dial:"506",name:"Costa Rica",min:8,max:8},
    {dial:"549",name:"Argentina móvil",min:10,max:10},
    {dial:"54",name:"Argentina", min:10,max:11},
    {dial:"55",name:"Brasil",min:10,max:11},
    {dial:"56",name:"Chile",min:9,max:9},
    {dial:"51",name:"Perú",min:9,max:9},
    {dial:"57",name:"Colombia",min:10,max:10},
    {dial:"52",name:"México",min:10,max:10},
    {dial:"34",name:"España",min:9,max:9},
    {dial:"1",name:"EE. UU./Canadá",min:10,max:10}
  ];
  function inferCountry(place = "") {
    const p = norm(place);
    if (!p) return "";
    if (/\b(paraguay|itapua|encarnacion|alto parana|ciudad del este|asuncion|presidente franco|cambyreta|carmen del parana)\b/.test(p)) return "595";
    if (/\b(brasil|brazil|santa catarina|parana,? brasil|rio grande do sul|foz do iguacu|sao paulo|curitiba)\b/.test(p)) return "55";
    if (/\b(uruguay|montevideo|salto,? uruguay|rivera,? uruguay)\b/.test(p)) return "598";
    if (/\b(argentina|misiones|posadas|corrientes|resistencia|chaco|cordoba|buenos aires|puerto iguazu|apostoles|ober[aá]|eldorado|garupa|neuquen|mendoza|rosario|santa fe)\b/.test(p)) return "54";
    if (/\b(chile|santiago de chile)\b/.test(p)) return "56";
    if (/\b(bolivia|santa cruz de la sierra|la paz,? bolivia)\b/.test(p)) return "591";
    if (/\b(per[uú]|lima,? per[uú])\b/.test(p)) return "51";
    if (/\b(colombia|bogot[aá]|medellin)\b/.test(p)) return "57";
    if (/\b(m[eé]xico|mexico|cdmx)\b/.test(p)) return "52";
    if (/\b(espana|españa|madrid|barcelona)\b/.test(p)) return "34";
    if (/\b(united states|usa|estados unidos|canada|canad[aá])\b/.test(p)) return "1";
    return "";
  }
  function fromSearch(searchUrl = "") {
    try {
      const u = new URL(searchUrl);
      return u.searchParams.get("q") || u.searchParams.get("query") || decodeURIComponent(u.pathname.match(/\/maps\/search\/([^/?]+)/)?.[1] || "").replace(/\+/g," ");
    } catch { return ""; }
  }
  function cleanAddress(value) {
    let s = String(value ?? "").replace(/[\u200e\u200f\u202a-\u202e]/g," ").replace(/\s+/g," ").trim();
    s=s.replace(/^(?:direcci[oó]n|address|endere[cç]o|ubicaci[oó]n|location)\s*:\s*/i,"").replace(/\s*(?:copiar direcci[oó]n|copy address)\s*$/i, "").trim();
    return s.length > 4 && s.length < 220 && !/^(?:copiar|copy|compartir|share|editar)/i.test(s) ? s : "";
  }
  const provinces = /^(?:misiones|corrientes|chaco|formosa|entre r[ií]os|buenos aires|c[oó]rdoba|santa fe|itap[uú]a|alto paran[aá]|central|caaguaz[uú]|paraguar[ií]|santa catarina|paran[aá]|rio grande do sul|argentina|paraguay|brasil|brazil|uruguay|chile|bolivia|per[uú]|colombia|espa[nñ]a|m[eé]xico)$/i;
  function locality(address) {
    const s = cleanAddress(address);
    if (!s) return "";
    let chunks = s.split(/\s*,\s*/).filter(Boolean);
    if (chunks.length < 2) return "";
    // El último segmento suele ser país y/o provincia/estado.
    while (chunks.length > 1 && provinces.test(chunks[chunks.length - 1])) chunks.pop();
    let result = (chunks[chunks.length-1] || "").replace(/^(?:[A-Z]?\d{4,6}[A-Z]?|CP\s*\d{4,6})\s+/i, "").trim();
    // Una dirección con solo 'Calle, ciudad' admite la ciudad final.
    if (!result || /\d/.test(result) || /^(?:av\.?|avenida|calle|rua|ruta|r\.|street|blvd|boulevard|mariscal|general|gral\.)\b/i.test(result)) return "";
    if (result.length > 55 || result.split(" ").length > 6) return "";
    return result;
  }
  // Los prefijos explícitos (+595, 00595) son confiables. Sin '+' un 11
  // argentino/brasileño puede parecer el código +1, por eso consultamos país.
  function internationalDigits(raw, contextCountry = "") {
    const source=String(raw || "").trim();
    let digits=source.replace(/\D/g, "");
    if (!digits) return "";
    if (/^\s*\+/.test(source)) return /^\d{8,15}$/.test(digits) ? digits : "";
    if (/^\s*00/.test(source)) {
      digits=digits.slice(2);
      return /^\d{8,15}$/.test(digits) ? digits : "";
    }
    // +595 / +598 / +591 / +549 en formato internacional sin signo.
    // Códigos cortos como '1', '51', '54' o '55' necesitan contexto
    // o longitud inequívoca para no transformar teléfonos nacionales.
    const ordered=[...countryTable].sort((a,b)=>b.dial.length-a.dial.length);
    for(const c of ordered) {
      if (!digits.startsWith(c.dial)) continue;
      const rest=digits.length-c.dial.length;
      if (rest<c.min || rest>c.max) continue;
      const strong=["549","595","598","591","593","502","507","506"];
      const unambiguousLong=(c.dial==="55" || c.dial==="54") && digits.length>=12;
      if(strong.includes(c.dial) || unambiguousLong || (contextCountry && (c.dial===contextCountry || (contextCountry==="54" && c.dial==="549")))) return digits;
    }
    return "";
  }
  function normalizePhone(raw, country = "auto", place = "", searchUrl = "") {
    const source=String(raw || "").trim();
    let n=source.replace(/\D/g,"");
    if(n.length<8 || n.length>17) return "";
    const dial=country && country!=="auto" ? String(country) : inferCountry(place) || inferCountry(fromSearch(searchUrl));
    const international=internationalDigits(source,dial);
    if(international) return international;
    if (/^\s*(?:\+|00)/.test(source)) return "";
    if (!dial) return ""; // No asumir un país a partir de números locales.
    if (dial==="54") {
      // El código internacional 54 también puede venir sin '+'.
      if (/^54\d{10}$/.test(n)) return "54"+n.slice(2);
      if (/^549\d{10}$/.test(n)) return n;
      n=n.replace(/^0/, "");
      n=n.replace(/^(\d{2,4})15(?=\d{6,8}$)/, "$1");
      if (/^\d{10}$/.test(n)) return "549"+n;
      if (/^9\d{10}$/.test(n)) return "54"+n;
      return "";
    }
    n=n.replace(/^0+/, "");
    if (dial==="55" && /^\d{10,11}$/.test(n)) return "55"+n;
    if (dial==="595" && /^\d{8,10}$/.test(n)) return "595"+n;
    if (dial==="598" && /^\d{8,9}$/.test(n)) return "598"+n;
    if (/^\d{7,12}$/.test(n) && dial.length+n.length<=15) return dial+n;
    return "";
  }
  function whatsapp(raw, country="auto", place="", searchUrl="") {
    const number=normalizePhone(raw,country,place,searchUrl);
    return number ? `https://web.whatsapp.com/send?phone=${number}` : "";
  }
  function suggestedTarget(rows,searchUrl) {
    const query=norm(fromSearch(searchUrl));
    const groups=[...new Set((rows||[]).map(r=>r.location||locality(r.address)).filter(Boolean))];
    const matches=groups.filter(g => (" "+query+" ").includes(" "+norm(g)+" "));
    if(matches.length) return matches.sort((a,b)=>b.length-a.length)[0];
    // Si Google devuelve primero una ciudad limítrofe, el objetivo de la
    // búsqueda debe seguir siendo Posadas, y no la ciudad del primer resultado.
    const known=["posadas","encarnacion","apostoles","garupa","eldorado","obera",
      "puerto iguazu","corrientes","resistencia","asuncion","ciudad del este",
      "foz do iguacu","buenos aires","cordoba","rosario","mendoza","montevideo",
      "sao paulo","rio de janeiro","santiago","madrid","barcelona","lima"];
    const found=known.find(city=>(" "+query+" ").includes(" "+city+" "));
    if(found) return found.replace(/(^|\s)\w/g,c=>c.toUpperCase());
    const tail=query.match(/(?:\b(?:en|cerca de|near|in)\s+)([a-z\s]{3,45})$/);
    return tail ? tail[1].trim() : "";
  }
  globalThis.GLCSVUtil = Object.freeze({norm, inferCountry, fromSearch, cleanAddress, locality, normalizePhone, whatsapp, suggestedTarget});
})();
