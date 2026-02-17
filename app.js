const video = document.getElementById('vid');

// screen canvas (what you see) — always full viewport, letterboxed
const screen = document.getElementById('screen');
const sctx = screen.getContext('2d', { willReadFrequently: true });

// frame canvas (the REAL output) — true aspect (1:1, 16:9, etc.)
const frame = document.createElement('canvas');
const fctx = frame.getContext('2d', { willReadFrequently: true });

// low-res processing buffer
const low = document.createElement('canvas');
const lctx = low.getContext('2d', { willReadFrequently: true });

// feedback buffer (same size as frame)
const fb = document.createElement('canvas');
const fbctx = fb.getContext('2d', { willReadFrequently: true });

const panel = document.getElementById('panel');

const ui = {
  flip: document.getElementById('flip'),
  bend: document.getElementById('bend'),
  snap: document.getElementById('snap'),
  hud:  document.getElementById('hud'),
  tip:  document.getElementById('tip'),

  format: document.getElementById('format'),

  t_blocks: document.getElementById('t_blocks'),
  t_bit: document.getElementById('t_bit'),
  t_feedback: document.getElementById('t_feedback'),
  t_noise: document.getElementById('t_noise'),
  t_false: document.getElementById('t_false'),
  t_bars: document.getElementById('t_bars'),
  t_date: document.getElementById('t_date'),

  s_grit: document.getElementById('s_grit'),
  s_corrupt: document.getElementById('s_corrupt'),
  s_chroma: document.getElementById('s_chroma'),
  s_palette: document.getElementById('s_palette'),
  s_res: document.getElementById('s_res'),
};

let facingMode = "environment";
let stream = null;
let bendBurst = 0;
let lastKey = "";

function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function rand(n=1){ return Math.random()*n; }

