'use strict';
// Manim Studio V2: Overleaf-like front end. A GitHub sign-in button must not
// pretend to authenticate without a properly configured OAuth server.
const $=id=>document.getElementById(id);
const DB_NAME='manim-studio-pages-v1',STORE='projects';
const MAX_ASSET=30*1024*1024,MAX_TOTAL=256*1024*1024,MAX_ZIP=64*1024*1024,MAX_JSON=16*1024*1024,MAX_FILES=1000;
const QUALITY={'480p':[864,486,15],'720p':[1280,720,30],'1080p':[1920,1080,60],'4K':[3840,2160,60]};
let db=null,projects=[],current=null,slideId=null,selectedFile=null,editor=null,muted=false,dirty=false,saveTimer=null,pendingWrite=Promise.resolve();
let previewReady=false,queuedPreview=null,dashboardFilter='all',signedInUser=null,storageMode='local',loginBusy=false;
const PREVIEW_CHANNEL='manim-studio-wanim-v1';
const AUTH_URL=String(window.STUDIO_CONFIG?.authBaseUrl||'').replace(/\/+$/,'');
const authHint='GitHub login is not connected yet. Until the OAuth service and private project storage are configured, use Explore in this browser (local preview).';

/* Authenticated, same-origin private GitHub storage.
 * The published GitHub Pages edition remains a local-only preview.
 */
