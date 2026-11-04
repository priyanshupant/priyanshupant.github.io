'use strict';

// This edition intentionally never sends user code or project assets to a server.
const $ = id => document.getElementById(id);
const DB_NAME = 'manim-studio-pages-v1';
const STORE = 'projects';
const MAX_ASSET = 30 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ZIP = 64 * 1024 * 1024;
const MAX_JSON = 16 * 1024 * 1024;
const MAX_FILES = 1000;
const QUALITY = {'480p':[864,486,15], '720p':[1280,720,30], '1080p':[1920,1080,60], '4K':[3840,2160,60]};
const SNIPPETS = {
  text: 'label = Text("Hello, Manim!", font_size=42)\nself.play(Write(label))\n',
  math: 'equation = MathTex(r"f(x) = x^2")\nself.play(Write(equation))\n',
  axes: 'axes = Axes(x_range=[-3, 3, 1], y_range=[0, 9, 1], tips=False)\ncurve = axes.plot(lambda x: x**2, x_range=[-3, 3], color=TEAL)\nself.play(Create(axes), Create(curve))\n',
  shape: 'circle = Circle(color=BLUE)\nself.play(Create(circle))\n',
  transform: 'new_label = Text("Next step")\nself.play(Transform(label, new_label))\n',
  wait: 'self.wait(1)\n',
  pause: 'self.next_slide()  # advance during presentation\n',
  asset: 'image = ImageMobject(str(ASSETS_DIR / "diagram.png"))\nself.play(FadeIn(image))\n'
};

let db = null;
let projects = [];
let current = null;
let slideId = null;
let setupEditor = null;
let slideEditor = null;
let muted = false;
let dirty = false;
let saveTimer = null;
let pendingWrite = Promise.resolve();