function dateStamp(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}/${mm}/${dd}`;
}

/* ----------- FORMAT LOGIC ----------- */

function viewportSize(){
  const vw = Math.floor(window.visualViewport?.width || window.innerWidth);
  const vh = Math.floor(window.visualViewport?.height || window.innerHeight);
  return { vw, vh };
}

function deviceIsLandscape(){
  const { vw, vh } = viewportSize();
  return vw > vh;
}

function chosenMode(){
  const m = ui.format.value; // auto | portrait | landscape | square
  if (m === 'auto') return deviceIsLandscape() ? 'landscape' : 'portrait';
  return m;
}

// returns aspect ratio (width/height) for the REAL frame
function modeAspect(mode){
  if (mode === 'square') return 1;
  if (mode === 'landscape') return 16/9;
  // portrait: use device-ish portrait aspect (fallback 9:16)
  const { vw, vh } = viewportSize();
  const ar = vw / vh;
  // if user forces portrait while device is landscape, still keep a portrait ratio
  return clamp(ar, 9/19.5, 9/14); // roughly typical iPhone portrait range
}

/* ----------- RESIZE PIPELINE ----------- */

function resizeAll(){
  const { vw, vh } = viewportSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // screen canvas matches viewport
  screen.width  = Math.floor(vw * dpr);
  screen.height = Math.floor(vh * dpr);

  const mode = chosenMode();
  const ar = modeAspect(mode); // frame aspect (w/h)

  // choose frame size based on RES slider (controls "detail")
  // RES is the SHORT SIDE of the frame for consistency
  const res = parseInt(ui.s_res.value, 10);
  let fw, fh;

  if (ar >= 1){
    // wider than tall
    fh = res;
    fw = Math.round(res * ar);
  } else {
    // taller than wide
    fw = res;
    fh = Math.round(res / ar);
  }

  frame.width = fw;
  frame.height = fh;

  // low-res buffer mirrors frame aspect (smaller)
  const lowRes = Math.max(120, Math.floor(res * 0.85));
  let lw, lh;
  if (ar >= 1){ lh = lowRes; lw = Math.round(lowRes * ar); }
  else { lw = lowRes; lh = Math.round(lowRes / ar); }
  low.width = lw;
  low.height = lh;

  // feedback buffer matches frame
  fb.width = frame.width;
  fb.height = frame.height;

  ui.tip.innerHTML = `Mode: <b>${mode.toUpperCase()}</b> • Frame: <b>${frame.width}×${frame.height}</b> • SNAP saves true crop`;
}

/* ----------- DRAW VIDEO CROPPED TO ASPECT (NO STRETCH) ----------- */

function drawVideoCoverTo(ctx, W, H){
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;

  const srcAspect = vw / vh;
  const dstAspect = W / H;

  let sx=0, sy=0, sW=vw, sH=vh;

  if (srcAspect > dstAspect){
    // source wider: crop left/right
    sH = vh;
    sW = vh * dstAspect;
    sx = (vw - sW) / 2;
  } else {
    // source taller: crop top/bottom
    sW = vw;
    sH = vw / dstAspect;
    sy = (vh - sH) / 2;
  }

  ctx.drawImage(video, sx, sy, sW, sH, 0, 0, W, H);
}

/* ----------- EFFECTS ----------- */

function bitcrush(img, amt){
  const d = img.data;
  const levels = Math.floor(3 + (1-amt) * 18);
  const step = 255 / levels;
  for (let i=0; i<d.length; i+=4){
    d[i]   = Math.round(d[i]/step)*step;
    d[i+1] = Math.round(d[i+1]/step)*step;
    d[i+2] = Math.round(d[i+2]/step)*step;
  }
}

// safe chromatic (no screen-kill)
function chromaSplit(img, amt){
  if (amt <= 0.001) return;

  const w = img.width, h = img.height;
  const d = img.data;
  const out = new Uint8ClampedArray(d.length);

  const maxShift = Math.floor(amt * 6 + bendBurst * 4);
  const rx = (Math.random()<0.5?-1:1) * Math.floor(rand(maxShift+1));
  const gx = (Math.random()<0.5?-1:1) * Math.floor(rand(maxShift+1));
  const bx = (Math.random()<0.5?-1:1) * Math.floor(rand(maxShift+1));
  const ry = (Math.random()<0.5?-1:1) * Math.floor(rand(maxShift+1));
  const gy = (Math.random()<0.5?-1:1) * Math.floor(rand(maxShift+1));
  const by = (Math.random()<0.5?-1:1) * Math.floor(rand(maxShift+1));

  const sample = (x,y,c)=>{
    x = clamp(x,0,w-1); y = clamp(y,0,h-1);
    return d[(y*w + x)*4 + c];
  };

  const k = clamp(amt * 0.85, 0, 0.85);

  for (let y=0; y<h; y++){
    for (let x=0; x<w; x++){
      const i = (y*w + x)*4;

      const r = sample(x+rx, y+ry, 0);
      const g = sample(x+gx, y+gy, 1);
      const b = sample(x+bx, y+by, 2);

      out[i]   = d[i]   * (1-k) + r * k;
      out[i+1] = d[i+1] * (1-k) + g * k;
      out[i+2] = d[i+2] * (1-k) + b * k;
      out[i+3] = 255;
    }
  }

  img.data.set(out);
}

function noise(img, amt){
  const d = img.data;
  const n = amt * 26;
  for (let i=0; i<d.length; i+=4){
    const r = (Math.random()*2-1) * n;
    d[i]   = clamp(d[i] + r, 0, 255);
    d[i+1] = clamp(d[i+1] + r, 0, 255);
    d[i+2] = clamp(d[i+2] + r, 0, 255);
  }
}

function falseColor(img, amt){
  const d = img.data;
  const k = amt;
  for (let i=0; i<d.length; i+=4){
    const lum = (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]) / 255;
    const r = clamp(255*(1-lum)*(0.6+0.4*k) + 40*k, 0, 255);
    const g = clamp(255*(lum)  *(0.8+0.2*k) + 30*k, 0, 255);
    const b = clamp(255*(0.35 + 0.65*Math.sin(lum*3.1415))*(0.7+0.3*k), 0, 255);

    d[i]   = clamp(d[i]*(1-k) + r*k, 0, 255);
    d[i+1] = clamp(d[i+1]*(1-k) + g*k, 0, 255);
    d[i+2] = clamp(d[i+2]*(1-k) + b*k, 0, 255);
  }
}

function blockGlitch(img, amt){
  const w = img.width, h = img.height;
  const d = img.data;

  const blocks = Math.floor(6 + amt*40 + bendBurst*45);
  for (let b=0; b<blocks; b++){
    const bw = Math.floor(8 + rand(amt*54 + 18));
    const bh = Math.floor(4 + rand(amt*40 + 12));
    const x0 = Math.floor(rand(w - bw));
    const y0 = Math.floor(rand(h - bh));

    const sx = Math.floor(clamp(x0 + (rand(1)-0.5)*(amt*70 + 20), 0, w-bw));
    const sy = Math.floor(clamp(y0 + (rand(1)-0.5)*(amt*55 + 20), 0, h-bh));

    for (let y=0; y<bh; y++){
      for (let x=0; x<bw; x++){
        const di = ((y0+y)*w + (x0+x))*4;
        const si = ((sy+y)*w + (sx+x))*4;
        d[di]   = d[si];
        d[di+1] = d[si+1];
        d[di+2] = d[si+2];
      }
    }
  }
}

function feedbackPass(amt){
  fbctx.save();
  fbctx.globalAlpha = 0.92 - amt*0.22;
  fbctx.drawImage(frame, 0, 0);
  fbctx.restore();

  fctx.save();
  fctx.globalAlpha = 0.18 + amt*0.36;
  fctx.globalCompositeOperation = 'screen';
  const dx = (rand(1)-0.5) * (amt*9 + bendBurst*12);
  const dy = (rand(1)-0.5) * (amt*7 + bendBurst*9);
  fctx.drawImage(fb, dx, dy);
  fctx.restore();
}

function dataBars(amt){
  const W = frame.width, H = frame.height;
  const bars = Math.floor(2 + amt*6);
  const bw = Math.floor(10 + amt*22);
  fctx.save();
  fctx.globalAlpha = 0.55;
  for (let i=0; i<bars; i++){
    const x = Math.floor(rand(W));
    const hh = Math.floor(H*(0.35 + rand(0.65)));
    fctx.fillStyle = `rgba(${Math.floor(rand(255))},${Math.floor(rand(255))},${Math.floor(rand(255))},1)`;
    fctx.fillRect(x, Math.floor(rand(H-hh)), bw, hh);
  }
  fctx.restore();
}

function drawDate(){
  const W = frame.width, H = frame.height;
  const pad = Math.floor(W * 0.03);
  fctx.save();
  fctx.imageSmoothingEnabled = false;
  fctx.font = `900 ${Math.floor(W*0.05)}px ui-monospace, Menlo, Monaco, Consolas, monospace`;
  fctx.fillStyle = "rgba(255,220,80,0.95)";
  fctx.shadowColor = "rgba(0,0,0,0.65)";
  fctx.shadowBlur = 8;
  fctx.fillText(dateStamp(), pad, H - pad);
  fctx.restore();
}

/* ----------- DISPLAY (LETTERBOX) ----------- */

function drawFrameToScreen(){
  const SW = screen.width, SH = screen.height;
  const FW = frame.width, FH = frame.height;

  // contain scale (no stretching)
  const scale = Math.min(SW / FW, SH / FH);
  const dw = Math.round(FW * scale);
  const dh = Math.round(FH * scale);
  const dx = Math.floor((SW - dw) / 2);
  const dy = Math.floor((SH - dh) / 2);

  sctx.save();
  sctx.setTransform(1,0,0,1,0,0);
  sctx.imageSmoothingEnabled = false;
  sctx.fillStyle = "#000";
  sctx.fillRect(0,0,SW,SH);
  sctx.drawImage(frame, 0,0,FW,FH, dx,dy,dw,dh);
  sctx.restore();
}

/* ----------- PRESETS ----------- */

function applyPreset(name){
  const set = (id, v) => document.getElementById(id).checked = v;
  const setS = (id, v) => document.getElementById(id).value = v;

  if (name === "mall"){
    set("t_blocks", true); set("t_bit", true); set("t_feedback", true);
    set("t_noise", true); set("t_false", false); set("t_bars", false); set("t_date", true);
    setS("s_grit", 70); setS("s_corrupt", 48); setS("s_chroma", 22); setS("s_palette", 18); setS("s_res", 380);
  }
  if (name === "buffer"){
    set("t_blocks", true); set("t_bit", true); set("t_feedback", true);
    set("t_noise", true); set("t_false", true); set("t_bars", true); set("t_date", true);
    setS("s_grit", 82); setS("s_corrupt", 70); setS("s_chroma", 35); setS("s_palette", 62); setS("s_res", 320);
  }
  if (name === "neon"){
    set("t_blocks", true); set("t_bit", true); set("t_feedback", true);
    set("t_noise", true); set("t_false", true); set("t_bars", false); set("t_date", true);
    setS("s_grit", 86); setS("s_corrupt", 62); setS("s_chroma", 40); setS("s_palette", 85); setS("s_res", 300);
  }
  if (name === "digi"){
    set("t_blocks", false); set("t_bit", false); set("t_feedback", false);
    set("t_noise", true); set("t_false", false); set("t_bars", false); set("t_date", true);
    setS("s_grit", 26); setS("s_corrupt", 14); setS("s_chroma", 12); setS("s_palette", 18); setS("s_res", 560);
  }

  resizeAll();
}

/* ----------- ACTIONS ----------- */

function snap(){
  // SNAP saves the TRUE cropped frame (1:1 or 16:9 etc.)
  const a = document.createElement('a');
  a.download = `trashcam_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
  a.href = frame.toDataURL('image/png');
  a.click();
}