let backendAvailable=false;
const cloudSha=new Map();
async function cloud(path,options={}){
  const headers={'Accept':'application/json',...(options.headers||{})};
  if(options.body&&typeof options.body==='object'&&!(options.body instanceof Blob)){
    headers['Content-Type']='application/json';
    options={...options,body:JSON.stringify(options.body)};
  }
  const response=await fetch('/api'+path,{...options,headers,credentials:'same-origin',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Cloud request failed ('+response.status+').');
  return data;
}
async function probeCloud(){
  try{const resp=await fetch('/api/health',{credentials:'same-origin',cache:'no-store'});
    if(!resp.ok)return false;
    const json=await resp.json();return json.ok===true && json.configured===true;
  }catch{return false;}
}
function remoteProject(project) {
  return {id:project.id,name:project.name,setup:project.setup||'',slides:project.slides||[],
    quality:project.quality||'480p',aspect_ratio:project.aspect_ratio||'16:9',
    advance_key:project.advance_key||'right',archived:project.archived===true,
    assets:(project.assets||[]).map(a=>({name:a.name}))};
}
async function cloudProjectDetails(pid){
  const data=await cloud('/projects/'+encodeURIComponent(pid));
  cloudSha.set(pid,data.sha);
  const p=data.project;
  p.assets=(p.assets||[]).map(a=>({name:a.name}));
  return p;
}
async function cloudSave(snapshot){
  const revision=cloudSha.get(snapshot.id);
  if(!revision)throw Error('Cloud project revision unavailable. Reopen this project.');
  const result=await cloud('/projects/'+snapshot.id,{method:'PUT',body:{sha:revision,project:remoteProject(snapshot)}});
  cloudSha.set(snapshot.id,result.sha);
  if(current?.id===snapshot.id)current._sha=result.sha;
  return result;
}
async function cloudCreate(project){
  const result=await cloud('/projects',{method:'POST',body:{project:remoteProject(project)}});
  cloudSha.set(result.project.id,result.sha);
  return result.project;
}
async function cloudUploadAsset(pid,name,blob) {
  if(blob.size>3*1024*1024)throw Error('Cloud upload currently supports assets up to 3 MiB; use the local editor for larger files.');
  const base64=await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(reader.error||Error('Could not read asset.'));
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
  const result=await cloud('/projects/'+pid+'/assets',{method:'POST',body:{name,data:base64}});
  cloudSha.set(pid,result.sha);
  if(current?.id===pid){current.assets=current.assets.filter(a=>a.name!==name);current.assets.push({name});}
  return result;
}
async function cloudDeleteAsset(pid,name) {
  const result=await cloud('/projects/'+pid+'/assets/'+encodeURIComponent(name),{method:'DELETE'});
  cloudSha.set(pid,result.sha);
  if(current?.id===pid)current.assets=current.assets.filter(a=>a.name!==name);
  return result;
}
async function cloudAssetBlob(pid,name){
  const response=await fetch('/api/projects/'+encodeURIComponent(pid)+'/assets/'+encodeURIComponent(name),
    {credentials:'same-origin',cache:'no-store'});
  if(!response.ok){const x=await response.json().catch(()=>({}));throw Error(x.error||'Failed to download project asset.');}
  return response.blob();
}
async function enterCloud(){
  try{
    const session=await cloud('/me');
    signedInUser=session.user;
    storageMode='github';
    await refreshProjects();
    showDashboard();
    return true;
  }catch(error){
    signedInUser=null;storageMode='local';
    $('authHint').textContent='Sign in with GitHub to load projects from your private repository. Browser preview remains available without signing in.';
    return false;
  }
}

function id(){if(crypto.randomUUID)return crypto.randomUUID().replace(/-/g,'');const a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,n=>n.toString(16).padStart(2,'0')).join('');}
function show(view){for(const key of ['authView','dashboardView','editorView'])$(key).hidden=key!==view;document.body.dataset.view=view;if(view==='editorView')requestAnimationFrame(()=>editor?.refresh());}
function status(message,error=false){$('saveStatus').textContent=message;$('saveStatus').style.color=error?'#f3aaaa':'';}
function notice(message,error=false){const n=$('notice');n.hidden=!message;n.textContent=message;n.style.color=error?'#922f2f':'#355a38';n.style.borderColor=error?'#e4b4ae':'#b8d5bd';n.style.background=error?'#fff0ed':'#eff9f0';if(message)setTimeout(()=>{if(n.textContent===message)n.hidden=true},5500);}
function errorMessage(error){const str=error?.message||String(error);notice(str,true);status('Save failed',true);$('outputLog').textContent='Error: '+str;}
function openDatabase(){return new Promise((resolve,reject)=>{if(!window.indexedDB)return reject(new Error('IndexedDB is required to store projects locally.'));const q=indexedDB.open(DB_NAME,1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains(STORE))q.result.createObjectStore(STORE,{keyPath:'id'});};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error||Error('Unable to open project storage'));});}
function dbRequest(mode,method,value){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),q=tx.objectStore(STORE)[method](...(value===undefined?[]:[value]));let result;q.onsuccess=()=>result=q.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||Error('Project storage failed'));tx.onabort=()=>reject(tx.error||Error('Project storage aborted'));});}
async function refreshProjects(){projects=storageMode==='github'?(await cloud('/projects')).projects:(await dbRequest('readonly','getAll'));projects.sort((a,b)=>(b.updated_at||0)-(a.updated_at||0));}
function simpleProject(name){return {id:id(),revision:1,updated_at:Date.now()/1000,name,setup:'# Shared imports, colors and helper functions\nconfig.background_color = "#101114"\n',slides:[{id:id(),title:'',enabled:true,code:'title = Text("Hello, Manim!", font_size=48)\nself.play(Write(title))\nself.wait(0.5)\n'}],quality:'480p',aspect_ratio:'16:9',advance_key:'right',assets:[]};}
function currentSlide(){return current?.slides?.find(s=>s.id===selectedFile)||null;}
function markDirty(){if(!current||muted)return;dirty=true;status('Unsaved changes');clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveNow().catch(errorMessage),650);}
async function saveNow(){clearTimeout(saveTimer);if(!dirty||!current)return pendingWrite;if(!current.name.trim()){$('projectName').value=current.name='Untitled project';}const snapshot=structuredClone(current);snapshot.revision=(snapshot.revision||0)+1;snapshot.updated_at=Date.now()/1000;current.revision=snapshot.revision;current.updated_at=snapshot.updated_at;dirty=false;const key=snapshot.id;status('Saving…');pendingWrite=pendingWrite.catch(()=>{}).then(()=>storageMode==='github'?cloudSave(snapshot):dbRequest('readwrite','put',snapshot));try{await pendingWrite;const n=projects.findIndex(p=>p.id===key);if(n>=0)projects[n]=snapshot;else projects.push(snapshot);if(current&&current.id===key&&!dirty)status(storageMode==='github'?'Saved to GitHub':'Saved in browser');}catch(e){if(current&&current.id===key)dirty=true;throw e;}}
function dateLabel(stamp){if(typeof stamp!=='number')return 'Unknown';const d=new Date(stamp*1000);return Number.isNaN(+d)?'Unknown':d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});}
function showDashboard(){if(!db)return show('authView');disposeNativeVideos();current=null;selectedFile=null;$('dashboardAccount').textContent=signedInUser?'GitHub · '+signedInUser.login:'Browser preview · Not signed in';renderProjects();show('dashboardView');history.replaceState(null,'','#projects');}
async function viewAuth(){try{await saveNow();if(storageMode==='github')await cloud('/logout',{method:'POST'});}catch(e){notice('Could not finish logout: '+e.message,true);}signedInUser=null;storageMode='local';sessionStorage.removeItem('manimStudioV2Preview');show('authView');history.replaceState(null,'',location.pathname);}
function renderProjects(){const body=$('projectsTable');body.replaceChildren();let list=[...projects];if(dashboardFilter==='archived')list=list.filter(p=>p.archived===true);else list=list.filter(p=>p.archived!==true);if(dashboardFilter==='recent')list=list.slice(0,8);const query=$('searchProjects').value.trim().toLowerCase();if(query)list=list.filter(p=>p.name.toLowerCase().includes(query));if($('sortProjects').value==='name')list.sort((a,b)=>a.name.localeCompare(b.name));else if($('sortProjects').value==='oldest')list.sort((a,b)=>(a.updated_at||0)-(b.updated_at||0));else list.sort((a,b)=>(b.updated_at||0)-(a.updated_at||0));$('emptyProjects').hidden=list.length>0;for(const p of list){const tr=document.createElement('tr');const project=document.createElement('td'),name=document.createElement('button');name.className='project-open';name.textContent=p.name;name.onclick=()=>openProject(p.id).catch(errorMessage);project.append(name);const owner=document.createElement('td');owner.textContent=signedInUser?.login||'You';const modified=document.createElement('td');modified.textContent=dateLabel(p.updated_at);const count=document.createElement('td');count.textContent=String(Array.isArray(p.slides)?p.slides.length:(p.slides||0));const actions=document.createElement('td'),tools=document.createElement('div');tools.className='project-actions';const rename=document.createElement('button');rename.textContent='Rename';rename.title='Rename project';rename.onclick=()=>renameProject(p).catch(errorMessage);const archive=document.createElement('button');archive.textContent=p.archived?'Restore':'Archive';archive.onclick=()=>toggleArchive(p).catch(errorMessage);const del=document.createElement('button');del.textContent='Delete';del.title='Permanently delete';del.onclick=()=>deleteProject(p).catch(errorMessage);tools.append(rename,archive,del);actions.append(tools);tr.append(project,owner,modified,count,actions);body.append(tr);}}
async function renameProject(p){const value=prompt('Rename project',p.name);if(value===null)return;const name=value.trim();if(!name||name.length>160)throw Error('Project names must contain 1–160 characters.');if(storageMode==='github'){const full=await cloudProjectDetails(p.id);full.name=name;await cloudSave(full);await refreshProjects();}else{p.name=name;p.revision=(p.revision||0)+1;p.updated_at=Date.now()/1000;await dbRequest('readwrite','put',p);}renderProjects();}
async function toggleArchive(p){if(storageMode==='github'){const full=await cloudProjectDetails(p.id);full.archived=!full.archived;await cloudSave(full);await refreshProjects();}else{p.archived=!p.archived;p.updated_at=Date.now()/1000;await dbRequest('readwrite','put',p);}renderProjects();}
async function deleteProject(p){if(!confirm('Permanently delete "'+p.name+'" and its files from this browser? This cannot be undone.'))return;if(storageMode==='github')await cloud('/projects/'+p.id,{method:'DELETE'});else await dbRequest('readwrite','delete',p.id);cloudSha.delete(p.id);await refreshProjects();renderProjects();notice(storageMode==='github'?'Project deleted from GitHub.':'Project deleted from this browser.');}
function setDashboardFilter(filter){dashboardFilter=filter;for(const [k,b] of [['all','showAll'],['recent','showRecent'],['archived','showArchived']])$(b).classList.toggle('active',k===filter);$('dashboardSubtitle').textContent=filter==='recent'?'Recently modified projects.':filter==='archived'?'Projects moved to the archive.':'All the mathematical presentations you’re working on.';renderProjects();}
function openProjectDialog(){$('newProjectName').value='Untitled Project';$('projectDialog').showModal();$('newProjectName').focus();$('newProjectName').select();}
async function createProject(name){const value=name.trim();if(!value||value.length>160)throw Error('Project name must contain 1–160 characters.');await saveNow();const project=simpleProject(value);const saved=storageMode==='github'?await cloudCreate(project):(await dbRequest('readwrite','put',project),project);await refreshProjects();current=null;await openProject(saved.id);notice(storageMode==='github'?'Project created in your private GitHub repository.':'Project created. This preview workspace saves locally.');}
function makeEditor(){if(window.CodeMirror){const cm=CodeMirror.fromTextArea($('codeInput'),{mode:'python',lineNumbers:true,indentUnit:4,tabSize:4,indentWithTabs:false,autoCloseBrackets:true,lineWrapping:false,extraKeys:{Tab:cm=>cm.somethingSelected()?cm.indentSelection('add'):cm.replaceSelection('    ','end'),'Ctrl-S':()=>saveNow().catch(errorMessage),'Cmd-S':()=>saveNow().catch(errorMessage)}});cm.on('change',()=>{if(muted||!current)return;const s=currentSlide();if(s)s.code=cm.getValue();else current.setup=cm.getValue();markDirty();});cm.on('cursorActivity',()=>{const cursor=cm.getCursor();$('cursorPosition').textContent='Ln '+(cursor.line+1)+', Col '+(cursor.ch+1);});return cm;}const el=$('codeInput');el.oninput=()=>{if(muted||!current)return;const s=currentSlide();if(s)s.code=el.value;else current.setup=el.value;markDirty();};return {getValue:()=>el.value,setValue:v=>el.value=v,replaceSelection:v=>{el.setRangeText(v,el.selectionStart,el.selectionEnd,'end');el.dispatchEvent(new Event('input'));},focus:()=>el.focus(),refresh:()=>{},getCursor:()=>({line:0,ch:0})};}
function fileButton(label,key,prefix){const b=document.createElement('button');const name=document.createElement('span');name.className='file-label';name.textContent=label;b.append(document.createTextNode(prefix||'◫'),name);b.className=selectedFile===key?'active':'';b.onclick=()=>selectFile(key);return b;}
function renderFileTree(){const tree=$('fileTree');tree.replaceChildren();if(!current)return;tree.append(fileButton('Shared Setup','setup','⌘'));const label=document.createElement('div');label.className='folder-label';label.textContent='SLIDES';tree.append(label);current.slides.forEach((slide,n)=>{const b=fileButton('Slide '+(n+1),slide.id,slide.enabled===false?'○':'▧');b.title=slide.enabled===false?'Excluded from compilation':'Included in compilation';tree.append(b);});const folder=document.createElement('div');folder.className='folder-label';folder.textContent='ASSETS';tree.append(folder);for(const asset of current.assets||[]){const b=document.createElement('button');b.title='Click to insert asset path';const name=document.createElement('span');name.className='file-label';name.textContent=asset.name;b.append(document.createTextNode('▤'),name);b.onclick=()=>{if(!currentSlide())selectFile(current.slides[0].id);editor.replaceSelection('str(ASSETS_DIR / '+JSON.stringify(asset.name)+')');editor.focus();};const row=document.createElement('div');row.className='asset-entry';row.append(b);const remove=document.createElement('button');remove.className='remove-asset';remove.textContent='×';remove.title='Delete asset '+asset.name;remove.setAttribute('aria-label','Delete asset '+asset.name);remove.onclick=async()=>{if(!confirm('Permanently remove '+asset.name+'?'))return;try{await saveNow();if(storageMode==='github')await cloudDeleteAsset(current.id,asset.name);else{current.assets=current.assets.filter(item=>item.name!==asset.name);markDirty();}renderAssets();}catch(e){errorMessage(e);}};row.append(remove);tree.append(row);}if(!(current.assets||[]).length){const small=document.createElement('div');small.style='font-size:11px;color:#a4aeb6;margin:5px 12px';small.textContent='No assets';tree.append(small);}}
function selectFile(key){if(!current)return;selectedFile=key;const s=currentSlide();muted=true;editor.setValue(s?s.code:current.setup||'');muted=false;$('currentTab').textContent=s?'Slide '+(current.slides.indexOf(s)+1)+' · Python':'Shared Setup · Python';$('slideEnabled').checked=s?s.enabled!==false:true;$('slideEnabled').disabled=!s;for(const key of ['moveSlideUp','moveSlideDown','duplicateSlide','deleteSlide'])$(key).disabled=!s;const n=s?current.slides.indexOf(s):-1;$('moveSlideUp').disabled=!s||n===0;$('moveSlideDown').disabled=!s||n===current.slides.length-1;$('deleteSlide').disabled=!s||current.slides.length<=1;$('slideStatus').textContent=s?'Variables and objects are preserved across slides':'Shared Setup runs before all slides';renderFileTree();requestAnimationFrame(()=>editor?.refresh());}
async function openProject(projectId){await saveNow();disposeNativeVideos();const p=projects.find(p=>p.id===projectId);if(!p)throw Error('Project no longer exists.');current=storageMode==='github'?await cloudProjectDetails(projectId):structuredClone(p);current.assets||=[];current.slides||=[];if(!current.slides.length)current.slides=[{id:id(),title:'',code:'',enabled:true}];dirty=false;$('projectName').value=current.name;$('projectInfo').textContent='Slides: '+current.slides.length+'\nAssets: '+current.assets.length+'\nQuality: '+current.quality+'\nAspect ratio: '+(current.aspect_ratio||'16:9');$('aspectRatio').value=current.aspect_ratio||'16:9';$('videoQuality').value=current.quality==='low'?'480p':current.quality==='high'?'1080p':current.quality;show('editorView');selectFile(current.slides[0].id);status(storageMode==='github'?'Saved to GitHub':'Saved in browser');$('renderMode').textContent=storageMode==='github'?'Native Manim (GitHub Actions)':'Browser preview';$('previewEngineLabel').textContent=storageMode==='github'?'Manim Community + Manim Slides':'Experimental Wanim preview';$('previewFrame').hidden=false;const v=$('nativeVideo');if(v)v.hidden=true;$('outputLog').textContent=storageMode==='github'?'Opened '+current.name+'.\n\nPress Recompile to run native Manim Community and Manim Slides through GitHub Actions.':'Opened '+current.name+'.\n\nBrowser preview is experimental; native Manim compilation requires GitHub sign-in.';if(storageMode==='github')restoreNativePresentation().catch(()=>{});history.replaceState(null,'','#project/'+encodeURIComponent(current.id));}
function addSlide(duplicate=false){if(!current)return;if(current.slides.length>=100)return notice('Limit of 100 slides per project.',true);const i=current.slides.findIndex(x=>x.id===selectedFile);const old=currentSlide();const slide=duplicate&&old?{...structuredClone(old),id:id()}:{id:id(),title:'',code:'# Continue the connected animation here.\n',enabled:true};current.slides.splice(i>=0?i+1:current.slides.length,0,slide);markDirty();selectFile(slide.id);}
function moveSlide(dir){const n=current?.slides.findIndex(x=>x.id===selectedFile)??-1;if(n<0||n+dir<0||n+dir>=current.slides.length)return;[current.slides[n],current.slides[n+dir]]=[current.slides[n+dir],current.slides[n]];markDirty();selectFile(selectedFile);}
function deleteSlide(){const n=current?.slides.findIndex(x=>x.id===selectedFile)??-1;if(n<0||current.slides.length===1)return;if(!confirm('Delete slide '+(n+1)+' from this project?'))return;current.slides.splice(n,1);markDirty();selectFile(current.slides[Math.min(n,current.slides.length-1)].id);}
function renderAssets(){renderFileTree();if(current)$('projectInfo').textContent='Slides: '+current.slides.length+'\nAssets: '+current.assets.length+'\nQuality: '+current.quality+'\nAspect ratio: '+(current.aspect_ratio||'16:9');}