function status(message, error) {
  $('saveStatus').textContent = message;
  $('saveStatus').classList.toggle('error', !!error);
}
function notice(message, error) {
  const node = $('notice');
  node.textContent = message;
  node.classList.toggle('error', !!error);
  node.hidden = !message;
}
function errorMessage(err) {
  notice(err && err.message ? err.message : String(err), true);
  status('Please check the message above', true);
}
function id() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('');
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('This browser does not support local project storage.'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, {keyPath:'id'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the browser database.'));
  });
}
function dbRequest(mode, method, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = tx.objectStore(STORE)[method](...(value === undefined ? [] : [value]));
    let answer;
    req.onsuccess = () => {answer = req.result;};
    tx.oncomplete = () => resolve(answer);
    tx.onerror = () => reject(tx.error || new Error('Browser storage failed. Export your work as a ZIP.'));
    tx.onabort = () => reject(tx.error || new Error('Browser storage was interrupted.'));
  });
}
async function refreshProjects() {
  projects = (await dbRequest('readonly', 'getAll')).sort((a,b) => (b.updated_at || 0) - (a.updated_at || 0));
}
function simpleProject(name) {
  return {
    id:id(), revision:1, updated_at:Date.now()/1000,
    name:name, setup:'# Manim and Slide are imported automatically.\nconfig.background_color = "#101114"\n',
    slides:[{id:id(),title:'First slide',enabled:true,code:'title = Text("Hello, Manim!", font_size=48)\nself.play(Write(title))\nself.wait(0.5)\n'}],
    quality:'480p',aspect_ratio:'16:9',advance_key:'right',assets:[]
  };
}
function sampleProject() {
  const p=simpleProject('My first Manim presentation');
  p.slides.push({id:id(),title:'Second slide',enabled:true,code:'self.play(Transform(title, Text("Your second slide", font_size=42)))\nself.wait(0.5)\n'});
  return p;
}
function currentSlide() {
  return current && current.slides.find(s => s.id === slideId);
}
function markDirty() {
  if (!current || muted) return;
  dirty = true;
  status('Unsaved changes');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow().catch(errorMessage), 450);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!current || !dirty) return pendingWrite;
  if (!current.name.trim()) {
    current.name = 'Untitled project';
    $('projectName').value = current.name;
  }
  const snapshot = structuredClone(current);
  snapshot.revision = (snapshot.revision || 0) + 1;
  snapshot.updated_at = Date.now()/1000;
  current.revision = snapshot.revision;
  current.updated_at = snapshot.updated_at;
  dirty = false;
  status('Saving locally…');
  const writingId = snapshot.id;
  pendingWrite = pendingWrite.catch(() => {}).then(() => dbRequest('readwrite', 'put', snapshot));
  try {
    await pendingWrite;
    const index = projects.findIndex(p => p.id === writingId);
    if (index >= 0) projects[index] = snapshot;
    else projects.push(snapshot);
    projects.sort((a,b) => (b.updated_at || 0) - (a.updated_at || 0));
    if (current && current.id === writingId && !dirty) status('Saved in this browser');
  } catch (err) {
    // Retain the in-memory data for an immediate backup attempt.
    if (current && current.id === writingId) dirty = true;
    throw err;
  }
}
function makeEditor(element, onChange) {
  if (window.CodeMirror) {
    const cm = CodeMirror.fromTextArea(element, {
      mode:'python',lineNumbers:true,indentUnit:4,tabSize:4,indentWithTabs:false,
      autoCloseBrackets:true,extraKeys:{
        Tab: cm => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end'),
        'Ctrl-S': () => saveNow().catch(errorMessage),
        'Cmd-S': () => saveNow().catch(errorMessage)
      }
    });
    cm.on('change', () => {if (!muted) onChange(cm.getValue());});
    return cm;
  }
  element.addEventListener('input', () => {if (!muted) onChange(element.value);});
  return {
    getValue: () => element.value,
    setValue: v => {element.value=v;},
    replaceSelection: s => {const a=element.selectionStart,b=element.selectionEnd;element.setRangeText(s,a,b,'end');element.dispatchEvent(new Event('input'));},
    focus: () => element.focus(),
    refresh: () => {}
  };
}
function setEditors(setup, code) {
  muted = true;
  setupEditor.setValue(setup || '');
  slideEditor.setValue(code || '');
  muted = false;
  setupEditor.refresh();
  slideEditor.refresh();
}
function listButton(label, detail, selected, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'list-item';
  button.setAttribute('aria-current', String(!!selected));
  const name = document.createElement('span');
  name.textContent = label;
  button.append(name);
  if (detail) {const small=document.createElement('small');small.textContent=detail;button.append(small);}
  button.addEventListener('click', () => Promise.resolve(action()).catch(errorMessage));
  return button;
}
function renderProjects() {
  const box=$('projectList');box.replaceChildren();
  if (!projects.length) {const p=document.createElement('p');p.className='empty-list';p.textContent='No projects yet';box.append(p);}
  projects.forEach(p => box.append(listButton(p.name,p.slides.length+' slide'+(p.slides.length===1?'':'s'),current && p.id===current.id,() => openProject(p.id))));
}
function renderSlides() {
  const box=$('slideList');box.replaceChildren();
  if (!current) return;
  current.slides.forEach((s,i) => box.append(listButton('Slide '+(i+1),s.enabled===false?'Excluded from Compile All':'Included',s.id===slideId,() => selectSlide(s.id))));
}
function renderAssets() {
  const box=$('assetList');box.replaceChildren();
  if (!current || !(current.assets || []).length) {
    const p=document.createElement('p');p.className='help';p.textContent='No assets uploaded.';box.append(p);return;
  }
  (current.assets || []).forEach(asset => {
    const row=document.createElement('div');row.className='asset-row';
    const name=document.createElement('span');name.textContent=asset.name;name.title=asset.name;
    const insert=document.createElement('button');insert.type='button';insert.className='button small';insert.textContent='Insert';
    insert.onclick=() => insertText('str(ASSETS_DIR / '+JSON.stringify(asset.name)+')');
    const remove=document.createElement('button');remove.type='button';remove.className='button small danger';remove.textContent='×';remove.title='Remove asset';
    remove.onclick=() => {if (confirm('Remove '+asset.name+' from this project?')) {current.assets=current.assets.filter(a=>a.name!==asset.name);markDirty();renderAssets();}};
    row.append(name,insert,remove);box.append(row);
  });
}
function selectSlide(nextId) {
  if (!current) return;
  const slide=current.slides.find(s=>s.id===nextId);
  if (!slide) return;
  slideId=nextId;
  muted=true;
  slideEditor.setValue(slide.code);
  $('slideEnabled').checked=slide.enabled!==false;
  $('slideNumber').textContent='SLIDE '+(current.slides.indexOf(slide)+1)+' OF '+current.slides.length;
  muted=false;
  slideEditor.refresh();
  renderSlides();
  $('moveUp').disabled=current.slides.indexOf(slide)===0;
  $('moveDown').disabled=current.slides.indexOf(slide)===current.slides.length-1;
  $('deleteSlide').disabled=current.slides.length<=1;
  $('duplicateSlide').disabled=current.slides.length>=100;
  $('addSlide').disabled=current.slides.length>=100;
}
async function openProject(projectId) {
  if (current && current.id===projectId) return;
  await saveNow();
  const p=projects.find(p=>p.id===projectId);
  if (!p) throw new Error('Project not found.');
  current=structuredClone(p);
  if (!Array.isArray(current.assets)) current.assets=[];
  dirty=false;
  $('editor').hidden=false;
  $('welcome').hidden=true;
  muted=true;
  $('projectName').value=current.name;
  $('quality').value=current.quality==='low'?'480p':current.quality==='high'?'1080p':current.quality;
  $('aspect').value=current.aspect_ratio || '16:9';
  setupEditor.setValue(current.setup||'');
  selectSlide(current.slides[0].id);
  muted=false;
  renderProjects();
  renderAssets();
  status('Saved in this browser');
}
async function createProject(name) {
  const trimmed=(name||'').trim();
  if (!trimmed || trimmed.length>160) throw new Error('Project names must be 1–160 characters.');
  await saveNow();
  const p=simpleProject(trimmed);
  await dbRequest('readwrite','put',p);
  await refreshProjects();
  current=null;
  await openProject(p.id);
  notice('Project created. Your edits save automatically in this browser.');
}
function insertText(text) {
  if (!currentSlide()) return;
  slideEditor.replaceSelection(text);
  slideEditor.focus();
}
function addSlide(duplicate) {
  if (!current) return;
  if (current.slides.length>=100) return notice('A project can contain at most 100 slides.',true);
  const old=currentSlide(), at=current.slides.indexOf(old);
  const slide=duplicate ? {...structuredClone(old),id:id()} : {id:id(),title:'',code:'# Write your next animation here.\n',enabled:true};
  current.slides.splice(at+1,0,slide);
  markDirty();selectSlide(slide.id);
}
function moveSlide(direction) {
  const n=current.slides.findIndex(s=>s.id===slideId);
  const j=n+direction;
  if (n<0 || j<0 || j>=current.slides.length) return;
  const temp=current.slides[n];current.slides[n]=current.slides[j];current.slides[j]=temp;
  markDirty();selectSlide(slideId);
}
function deleteSlide() {
  if (!current || current.slides.length<=1) return;
  const index=current.slides.findIndex(s=>s.id===slideId);
  if (!confirm('Delete slide '+(index+1)+'? You can restore it from a previously exported project ZIP.')) return;
  current.slides.splice(index,1);
  markDirty();selectSlide(current.slides[Math.min(index,current.slides.length-1)].id);
}
async function deleteProject() {
  if (!current) return;
  if (!confirm('Permanently delete "'+current.name+'" from this browser? Export a backup first if needed.')) return;
  clearTimeout(saveTimer);
  await pendingWrite.catch(()=>{});
  const doomed=current.id;current=null;dirty=false;
  await dbRequest('readwrite','delete',doomed);
  await refreshProjects();
  if (projects.length) await openProject(projects[0].id);
  else {$('editor').hidden=true;$('welcome').hidden=false;renderProjects();renderSlides();}
  notice('Project deleted from this browser.');
}
function validateProject(raw) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Invalid project data.');
  if (typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>160) throw new Error('Invalid project name.');
  if (typeof raw.setup!=='string'||raw.setup.length>500000) throw new Error('Invalid Shared Setup.');
  if (!Array.isArray(raw.slides)||!raw.slides.length||raw.slides.length>100) throw new Error('A project must have 1–100 slides.');
  const ids=new Set();
  const slides=raw.slides.map(s => {
    if (!s || typeof s.id!=='string'||!/^[a-f0-9]{32}$/i.test(s.id)||ids.has(s.id)) throw new Error('Invalid or duplicate slide ID.');
    ids.add(s.id);
    if (typeof s.code!=='string'||s.code.length>500000||typeof s.title!=='string'||s.title.length>160) throw new Error('Invalid slide code.');
    if (s.enabled!==undefined&&typeof s.enabled!=='boolean') throw new Error('Invalid slide compile switch.');
    return {id:s.id,title:s.title,code:s.code,enabled:s.enabled!==false};
  });
  const quality=raw.quality==='low'?'480p':raw.quality==='high'?'1080p':raw.quality;
  if (!QUALITY[quality]) throw new Error('Unknown project quality setting.');
  if (raw.aspect_ratio && !['4:3','16:9'].includes(raw.aspect_ratio)) throw new Error('Unknown slide format.');
  if (raw.advance_key && !['left','right'].includes(raw.advance_key)) throw new Error('Unknown advance key.');
  return {name:raw.name.trim(),setup:raw.setup,slides,quality,
    aspect_ratio:raw.aspect_ratio||'16:9',advance_key:raw.advance_key||'right'};
}
function validAssetName(name) {
  return typeof name==='string' && name.length>0 && name.length<=1024 &&
    !name.startsWith('/') && !name.includes('\\') && !name.includes(':') &&
    !/[\x00-\x1f\x7f]/.test(name) &&
    name.split('/').every(part=>part && part!=='.' && part!=='..' && new TextEncoder().encode(part).length<=240);
}
function slimProject() {
  const p=current;
  return {name:p.name,setup:p.setup,slides:p.slides.map(s=>({id:s.id,title:s.title||'',code:s.code,enabled:s.enabled!==false})),
    quality:p.quality,aspect_ratio:p.aspect_ratio,advance_key:p.advance_key||'right'};
}
function download(blob, name) {
  const link=document.createElement('a');
  const url=URL.createObjectURL(blob);
  link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function slug(name) {return (name.replace(/[^a-z0-9._-]+/gi,'-').replace(/^[._-]+|[._-]+$/g,'').slice(0,80)||'manim-project');}
async function exportZip() {
  if (!current) return;
  if (!window.JSZip) throw new Error('ZIP library did not load. Check your internet connection and reload.');
  await saveNow();
  const payload=JSON.stringify(slimProject(),null,2);
  if (new Blob([payload]).size>MAX_JSON) throw new Error('Project JSON exceeds 16 MiB.');
  const assets=current.assets||[];
  if (assets.length+2>MAX_FILES || assets.reduce((n,a)=>n+a.blob.size,0)>MAX_TOTAL) throw new Error('Project assets exceed ZIP size limits.');
  const zip=new JSZip();
  zip.file('manifest.json',JSON.stringify({format:'manim-studio-project',version:1},null,2));
  zip.file('project.json',payload);
  for (const a of assets) zip.file('assets/'+a.name,a.blob);
  status('Preparing project ZIP…');
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
  if (blob.size>MAX_ZIP) throw new Error('Compressed ZIP exceeds the 64 MiB limit. Remove large assets.');
  download(blob,slug(current.name)+'.zip');
  status('Saved in this browser');
  notice('Project ZIP downloaded. Import it using the desktop Manim Studio.');
}
async function importZip(file) {
  if (!window.JSZip) throw new Error('ZIP library did not load. Check your internet connection and reload.');
  if (file.size>MAX_ZIP) throw new Error('ZIP file exceeds 64 MiB.');
  const zip=await JSZip.loadAsync(file,{checkCRC32:true});
  const paths=Object.keys(zip.files);
  if (paths.length>MAX_FILES) throw new Error('The ZIP contains too many entries.');
  const keys=new Set();
  let total=0;
  for (const path of paths) {
    const entry=zip.files[path];
    const filename=entry.dir?path.slice(0,-1):path;
    if (!validAssetName(filename)) throw new Error('Unsafe path in ZIP: '+path);
    if (filename!=='manifest.json' && filename!=='project.json' &&
        filename!=='assets' && !filename.startsWith('assets/')) throw new Error('Unexpected ZIP member: '+path);
    const key=filename.normalize('NFD').toLowerCase();
    if (keys.has(key)) throw new Error('Duplicate ZIP member: '+path);
    keys.add(key);
    const size=Number(entry._data && entry._data.uncompressedSize || 0);
    if (size>MAX_ASSET && !['project.json','manifest.json'].includes(filename)) throw new Error('ZIP asset exceeds 30 MiB.');
    total+=size;
    if (total>MAX_TOTAL) throw new Error('ZIP expands beyond 256 MiB.');
  }
  if (!zip.file('manifest.json') || !zip.file('project.json')) throw new Error('Not a Manim Studio project ZIP.');
  const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
  if (manifest.format!=='manim-studio-project' || manifest.version!==1) throw new Error('Unsupported Manim Studio project ZIP format.');
  const rawText=await zip.file('project.json').async('string');
  if (new Blob([rawText]).size>MAX_JSON) throw new Error('Project JSON exceeds 16 MiB.');
  const imported=validateProject(JSON.parse(rawText));
  const assets=[];
  for (const path of paths) {
    const entry=zip.files[path];
    if (entry.dir || !path.startsWith('assets/')) continue;
    const name=path.slice('assets/'.length);
    if (!validAssetName(name)) throw new Error('Invalid asset filename.');
    const blob=await entry.async('blob');
    if (blob.size>MAX_ASSET) throw new Error('One asset exceeds 30 MiB.');
    assets.push({name,blob});
  }
  if (assets.reduce((n,a)=>n+a.blob.size,0)>MAX_TOTAL) throw new Error('Imported assets are too large.');
  await saveNow();
  const p={...imported,id:id(),revision:1,updated_at:Date.now()/1000,assets};
  await dbRequest('readwrite','put',p);
  await refreshProjects();
  current=null;
  await openProject(p.id);
  notice('Imported "'+p.name+'" with '+p.slides.length+' slide(s) and '+assets.length+' asset(s).');
}
function exportPython() {
  if (!current) return;
  const slides=current.slides.filter(s=>s.enabled!==false);
  if (!slides.length) throw new Error('All slides are excluded from Compile All.');
  const quality=QUALITY[current.quality]||QUALITY['480p'];
  const width=current.aspect_ratio==='4:3' ? quality[1]*4/3 : quality[0];
  const source=[
    '# Generated by Manim Studio (GitHub Pages edition).',
    '# To render: manim scene.py StudioScene',
    '# For Manim Slides playback: manim-slides present StudioScene',
    'from manim import *',
    'from manim_slides import Slide',
    'from pathlib import Path',
    '',
    'ASSETS_DIR = Path(__file__).parent / "assets"',
    '',
    current.setup||'',
    '',
    '# Project slide format and quality',
    'config.pixel_width = '+width,
    'config.pixel_height = '+quality[1],
    'config.frame_rate = '+quality[2],
    'config.frame_width = config.frame_height * '+width+' / '+quality[1],
    '',
    'class StudioScene(Slide):',
    '    def construct(self):'
  ];
  slides.forEach((s,i)=>{
    source.push('        # Slide '+(current.slides.indexOf(s)+1));
    for (const line of s.code.replace(/\r\n/g,'\n').split('\n')) source.push(line ? '        '+line : '');
    source.push('        self.next_slide()');
    source.push('');
  });
  download(new Blob([source.join('\n')+'\n'],{type:'text/x-python;charset=utf-8'}),'scene.py');
  notice('Python scene downloaded. A local Manim installation is required for rendering.');
}
async function uploadAssets(files) {
  if (!current) return;
  let total=(current.assets||[]).reduce((n,a)=>n+a.blob.size,0);
  for (const file of Array.from(files)) {
    if (!validAssetName(file.name) || file.name.includes('/')) throw new Error('Invalid filename: '+file.name);
    if (file.size>MAX_ASSET) throw new Error(file.name+' is over the 30 MiB per-file limit.');
    const replaced=current.assets.find(a=>a.name===file.name);
    if (replaced && !confirm('Replace the existing "'+file.name+'" asset?')) continue;
    total=total-(replaced?replaced.blob.size:0)+file.size;
    if (total>MAX_TOTAL) throw new Error('Project assets exceed 256 MiB.');
    current.assets=current.assets.filter(a=>a.name!==file.name);
    current.assets.push({name:file.name,blob:file.slice(0,file.size,file.type)});
  }
  markDirty();renderAssets();notice('Asset(s) added. They will be included in your next ZIP export.');
}
async function start() {
  db=await openDatabase();
  setupEditor=makeEditor($('setupCode'),value=>{if (current){current.setup=value;markDirty();}});
  slideEditor=makeEditor($('slideCode'),value=>{const s=currentSlide();if(s){s.code=value;markDirty();}});
  $('newProject').onclick=()=>{const name=prompt('New project name','Untitled project');if(name!==null)createProject(name).catch(errorMessage);};
  $('welcomeNew').onclick=()=>$('newProject').click();
  $('importButton').onclick=()=>$('importFile').click();
  $('importFile').onchange=async event=>{const file=event.target.files[0];if(!file)return;status('Importing ZIP…');try{await importZip(file);}catch(err){errorMessage(err);}finally{event.target.value='';if(current&&!dirty)status('Saved in this browser');}};
  $('exportButton').onclick=()=>exportZip().catch(errorMessage);
  $('pythonButton').onclick=()=>{try{exportPython();}catch(err){errorMessage(err);}};
  $('addSlide').onclick=()=>addSlide(false);
  $('duplicateSlide').onclick=()=>addSlide(true);
  $('moveUp').onclick=()=>moveSlide(-1);
  $('moveDown').onclick=()=>moveSlide(1);
  $('deleteSlide').onclick=deleteSlide;
  $('deleteProject').onclick=()=>deleteProject().catch(errorMessage);
  $('projectName').oninput=e=>{if(current){current.name=e.target.value;markDirty();}};
  $('projectName').onblur=()=>{if(current&&!current.name.trim()){current.name='Untitled project';$('projectName').value=current.name;markDirty();}renderProjects();};
  $('renameProject').onclick=()=>{$('projectName').focus();$('projectName').select();};
  $('quality').onchange=e=>{if(current){current.quality=e.target.value;markDirty();}};
  $('aspect').onchange=e=>{if(current){current.aspect_ratio=e.target.value;markDirty();}};
  $('slideEnabled').onchange=e=>{const s=currentSlide();if(s){s.enabled=e.target.checked;markDirty();renderSlides();}};
  $('insertSnippet').onclick=()=>insertText(SNIPPETS[$('snippets').value]||'');
  $('uploadAsset').onclick=()=>$('assetInput').click();
  $('assetInput').onchange=event=>{uploadAssets(event.target.files).catch(errorMessage);event.target.value='';};
  document.addEventListener('keydown',e=>{
    if ((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s') {
      e.preventDefault();saveNow().catch(errorMessage);
    }
  });
  window.addEventListener('beforeunload',e=>{
    if (dirty) {e.preventDefault();e.returnValue='';}
  });
  await refreshProjects();
  let seenBefore=false;
  try {seenBefore=localStorage.getItem('manimStudioPagesInitialized')==='1';} catch (_) {}
  if (!projects.length && !seenBefore) {
    const demo=sampleProject();
    await dbRequest('readwrite','put',demo);
    await refreshProjects();
    notice('Example project created. Changes are stored only in this browser.');
  }
  try {localStorage.setItem('manimStudioPagesInitialized','1');} catch (_) {}
  if (projects.length) await openProject(projects[0].id);
  else {$('editor').hidden=true;$('welcome').hidden=false;renderProjects();renderSlides();status('Ready to create a project');}
}
document.addEventListener('DOMContentLoaded',()=>start().catch(errorMessage));