async function startCamera(){
  if (stream) stream.getTracks().forEach(t => t.stop());

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  video.srcObject = stream;
  await new Promise(res => video.onloadedmetadata = res);

  resizeAll();
  requestAnimationFrame(loop);
}

/* ----------- MAIN LOOP ----------- */

function loop(){
  const mode = chosenMode();
  const key = [
    mode,
    ui.format.value,
    ui.s_res.value,
    (window.visualViewport?.width||0),
    (window.visualViewport?.height||0),
    video.videoWidth, video.videoHeight
  ].join('|');

  if (key !== lastKey){
    lastKey = key;
    resizeAll();
  }

  const grit = parseInt(ui.s_grit.value,10)/100;
  const corrupt = parseInt(ui.s_corrupt.value,10)/100;
  const chroma = parseInt(ui.s_chroma.value,10)/100;
  const palette = parseInt(ui.s_palette.value,10)/100;

  bendBurst = Math.max(0, bendBurst - 0.04);

  // 1) draw camera into low-res buffer cropped to frame aspect
  lctx.setTransform(1,0,0,1,0,0);
  lctx.clearRect(0,0,low.width, low.height);
  drawVideoCoverTo(lctx, low.width, low.height);

  // 2) process pixels on low buffer
  let img = lctx.getImageData(0,0,low.width, low.height);

  if (ui.t_blocks.checked) blockGlitch(img, corrupt);
  if (ui.t_bit.checked) bitcrush(img, grit);
  chromaSplit(img, chroma);
  if (ui.t_noise.checked) noise(img, grit);
  if (ui.t_false.checked) falseColor(img, palette);

  lctx.putImageData(img, 0, 0);

  // 3) upscale low -> frame (no stretch; same aspect by design)
  fctx.save();
  fctx.setTransform(1,0,0,1,0,0);
  fctx.imageSmoothingEnabled = false;
  fctx.clearRect(0,0,frame.width, frame.height);
  fctx.drawImage(low, 0,0,low.width,low.height, 0,0,frame.width,frame.height);
  fctx.restore();

  // 4) overlays on frame
  if (ui.t_feedback.checked) feedbackPass(corrupt);
  if (ui.t_bars.checked) dataBars(corrupt + bendBurst*0.6);
  if (ui.t_date.checked) drawDate();

  // 5) draw frame -> screen with letterbox contain (no stretch)
  drawFrameToScreen();

  requestAnimationFrame(loop);
}