/* Native Manim Slides playback from private GitHub Actions render artifacts. */
let renderJob=null,nativeSegments=[],nativeUrls=[],nativeIndex=0,nativeResult=null;
function disposeNativeVideos(){
  const player=$('nativeVideo');if(player){player.pause();player.removeAttribute('src');player.load();}
  for(const url of nativeUrls)URL.revokeObjectURL(url);
  nativeUrls=[];nativeSegments=[];nativeIndex=0;nativeResult=null;
}
function ensureVideoPlayer(){
  let video=$('nativeVideo');
  if(!video){
    video=document.createElement('video');video.id='nativeVideo';video.setAttribute('playsinline','');video.controls=false;
    video.setAttribute('aria-label','Compiled Manim Slides presentation');
    $('previewStage').appendChild(video);
  }
  $('previewFrame').hidden=true;video.hidden=false;return video;
}
function playNative(index,play=true,showEnd=false){
  if(!nativeUrls.length||index<0||index>=nativeUrls.length)return;
  const video=ensureVideoPlayer();
  nativeIndex=index;
  video.pause();
  video.src=nativeUrls[index];video.load();
  video.onloadedmetadata=()=>{
    if(showEnd){video.currentTime=Math.max(0,(video.duration||0)-0.06);}
    else if(play)video.play().catch(()=>{});
  };
  $('previewStatus').textContent='Slide '+(current?.slides.findIndex(s=>s.id===nativeSegments[index]?.slide_id)+1||'?')+
    ' · Step '+(index+1)+' of '+nativeUrls.length;
  $('previousStep').disabled=index===0;
  $('nextStep').disabled=index===nativeUrls.length-1;
  $('playStep').disabled=false;
  $('fullscreen').disabled=false;
}
function nativeStep(delta){if(nativeUrls.length)playNative(nativeIndex+delta,delta>0,delta<0);}
function replayNative(){if(!nativeUrls.length)return;const video=$('nativeVideo');if(!video)return;
  if(video.paused){if(video.ended)video.currentTime=0;video.play().catch(()=>{});}
  else video.pause();
}
async function loadNativeArtifact(handle){
  if(!window.JSZip)throw Error('ZIP library is not available.');
  $('previewStatus').textContent='Downloading compiled presentation…';
  const response=await fetch('/api/jobs/'+encodeURIComponent(handle)+'/download',{credentials:'same-origin'});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||'The compiled presentation is unavailable.');}
  const zip=await JSZip.loadAsync(await response.blob());
  const resultFile=zip.file('result.json')||zip.file('render-results/result.json');
  if(!resultFile)throw Error('The render artifact has no result.json. Open the GitHub Actions log.');
  const result=JSON.parse(await resultFile.async('string'));
  if(result.format!=='manim-studio-presentation'||result.version!==1||
    !Array.isArray(result.segments)||!result.segments.length)throw Error('Invalid Manim render artifact.');
  const blobs=[];
  for(const item of result.segments){
    if(!/^segments\/\d{4}\.mp4$/.test(item.file))throw Error('Unsafe segment name in render artifact.');
    const file=zip.file(item.file)||zip.file('render-results/'+item.file);
    if(!file)throw Error('A rendered video segment is missing.');
    blobs.push(await file.async('blob'));
  }
  if(current&&result.project_id!==current.id)throw Error('Render artifact belongs to a different project.');
  disposeNativeVideos();
  nativeResult=result;
  nativeSegments=result.segments;
  nativeUrls=blobs.map(x=>URL.createObjectURL(new Blob([x],{type:'video/mp4'})));
  playNative(0,false);
  const log=zip.file('render.log')||zip.file('render-results/render.log');
  $('outputLog').textContent='Native Manim Slides compilation successful.\n'+
    result.segments.length+' playable animation segment(s).\n'+
    'Quality: '+result.quality+'.\n\n'+(log?await log.async('string'):'No render log attached.');
  if(result.full&&current)localStorage.setItem('studioNativeLast:'+current.id,handle);
  return result;
}
async function startNativeRender(target=''){
  if(!current||renderJob)return;
  try{
    await saveNow();
    if(!cloudSha.get(current.id))throw Error('Project does not have a saved GitHub revision.');
    $('compile').disabled=true;$('compileSelected').disabled=true;$('stopRender').disabled=false;
    $('outputLog').textContent='Submitting native Manim Slides job to GitHub Actions…';
    $('previewStatus').textContent='Submitting render…';
    const result=await cloud('/render',{method:'POST',body:{
      project_id:current.id,sha:cloudSha.get(current.id),target_slide:target
    }});
    renderJob={handle:result.handle,pid:current.id};
    $('outputLog').textContent='Render queued on GitHub Actions.\n'+(result.html_url||'')+
      '\n\nManim Community + Manim Slides will compile the saved source inside an isolated container.';
    pollNativeRender();
  }catch(e){
    renderJob=null;$('compile').disabled=false;$('compileSelected').disabled=false;$('stopRender').disabled=true;
    errorMessage(e);$('previewStatus').textContent='Compilation could not start.';
  }
}
async function pollNativeRender(){
  const job=renderJob;if(!job)return;
  try{
    const state=await cloud('/jobs/'+encodeURIComponent(job.handle));
    if(renderJob!==job)return;
    const label=state.status==='completed'?'Completed':state.status==='in_progress'?'Rendering':'Queued';
    $('previewStatus').textContent=label+' · native Manim';
    if(state.status==='completed'){
      renderJob=null;$('compile').disabled=false;$('compileSelected').disabled=false;$('stopRender').disabled=true;
      if(state.conclusion==='success'&&state.artifact){
        await loadNativeArtifact(job.handle);
      }else{
        $('previewStatus').textContent='Native compilation '+(state.conclusion||'failed');
        $('outputLog').textContent+='\\n\\nRender failed: '+(state.conclusion||'unknown')+
          '\\nOpen the GitHub Actions run for the full compilation log: '+state.html_url;
      }
    }else setTimeout(pollNativeRender,4500);
  }catch(e){
    if(renderJob!==job)return;
    renderJob=null;$('compile').disabled=false;$('compileSelected').disabled=false;$('stopRender').disabled=true;errorMessage(e);
  }
}
async function restoreNativePresentation(){
  if(storageMode!=='github'||!current)return;
  const pid=current.id;
  const old=localStorage.getItem('studioNativeLast:'+pid);
  const handles=[];
  if(old)handles.push(old);
  try{
    const history=await cloud('/projects/'+pid+'/renders');
    for(const item of history.renders||[])if(!handles.includes(item.handle))handles.push(item.handle);
  }catch(e){$('outputLog').textContent+='\nCould not load render history: '+e.message;}
  for(const handle of handles.slice(0,6)){
    if(current?.id!==pid)return;
    try{
      const state=await cloud('/jobs/'+encodeURIComponent(handle));
      if(current?.id!==pid)return;
      if(state.conclusion==='success'&&state.artifact){
        await loadNativeArtifact(handle);return;
      }
    }catch(_){}
  }
  if(old)localStorage.removeItem('studioNativeLast:'+pid);
}
async function stopNativeRender(){
  const job=renderJob;if(!job)return;
  $('stopRender').disabled=true;
  try{
    await cloud('/jobs/'+encodeURIComponent(job.handle)+'/cancel',{method:'POST'});
    $('outputLog').textContent+='\nCancellation requested from GitHub Actions…';
    $('previewStatus').textContent='Cancelling render…';
  }catch(error){$('stopRender').disabled=false;errorMessage(error);}
}

