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
  const apply=(body)=>{
    const b=body&&typeof body==='object'?{...body}:body;
    if(!b||!Array.isArray(b.messages))return b;
    const m=mode==='secondary'?secondary:mode==='primary'||mode==='auto'?primary:'';
    if(m) b.model=m;
    b.xuongModelMode=mode;
    b.xuongPrimaryModel=primary;
    b.xuongSecondaryModel=secondary;
    return b;
  };
  const originalFetch=window.fetch.bind(window);
  window.fetch=async(input,init={})=>{
    const url=typeof input==='string'?input:(input&&input.url)||'';
    if(!url.includes('/api/ai')||!init||String(init.method||'GET').toUpperCase()!=='POST')return originalFetch(input,init);
    let body=null;try{body=typeof init.body==='string'?JSON.parse(init.body):null}catch{}
    if(!body)return originalFetch(input,init);
    const make=(b,forceMode=mode)=>{const old=mode;mode=forceMode;const out={...init,body:JSON.stringify(apply(b)),headers:{'Content-Type':'application/json',...(init.headers||{})}};mode=old;return out};
    const first=await originalFetch(input,make(body));
    if(mode!=='auto'||first.ok||!secondary)return first;
    if(first.status!==408&&first.status!==409&&first.status!==425&&first.status!==429&&first.status<500)return first;
    return originalFetch(input,make(body,'secondary'));
  };
  function render(){
    if(document.getElementById('xuong-hot-switch'))return;
    const box=document.createElement('div');box.id='xuong-hot-switch';
    box.innerHTML=`<div class="xhs-title">MODE VIẾT</div><div class="xhs-row"><button data-m="primary">PRIMARY</button><button data-m="secondary">SECONDARY</button><button data-m="auto">AUTO</button><button data-m="none">NONE</button></div><div class="xhs-fields"><input id="xhs-primary" placeholder="Primary model"><input id="xhs-secondary" placeholder="Secondary model"></div><div class="xhs-status"></div>`;
    const style=document.createElement('style');style.textContent=`#xuong-hot-switch{position:fixed;right:12px;bottom:12px;z-index:99999;background:#171922;color:#e8e8ec;border:1px solid #3a3f4e;border-radius:10px;padding:9px;width:min(360px,calc(100vw - 24px));box-shadow:0 10px 30px #0008;font:12px Inter,system-ui}.xhs-title{font-weight:700;margin-bottom:7px;color:#d9a441}.xhs-row{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.xhs-row button{background:#0c0d12;color:#ddd;border:1px solid #2a2e3a;border-radius:6px;padding:6px 3px;font-size:10px}.xhs-row button.on{border-color:#d9a441;color:#d9a441}.xhs-fields{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px}.xhs-fields input{width:100%;box-sizing:border-box;background:#0c0d12;color:#eee;border:1px solid #2a2e3a;border-radius:6px;padding:6px;font-size:10px}.xhs-status{margin-top:6px;color:#9a9dab;font-size:10px}`;document.head.appendChild(style);document.body.appendChild(box);
    const p=box.querySelector('#xhs-primary'),s=box.querySelector('#xhs-secondary'),status=box.querySelector('.xhs-status');p.value=primary;s.value=secondary;
    const refresh=()=>{box.querySelectorAll('[data-m]').forEach(b=>b.classList.toggle('on',b.dataset.m===mode));status.textContent=`Đang dùng: ${mode.toUpperCase()} · ${mode==='secondary'?secondary:mode==='primary'||mode==='auto'?primary:'model theo request'}`};
    box.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{mode=b.dataset.m;set(KEY.mode,mode);refresh()});
    p.onchange=()=>{primary=p.value.trim()||defaults.primary;set(KEY.primary,primary);refresh()};s.onchange=()=>{secondary=s.value.trim()||defaults.secondary;set(KEY.secondary,secondary);refresh()};refresh();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);else render();
  window.XuongModelSwitch={getState:state,setMode:m=>{mode=m;set(KEY.mode,m)}};
})();
