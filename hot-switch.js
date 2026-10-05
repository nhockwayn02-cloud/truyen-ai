(()=>{
  'use strict';
  const KEY={mode:'xuong_model_mode',primary:'xuong_primary_model',secondary:'xuong_secondary_model'};
  const defaults={primary:'deepseek/deepseek-v4-flash',secondary:'aion-labs/aion-3.5-mini'};
  const get=k=>{try{return localStorage.getItem(k)||''}catch{return''}};
  const set=(k,v)=>{try{localStorage.setItem(k,v)}catch{}};
  let mode=get(KEY.mode)||'none';
  let primary=get(KEY.primary)||defaults.primary;
  let secondary=get(KEY.secondary)||defaults.secondary;
  const state=()=>({mode,primary,secondary});
  const nsfwModel=()=>{try{return String(document.getElementById('modelNsfwSelect')?.value||get('modelNsfw')||'').trim()}catch{return''}};
  const primaryModel=()=>{try{return String(document.getElementById('modelSelect')?.value||get('model')||primary||'').trim()}catch{return primary}};
  const messageText=b=>(Array.isArray(b?.messages)?b.messages:[]).map(m=>typeof m?.content==='string'?m.content:'').join('\n');
  const looksLikeLongChapter=b=>{const t=messageText(b).replace(/\s+/g,' ').trim();if(!t)return false;return !!(b?.longChapter||b?.chapterGeneration||b?.xLongChapter||(/\bchương\s*\d+\b/i.test(t)&&/(?:viết|soạn|tạo|sáng tác|tiếp tục|nội dung chương|tiểu thuyết)/i.test(t)&&/(?:độ\s*dài|thân\s*chương|mục tiêu|khoảng|từ)/i.test(t)&&t.length>1200));};
  const looksNsfwText=b=>/(?:nsfw|18\+|cảnh\s*(?:nóng|sex|18)|tình\s*dục|quan\s*hệ\s*tình\s*dục|cảnh\s*ân\s*ái|ân\s*ái|giao\s*hợp|erotic|erotica|porn|sex)/iu.test(messageText(b));
  const apply=(body)=>{
    const b=body&&typeof body==='object'?{...body}:body;
    if(!b||!Array.isArray(b.messages))return b;
    const p=primaryModel(),s=nsfwModel(),selected=String(b.model||'').trim();
    const explicitNsfw=!!(b.forceNsfw||b.nsfw||b.isNsfw||(selected&&s&&selected===s));
    if(explicitNsfw||looksNsfwText(b)){b.forceNsfw=true;b.nsfw=true;b.isNsfw=true;if(s){b.modelNsfw=s;b.nsfwModel=s;}}
    if(mode==='secondary'&&s&&!explicitNsfw)b.model=s;
    else if((mode==='primary'||mode==='auto')&&p&&!explicitNsfw)b.model=p;
    else if(!b.model&&p)b.model=p;
    b.xuongModelMode=mode;b.xuongPrimaryModel=p;b.xuongSecondaryModel=s;
    if(looksLikeLongChapter(b))b.xLongChapter=true;
    return b;
  };
  const applyJob=(body)=>{const b=body&&typeof body==='object'?{...body}:body;if(!b)return b;const p=primaryModel(),s=nsfwModel(),selected=String(b.model||'').trim();const explicit=!!(b.forceNsfw||b.nsfw||b.isNsfw||(s&&selected===s));if(explicit){b.forceNsfw=true;b.nsfw=true;b.isNsfw=true;if(s){b.modelNsfw=s;b.nsfwModel=s;b.model=s;}}else if(mode==='secondary'&&s)b.model=s;else if((mode==='primary'||mode==='auto')&&p)b.model=p;else if(!b.model&&p)b.model=p;b.modelMode=mode;b.primaryModel=p;b.secondaryModel=s;if(looksLikeLongChapter(b))b.xLongChapter=true;return b};
  const originalFetch=window.fetch.bind(window);
  window.fetch=async(input,init={})=>{
    let url=typeof input==='string'?input:(input&&input.url)||'';
    const method=String(init.method||'GET').toUpperCase();
    const isExternalOpenRouter=/https?:\/\/openrouter\.ai\/api\/v1\/chat\/completions(?:\?|$)/i.test(url);
    const isAI=url.includes('/api/ai');
    const isJob=/(\/api\/bg\/create-job|\/api\/create-job)(?:\?|$)/.test(url);
    const isLegacyCreate=/\/\.netlify\/functions\/create-job(?:\?|$)/i.test(url);
    const isLegacyStatus=/\/\.netlify\/functions\/job-status(?:\?|$)/i.test(url);
    if(isLegacyCreate||isLegacyStatus){
      const target=isLegacyCreate?'/api/create-job':'/api/job-status';
      if(isLegacyStatus&&method==='GET')return originalFetch(target+(url.includes('?')?url.slice(url.indexOf('?')):''),init);
      if(isLegacyCreate&&method==='POST'){
        let body=null;try{body=typeof init.body==='string'?JSON.parse(init.body):null}catch{}
        if(body){const out={...init,body:JSON.stringify(applyJob(body)),headers:{'Content-Type':'application/json',...(init.headers||{})}};return originalFetch(target,out)}
      }
      return originalFetch(input,init);
    }
    if(isExternalOpenRouter&&method==='POST'){
      let body=null;try{body=typeof init.body==='string'?JSON.parse(init.body):null}catch{}
      if(!body)return originalFetch(input,init);
      const b=apply(body);
      return originalFetch('/api/ai',{...init,body:JSON.stringify(b),headers:{'Content-Type':'application/json',...(init.headers||{})}});
    }
    if((!isAI&&!isJob)||method!=='POST')return originalFetch(input,init);
    let body=null;try{body=typeof init.body==='string'?JSON.parse(init.body):null}catch{}
    if(!body)return originalFetch(input,init);
    const make=(b,forceMode=mode)=>{const old=mode;mode=forceMode;const out={...init,body:JSON.stringify(isAI?apply(b):applyJob(b)),headers:{'Content-Type':'application/json',...(init.headers||{})}};mode=old;return out;};
    const first=await originalFetch(url,make(body));
    if(mode!=='auto'||first.ok||!secondary)return first;
    if(first.status!==408&&first.status!==409&&first.status!==425&&first.status!==429&&first.status<500)return first;
    return originalFetch(url,make(body,'secondary'));
  };
  function render(){
    if(document.getElementById('xuong-hot-switch'))return;
    const box=document.createElement('div');box.id='xuong-hot-switch';
    box.innerHTML=`<div class="xhs-title">MODE VIẾT</div><div class="xhs-row"><button data-m="primary">PRIMARY</button><button data-m="secondary">SECONDARY</button><button data-m="auto">AUTO</button><button data-m="none">NONE</button></div><div class="xhs-fields"><input id="xhs-primary" placeholder="Primary model"><input id="xhs-secondary" placeholder="Secondary / NSFW model"></div><div class="xhs-status"></div>`;
    const style=document.createElement('style');style.textContent=`#xuong-hot-switch{position:fixed;right:12px;bottom:12px;z-index:99999;background:#171922;color:#e8e8ec;border:1px solid #3a3f4e;border-radius:10px;padding:9px;width:min(360px,calc(100vw - 24px));box-shadow:0 10px 30px #0008;font:12px Inter,system-ui}.xhs-title{font-weight:700;margin-bottom:7px;color:#d9a441}.xhs-row{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.xhs-row button{background:#0c0d12;color:#ddd;border:1px solid #2a2e3a;border-radius:6px;padding:6px 3px;font-size:10px}.xhs-row button.on{border-color:#d9a441;color:#d9a441}.xhs-fields{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px}.xhs-fields input{width:100%;box-sizing:border-box;background:#0c0d12;color:#eee;border:1px solid #2a2e3a;border-radius:6px;padding:6px;font-size:10px}.xhs-status{margin-top:6px;color:#9a9dab;font-size:10px}`;document.head.appendChild(style);document.body.appendChild(box);
    const p=box.querySelector('#xhs-primary'),s=box.querySelector('#xhs-secondary'),status=box.querySelector('.xhs-status');p.value=primary;s.value=secondary;
    const refresh=()=>{box.querySelectorAll('[data-m]').forEach(b=>b.classList.toggle('on',b.dataset.m===mode));status.textContent=`Đang dùng: ${mode.toUpperCase()} · ${mode==='secondary'?secondary:mode==='primary'||mode==='auto'?primary:'model theo request'}`};
    box.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{mode=b.dataset.m;set(KEY.mode,mode);refresh()});
    p.onchange=()=>{primary=p.value.trim()||defaults.primary;set(KEY.primary,primary);refresh()};s.onchange=()=>{secondary=s.value.trim()||defaults.secondary;set(KEY.secondary,secondary);refresh()};refresh();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);else render();
  window.XuongModelSwitch={getState:state,setMode:m=>{mode=m;set(KEY.mode,m)}};
})();