function previewMessage(type,other={}){const message={channel:PREVIEW_CHANNEL,type,...other};const frame=$('previewFrame');if(!previewReady){if(type==='run')queuedPreview=message;return;}frame.contentWindow?.postMessage(message,'*');}
function startBrowserPreview(){if(storageMode==='github'){startNativeRender();return;}if(!current)return;try{const source=buildBrowserPreviewSource(current);saveNow().catch(errorMessage);const quality={'480p':'-ql','720p':'-qm','1080p':'-qh','4K':'-q4k'}[current.quality]||'-qm';$('outputLog').textContent='Starting browser preview of '+current.slides.filter(s=>s.enabled!==false).length+' connected slide blocks.\n\nThis preview is experimental and does not produce a native Manim Slides render.\n';$('previewStatus').textContent='Loading browser runtime…';for(const key of ['stopRender','previousStep','playStep','nextStep','fullscreen'])$(key).disabled=false;previewMessage('run',{code:source,quality});}catch(e){errorMessage(e);}}
function wirePreview(){const frame=$('previewFrame');frame.addEventListener('load',()=>{previewReady=true;if(queuedPreview){frame.contentWindow?.postMessage(queuedPreview,'*');queuedPreview=null;}});window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.channel!==PREVIEW_CHANNEL)return;const v=event.data;if(v.type==='frame-loaded'){previewReady=true;if(queuedPreview){frame.contentWindow.postMessage(queuedPreview,'*');queuedPreview=null;}}if(v.type==='running'){$('previewStatus').textContent='Preview running';$('outputLog').textContent+='\nPreview started.';}if(v.type==='done'){$('previewStatus').textContent='Preview finished';$('stopRender').disabled=true;}if(v.type==='stopped'){$('previewStatus').textContent='Preview stopped';$('stopRender').disabled=true;}if(v.type==='error'){$('previewStatus').textContent='Preview error';$('outputLog').textContent+='\n\nError: '+String(v.message||'Unknown browser runtime error')+'\n\nNative Manim compatibility is not yet available.';$('stopRender').disabled=true;}});}
function showSettings(){$('aspectRatio').value=current?.aspect_ratio||'16:9';$('videoQuality').value=current?.quality||'480p';$('settingsDialog').showModal();}
function editorMenu(kind){if(kind==='fileMenu'){const act=prompt('File menu: enter 1 for New Project, 2 for Export ZIP, 3 for Download Python','2');if(act==='1')openProjectDialog();if(act==='2')exportZip().catch(errorMessage);if(act==='3')exportPython();}if(kind==='editMenu'){editor?.focus();notice('Use Cmd/Ctrl+Z to undo, Cmd/Ctrl+S to save, and Cmd/Ctrl+A to select all.');}if(kind==='viewMenu'){const file=$('fileTree').parentElement;file.style.display=file.style.display==='none'?'':'none';notice('File tree toggled.');}if(kind==='helpMenu')window.open('https://github.com/priyanshupant/Manim-Studio','_blank','noopener');}
function toggleOutputTab(info){$('projectInfo').hidden=!info;$('outputLog').hidden=info;$('logsTab').classList.toggle('active',!info);$('infoTab').classList.toggle('active',info);}
function bind(){const launch=()=>{$('projectDialog').showModal();$('newProjectName').value='Untitled Project';$('newProjectName').focus();$('newProjectName').select();};for(const k of ['newProject','createTop','emptyNew'])$(k).onclick=launch;
$('projectForm').addEventListener('submit',e=>{e.preventDefault();if(e.submitter?.value==='cancel'){$('projectDialog').close();return;}const name=$('newProjectName').value;$('projectDialog').close();createProject(name).catch(errorMessage);});
$('githubLogin').onclick=()=>{if(!backendAvailable){$('authError').hidden=false;$('authError').textContent='GitHub sign-in is not configured on this host. Connect the Vercel backend and GitHub App first.';return;}location.assign('/api/login');};
$('localPreview').onclick=async()=>{storageMode='local';signedInUser=null;sessionStorage.setItem('manimStudioV2Preview','1');await refreshProjects();showDashboard();};
$('dashboardSignout').onclick=viewAuth;$('dashboardHome').onclick=showDashboard;
$('showAll').onclick=()=>setDashboardFilter('all');$('showRecent').onclick=()=>setDashboardFilter('recent');$('showArchived').onclick=()=>setDashboardFilter('archived');
$('searchProjects').oninput=renderProjects;$('sortProjects').onchange=renderProjects;
$('importProject').onclick=()=>$('zipFileInput').click();$('zipFileInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{await importZip(file);}catch(err){errorMessage(err);}finally{e.target.value='';}};
$('openLegacy').onclick=()=>location.href='./legacy.html';$('backProjects').onclick=()=>saveNow().then(showDashboard).catch(errorMessage);
$('projectName').oninput=e=>{if(current){current.name=e.target.value;markDirty();}};$('projectName').onblur=()=>{if(current&&!current.name.trim()){$('projectName').value=current.name='Untitled project';markDirty();}};
$('addSlide').onclick=()=>addSlide(false);$('duplicateSlide').onclick=()=>addSlide(true);$('moveSlideUp').onclick=()=>moveSlide(-1);$('moveSlideDown').onclick=()=>moveSlide(1);$('deleteSlide').onclick=deleteSlide;
$('slideEnabled').onchange=e=>{const s=currentSlide();if(s){s.enabled=e.target.checked;markDirty();renderFileTree();}};
$('compile').onclick=startBrowserPreview;$('compileSelected').onclick=()=>{if(storageMode==='github'&&currentSlide())startNativeRender(currentSlide().id);else startBrowserPreview();};$('stopRender').onclick=()=>storageMode==='github'?stopNativeRender():previewMessage('stop');$('previousStep').onclick=()=>nativeUrls.length?nativeStep(-1):previewMessage('previous');$('nextStep').onclick=()=>nativeUrls.length?nativeStep(1):previewMessage('next');$('playStep').onclick=()=>nativeUrls.length?replayNative():previewMessage('replay');$('fullscreen').onclick=()=>$('previewStage').requestFullscreen?.().catch(errorMessage);$('present').onclick=()=>{if(nativeUrls.length){playNative(0,false);$('previewStage').requestFullscreen?.().catch(errorMessage);}else $('previewStage').requestFullscreen?.().catch(errorMessage);};
$('downloadPython').onclick=()=>{try{exportPython();}catch(e){errorMessage(e);}};$('exportZip').onclick=()=>exportZip().catch(errorMessage);
$('uploadAsset').onclick=()=>$('assetFileInput').click();$('assetFileInput').onchange=e=>{uploadAssets(e.target.files).catch(errorMessage);e.target.value='';};
$('settingsDialog').addEventListener('close',()=>{});$('projectSettings').onclick=showSettings;$('closeSettings').onclick=()=>$('settingsDialog').close();$('aspectRatio').onchange=e=>{if(current){current.aspect_ratio=e.target.value;markDirty();renderAssets();}};$('videoQuality').onchange=e=>{if(current){current.quality=e.target.value;markDirty();renderAssets();}};
$('logsTab').onclick=()=>toggleOutputTab(false);$('infoTab').onclick=()=>toggleOutputTab(true);
$('historyButton').onclick=()=>notice('Version history will be available with private GitHub project storage. Local projects can currently be backed up as ZIP.');
$('shareButton').onclick=()=>notice('Shareable project links require authenticated cloud project storage. Your local browser projects are not publicly accessible.');
$('accountButton').onclick=()=>{if(confirm('Return to the login screen?'))viewAuth();};
for(const k of ['fileMenu','editMenu','viewMenu','helpMenu'])$(k).onclick=()=>editorMenu(k);
$('toggleFileSidebar').onclick=()=>{const pane=$('fileTree').parentElement;pane.style.visibility=pane.style.visibility==='hidden'?'visible':'hidden';};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveNow().catch(errorMessage);}if(e.key==='Escape'&&!$('editorView').hidden&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});if(document.fullscreenElement===$('previewStage')&&nativeUrls.length&&!e.target.closest('input,textarea,select,[contenteditable]')){if(e.key==='ArrowRight'){e.preventDefault();nativeStep(1);}else if(e.key==='ArrowLeft'){e.preventDefault();nativeStep(-1);}else if(e.key===' '||e.key==='Enter'){e.preventDefault();replayNative();}}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
const resizer=$('paneResizer');let dragging=false;resizer.onpointerdown=e=>{if(window.innerWidth<=780)return;dragging=true;resizer.setPointerCapture(e.pointerId);};resizer.onpointermove=e=>{if(!dragging)return;const layout=document.querySelector('.editor-main'),rect=layout.getBoundingClientRect(),fileWidth=window.innerWidth<=1100?165:222,left=Math.max(180,Math.min(rect.width-fileWidth-245,e.clientX-rect.left-fileWidth));layout.style.gridTemplateColumns=fileWidth+'px '+left+'px 7px minmax(220px,1fr)';editor?.refresh();};resizer.onpointerup=()=>dragging=false;resizer.onpointercancel=()=>dragging=false;resizer.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const layout=document.querySelector('.editor-main'),r=layout.getBoundingClientRect(),fileWidth=window.innerWidth<=1100?165:222,left=Math.max(180,Math.min(r.width-fileWidth-245,(r.width-fileWidth)/2+(e.key==='ArrowLeft'?-50:50)));layout.style.gridTemplateColumns=fileWidth+'px '+left+'px 7px minmax(220px,1fr)';editor?.refresh();}};
}
async function start(){wirePreview();db=await openDatabase();editor=makeEditor();bind();backendAvailable=await probeCloud();if(backendAvailable&&await enterCloud())return;storageMode='local';await refreshProjects();if(sessionStorage.getItem('manimStudioV2Preview')==='1')showDashboard();else show('authView');}
document.addEventListener('DOMContentLoaded',()=>start().catch(e=>{show('authView');$('authError').hidden=false;$('authError').textContent=e.message;}));