/* ----------- UI EVENTS ----------- */

ui.hud.addEventListener('click', () => {
  panel.classList.toggle('hidden');
});

ui.flip.addEventListener('click', async () => {
  facingMode = (facingMode === "environment") ? "user" : "environment";
  await startCamera();
});

ui.bend.addEventListener('click', () => {
  bendBurst = 1.0;
});

ui.snap.addEventListener('click', snap);

document.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

ui.format.addEventListener('change', () => {
  lastKey = "";
  resizeAll();
});

// rotate / viewport changes (AUTO flips here)
if (window.visualViewport){
  window.visualViewport.addEventListener('resize', () => { lastKey=""; resizeAll(); });
  window.visualViewport.addEventListener('scroll', () => { lastKey=""; resizeAll(); });
}
window.addEventListener('orientationchange', () => { lastKey=""; resizeAll(); });
window.addEventListener('resize', () => { lastKey=""; resizeAll(); });

/* ----------- BOOT ----------- */
(async () => {
  try{
    ui.tip.innerHTML = "AUTO flips when you rotate • SNAP saves true crop (1:1 or 16:9).";
    await startCamera();
  }catch(err){
    document.body.innerHTML = `
      <div style="padding:20px;font-family:system-ui;color:#fff">
        <h2>Camera blocked</h2>
        <p>Open in <b>Safari</b>, allow Camera permissions, and make sure you’re on <b>HTTPS</b>.</p>
        <pre style="white-space:pre-wrap;color:#bbb">${String(err)}</pre>
      </div>
    `;
    console.error(err);
  }
})();