// Reused ZIP and export logic, compatible with original Studio v1 format.
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
  if (assets.length+2>MAX_FILES || (storageMode==='local'&&assets.reduce((n,a)=>n+a.blob.size,0)>MAX_TOTAL)) throw new Error('Project assets exceed ZIP size limits.');
  const zip=new JSZip();
  zip.file('manifest.json',JSON.stringify({format:'manim-studio-project',version:1},null,2));
  zip.file('project.json',payload);
  for (const a of assets) zip.file('assets/'+a.name,storageMode==='github'?await cloudAssetBlob(current.id,a.name):a.blob);
  status('Preparing project ZIP…');
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
  if (blob.size>MAX_ZIP) throw new Error('Compressed ZIP exceeds the 64 MiB limit. Remove large assets.');
  download(blob,slug(current.name)+'.zip');
  status(storageMode==='github'?'Saved to GitHub':'Saved in this browser');
  notice('Project ZIP downloaded. Keep it as a backup or import it into desktop Manim Studio.');
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
  if(storageMode==='github'){
    const created=await cloudCreate({...p,assets:[]});
    for(const asset of assets)await cloudUploadAsset(created.id,asset.name,asset.blob);
    p.id=created.id;
  }else await dbRequest('readwrite','put',p);
  await refreshProjects();
  current=null;
  await openProject(p.id);
  notice('Imported "'+p.name+'" with '+p.slides.length+' slide(s) and '+assets.length+' asset(s).');
}

function buildBrowserPreviewSource(project) {
  if (!project) throw new Error('Open a project first.');
  const included=project.slides.filter(slide => slide.enabled!==false);
  if (!included.length) throw new Error('Enable at least one slide for preview.');
  const lines=['from manim import *','',project.setup||'','', 'class StudioScene(Scene):','    def construct(self):'];
  for (const slide of included) {
    lines.push('        # Slide '+(project.slides.indexOf(slide)+1));
    const code=slide.code.replace(/\r\n?/g,'\n').split('\n');
    let added=false;
    for (const line of code) {
      // A Manim Slides pause is not a Manim CE Scene method. Wanim's slides
      // mode provides its own per-animation navigation instead.
      if (/^\s*self\.next_slide\(\s*\)\s*(?:#.*)?$/.test(line)) continue;
      lines.push(line ? '        '+line : '');
      if (line.trim()) added=true;
    }
    if (!added) lines.push('        pass');
  }
  const source=lines.join('\n')+'\n';
  if (source.length>1200000) throw new Error('The browser preview is limited to 1.2 million characters of Python source.');
  return source;
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
  if(!current)return;
  if(storageMode==='github'){
    await saveNow();
    for(const file of Array.from(files)){
      if(!validAssetName(file.name)||file.name.includes('/'))throw Error('Invalid filename: '+file.name);
      if(file.size>3*1024*1024)throw Error(file.name+' exceeds the 3 MiB GitHub upload limit.');
      if(current.assets.some(a=>a.name===file.name)&&!confirm('Replace '+file.name+'?'))continue;
      await cloudUploadAsset(current.id,file.name,file);
    }
    renderAssets();notice('Assets saved to your private GitHub repository.');return;
  }
  let total=(current.assets||[]).reduce((n,a)=>n+a.blob.size,0);
  for(const file of Array.from(files)){
    if(!validAssetName(file.name)||file.name.includes('/'))throw Error('Invalid filename: '+file.name);
    if(file.size>MAX_ASSET)throw Error(file.name+' is over the 30 MiB per-file limit.');
    const replaced=current.assets.find(a=>a.name===file.name);
    if(replaced&&!confirm('Replace the existing "'+file.name+'" asset?'))continue;
    total=total-(replaced?replaced.blob.size:0)+file.size;
    if(total>MAX_TOTAL)throw Error('Project assets exceed 256 MiB.');
    current.assets=current.assets.filter(a=>a.name!==file.name);
    current.assets.push({name:file.name,blob:file.slice(0,file.size,file.type)});
  }
  markDirty();renderAssets();notice('Asset(s) saved in this browser.');
}
