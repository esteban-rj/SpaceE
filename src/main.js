import { CONFIG, createState, step, forcesOf, captureConditions, lessonFor, clamp, normalizeAngle } from './physics.js';
import { FlightRenderer } from './render.js';
import { DECISION_STAGES, PROFILES, decisionTelemetry, automaticControls, nextDecisionStage } from './autopilot.js';

const $ = id => document.getElementById(id);
const renderer = new FlightRenderer($('flight-canvas'));
let state = createState();
let paused = false, vectors = true, accumulator = 0, lastFrame = 0, uiElapsed = 0;
let previousLesson = '', resultShown = false, dialogPaused = false, practiceWaiting = false;
let seen = new Set(), events = [], keys = new Set(), touches = new Set();
let automatic = null;
const pointerControls = new Map();
const number = (n, digits=1) => (Math.abs(n)<.5*10**-digits?0:n).toFixed(digits).replace('-', '−');
const speedLabel = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const seconds = t => `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const active = () => ['ready','flying'].includes(state.status);
const canPilot = () => active() && !paused && !automatic?.engaged;

function record(id,text) {
  if(seen.has(id))return;
  seen.add(id);events.unshift({time:state.time,text});events=events.slice(0,4);
  $('event-list').replaceChildren(...events.map(event=>{
    const li=document.createElement('li'),time=document.createElement('time'),span=document.createElement('span');
    time.textContent=seconds(event.time);span.textContent=event.text;li.append(time,span);return li;
  }));
  $('event-count').textContent=String(seen.size).padStart(2,'0');
}

function clearInput() {
  keys.clear();touches.clear();pointerControls.clear();
  document.querySelectorAll('.hold-button').forEach(b=>b.classList.remove('held'));
}

function reset(mode=state.mode) {
  automatic?.request?.abort();
  automatic = mode === 'automatic' ? {
    engaged: true, index: 0, profile: null, stage: null, request: null,
    decisions: new Map(), error: null, inputTokens: 0, estimatedUsd: 0, receipts: 0,
  } : null;
  state=createState(mode);paused=false;accumulator=0;lastFrame=0;resultShown=false;
  clearInput();seen=new Set();events=[];renderer.reset();
  $('result-overlay').hidden=true;$('pause-overlay').hidden=true;
  $('throttle').value=Math.round(state.throttle*100);
  $('mode-name').textContent=automatic?'VUELO AUTOMÁTICO':mode==='practice'?'APROXIMACIÓN':'VUELO COMPLETO';
  $('mission-objective').textContent=mode==='practice'?'Un encuentro suave con los brazos de la torre.':'Supera los 160 m y regresa a los brazos.';
  document.querySelectorAll('[data-mode]').forEach(button=>{
    const selected=button.dataset.mode===mode;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',selected);
  });
  record('initial',state.onPad?'En plataforma. El suelo equilibra el peso del cohete.':`A 143 m, con un descenso inicial de ${Math.abs(state.vy)} m/s.`);
  practiceWaiting=mode!=='mission';
  if(practiceWaiting)setPaused(true);
  previousLesson='';updateUI();
  updateFlightControls();
  updateAutomaticUI();
}

function setPaused(value) {
  if(!active() || automatic?.error)return;
  paused=value;accumulator=0;lastFrame=0;clearInput();
  if(!paused)practiceWaiting=false;
  updateUI();
  updateFlightControls();
}

function updateAutomaticUI() {
  $('automatic-panel').hidden = !automatic;
  if (!automatic) return;
  const { engaged, stage, request, error, profile, decisions, index, inputTokens, estimatedUsd, receipts } = automatic;
  let status = 'A la espera del inicio';
  if (!active()) status = 'Vuelo finalizado';
  else if (error) status = 'Consulta interrumpida';
  else if (!engaged) status = 'Control manual';
  else if (request) status = `Consultando · ${stage.label}`;
  else if (profile) status = `En vuelo · ${stage.label}`;

  $('automatic-status').textContent = status;
  $('automatic-decisions').replaceChildren(...DECISION_STAGES.map((phase, phaseIndex) => {
    const choice = PROFILES[decisions.get(phase.id)];
    const row = document.createElement('li');
    const header = document.createElement('div');
    header.className = 'decision-phase';
    const title = document.createElement('span');
    const altitude = document.createElement('span');
    title.textContent = phase.label;
    altitude.textContent = phase.id === 'launch' ? 'Plataforma' : `${phase.altitude} m`;
    header.append(title, altitude);

    const decision = document.createElement('strong');
    row.append(header, decision);
    if (choice) {
      row.dataset.status = 'chosen';
      decision.textContent = choice.label;
      const targets = document.createElement('p');
      targets.textContent = phase.id === 'launch'
        ? `Ascenso objetivo hasta ${speedLabel.format(choice.ascentSpeed)} m/s`
        : `Descenso objetivo ${speedLabel.format(choice.cruiseSpeed)} m/s · brazos ${speedLabel.format(choice.captureSpeed)} m/s`;
      row.append(targets);
    } else if (request && phase.id === stage.id) {
      row.dataset.status = 'pending';
      decision.textContent = 'Consultando…';
    } else if (phaseIndex < index) {
      decision.textContent = 'Sin decisión';
    } else {
      decision.textContent = engaged && active() && !error ? 'Por consultar' : 'No consultada';
    }
    return row;
  }));

  if (!engaged) $('mission-objective').textContent = 'Control manual';
  else if (profile && !request && !error) $('mission-objective').textContent = `${stage.label} · ${PROFILES[profile].label}`;
  const cost = receipts ? ` · ${inputTokens} tokens · USD ${estimatedUsd.toFixed(6)} estimados` : '';
  const partial = index > receipts && !request ? ' · uso parcial' : '';
  $('automatic-usage').textContent = `${index}/${DECISION_STAGES.length} consultas${cost}${partial}`;
  $('takeover-button').hidden = !engaged || !active();
}

async function chooseManeuver(run, stage) {
  const request = new AbortController();
  run.stage = stage;
  run.request = request;
  run.index += 1;
  accumulator = 0;
  updateUI();
  updateFlightControls();
  updateAutomaticUI();
  try {
    const response = await fetch('/api/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decisionTelemetry(state, stage, run.profile)),
      signal: request.signal,
    });
    const result = await response.json().catch(() => null);
    if (run !== automatic || request.signal.aborted) return;
    if (result?.usage) {
      run.inputTokens += result.usage.inputTokens;
      run.estimatedUsd += result.usage.estimatedUsd;
      run.receipts += 1;
    }
    if (!response.ok || !Object.hasOwn(PROFILES, result?.profile)) {
      run.error = result?.error || 'El servidor local no devolvió una decisión válida.';
      return;
    }
    run.profile = result.profile;
    run.decisions.set(stage.id, run.profile);
    record(`decision-${stage.id}`, `OpenAI eligió ${PROFILES[run.profile].label.toLowerCase()} para la fase de ${stage.label.toLowerCase()}.`);
  } catch {
    if (!request.signal.aborted) run.error = 'No se pudo conectar con el servidor local de Decisions.';
  } finally {
    if (run === automatic && request === run.request) {
      run.request = null;
      accumulator = 0;
      lastFrame = 0;
      updateUI();
      updateFlightControls();
      updateAutomaticUI();
    }
  }
}

function takeManualControl() {
  if (!automatic?.engaged || !active()) return;
  automatic.request?.abort();
  automatic.request = null;
  automatic.engaged = false;
  automatic.error = null;
  record('takeover', 'Control manual retomado en el mismo punto del vuelo.');
  setPaused(false);
  updateAutomaticUI();
  $('throttle').focus();
}

function updateFlightControls() {
  const pending = Boolean(automatic?.request);
  const error = automatic?.error;
  const blocked = pending || Boolean(error);
  const automaticStart = practiceWaiting && automatic?.engaged;
  $('pause-overlay').hidden = !active() || (!paused && !blocked);
  $('resume-button').hidden = blocked;
  $('overlay-takeover').hidden = !blocked;
  $('pause-button').disabled = !active() || Boolean(error);
  $('throttle').disabled = !canPilot();
  document.querySelectorAll('.hold-button').forEach(button => button.disabled = !canPilot());
  $('pause-eyebrow').textContent = blocked || automaticStart ? 'OPENAI DECISIONS' : practiceWaiting ? 'APROXIMACIÓN · PUNTO DE PARTIDA' : 'SIMULACIÓN EN PAUSA';
  $('pause-title').textContent = error ? 'Consulta interrumpida' : pending ? `${automatic.stage.label} en evaluación` : automaticStart ? 'Despegue y captura automáticos' : practiceWaiting ? 'El regreso empieza aquí.' : 'Un momento para entender.';
  $('pause-copy').textContent = error || (pending ? 'La simulación se mantiene en pausa mientras llega la decisión.' : automaticStart ? 'Cuatro consultas a OpenAI por misión, aproximadamente USD 0,00015. Puedes tomar el control cuando quieras.' : practiceWaiting ? 'A 143 m, con un descenso inicial de 4 m/s.' : 'La física y el combustible están detenidos.');
  $('resume-label').textContent = automaticStart ? 'Iniciar vuelo automático' : practiceWaiting ? 'Iniciar aproximación' : 'Continuar vuelo';
  $('pause-icon').textContent = paused ? '▷' : 'Ⅱ';
  $('pause-label').textContent = paused ? 'Continuar' : 'Pausar';
  $('pause-button').setAttribute('aria-label',paused?'Continuar vuelo (P)':'Pausar vuelo (P)');
}

function setVectors() {
  vectors=!vectors;$('vector-button').classList.toggle('active',vectors);
  $('vector-button').setAttribute('aria-pressed',vectors);
  document.querySelector('.canvas-legend').hidden=!vectors;
}

function updateUI() {
  const f=forcesOf(state),conditions=captureConditions(state);
  $('altitude').textContent=number(state.y);
  $('vertical-speed').textContent=number(state.vy);
  $('acceleration').textContent=number(state.ay);
  $('vertical-note').textContent=state.vy>0.1?'ascendiendo ↑':state.vy<-.1?'descendiendo ↓':'en reposo';
  $('fuel').textContent=String(Math.max(0,Math.round(state.fuel/CONFIG.initialFuel*100)));
  $('fuel-fill').style.width=`${state.fuel/CONFIG.initialFuel*100}%`;
  $('fuel-fill').style.background=state.fuel<200?'#d59060':'#84a266';
  $('throttle-value').textContent=String(Math.round(state.throttle*100));
  $('thrust-value').textContent=`/ ${number(f.thrust/1000)} kN`;
  $('throttle').value=Math.round(state.throttle*100);
  $('angle-value').textContent=`${number(normalizeAngle(state.angle)*180/Math.PI)}°`;
  $('attitude-needle').style.transform=`rotate(${state.angle}rad)`;
  $('mass').textContent=`${Math.round(f.mass).toLocaleString('es-CO')} kg`;
  $('flow').textContent=`${number(f.flow)} kg/s`;
  $('force-thrust').textContent=`${number(f.ty/1000)} kN`;
  $('force-weight').textContent=`${number(f.weight/1000)} kN`;
  $('force-drag').textContent=`${number(f.dy/1000)} kN`;
  $('normal-row').hidden=!(state.onPad||state.status==='captured');
  $('normal-label').textContent=state.status==='captured'?'Apoyo de la torre':'Apoyo del suelo';
  $('force-normal').textContent=`${number(f.normal/1000)} kN`;
  $('target-offset').textContent=`${number(state.x-CONFIG.targetX)} m`;
  $('target-speed').textContent=`${number(state.vy)} m/s`;
  $('target-horizontal').textContent=`${number(state.vx)} m/s`;
  $('target-angle').textContent=`${number(normalizeAngle(state.angle)*180/Math.PI)}°`;
  $('target-rotation').textContent=`${number(Math.abs(state.omega)*180/Math.PI)}°/s`;
  for(const [id,key] of [['target-offset','position'],['target-speed','vertical'],['target-horizontal','horizontal'],['target-angle','angle'],['target-rotation','rotation']])$(id).parentElement.classList.toggle('valid',conditions[key]);
  $('flight-clock').textContent=`T+ ${seconds(state.time)}.${Math.floor(state.time%1*10)}`;
  $('altitude-badge').classList.toggle('complete',state.milestone);
  $('milestone-label').textContent=state.mode==='practice'?'PRÁCTICA · CAPTURA HABILITADA':state.milestone?'COTA ALCANZADA · CAPTURA HABILITADA':'COTA DE MISIÓN · 160 m';
  $('flight-status').textContent=automatic?.error?'CONSULTA INTERRUMPIDA':automatic?.request?'CONSULTANDO OPENAI':practiceWaiting?'LISTO PARA VOLAR':paused?'EN PAUSA':state.status==='captured'?'CAPTURA COMPLETADA':state.status==='crashed'?'VUELO FINALIZADO':state.onPad?'EN PLATAFORMA':state.vy>1?'EN ASCENSO':state.vy< -1?'EN DESCENSO':'EN VUELO';
  const lesson=lessonFor(state);
  if(previousLesson!==lesson.id || $('lesson-title').textContent!==lesson.title){
    previousLesson=lesson.id;
    for(const [id,value] of Object.entries({'lesson-number':lesson.id,'lesson-symbol':lesson.symbol,'lesson-category':lesson.category,'lesson-title':lesson.title,'lesson-copy':lesson.copy,'lesson-equation':lesson.equation,'equation-caption':lesson.caption,'physics-footnote':lesson.note}))$(id).textContent=value;
  }
}

function observeFlight(previous) {
  if(previous.onPad && !state.onPad)record('liftoff','Despegue. El empuje vertical supera al peso y la fuerza neta apunta hacia arriba.');
  if(state.fuel<(state.mode==='practice'?800:CONFIG.initialFuel)*.8)record('mass','El combustible se convierte en gases. Menos masa cambia la respuesta al mismo empuje.');
  if(state.vy>2 && state.throttle<.03 && !state.onPad)record('coast','Ascenso sin motor: la inercia mantiene el movimiento mientras la gravedad lo frena.');
  if(previous.vy>0 && state.vy<=0 && state.y>30)record('apogee',`Apogeo a ${number(state.y)} m. La velocidad vertical pasa por cero; la gravedad continúa.`);
  if(!previous.milestone && state.milestone)record('milestone','Cota de 160 m alcanzada. La misión ya permite completar la captura al regresar.');
  if(state.vy< -1 && state.ay>1)record('braking','Velocidad hacia abajo y aceleración hacia arriba: el descenso se está frenando.');
  if(state.fuel===0)record('empty','Depósito vacío. La gravedad y el aire siguen cambiando la velocidad.');
  if(!active() && !resultShown)showResult();
}

const reasons={
  vertical:'La velocidad vertical de encuentro superó los 6 m/s. Los brazos no pudieron absorber ese movimiento.',
  horizontal:'El encuentro tuvo más de 3.5 m/s de velocidad lateral. Los brazos necesitan un movimiento horizontal pequeño.',
  angle:'El cohete llegó demasiado inclinado o seguía girando. La captura admite ±12° y una rotación menor a 20°/s.',
  milestone:'El cohete llegó a los brazos sin superar la cota de 160 m de esta misión. La práctica de aproximación no necesita esa cota.',
  ground:'El cohete entró en contacto con el suelo. La torre captura el vehículo a 100 m de altura.',
  tower:'El cohete hizo contacto con la estructura de la torre. Su volumen también cuenta al moverse e inclinarse.',
  alignment:'El cohete tocó los brazos fuera del corredor de captura. El centro debe cruzar a una distancia horizontal de ±8 m.',
  range:'El cohete salió del área de simulación: 1 600 m de altitud o 1 000 m de distancia horizontal.',
};

function showResult() {
  resultShown=true;clearInput();
  const success=state.status==='captured';
  record('result',success?'Captura completa. La torre sostiene ahora el peso del cohete.':`Fin del vuelo. ${reasons[state.outcome]||'Contacto con los brazos.'}`);
  $('result-eyebrow').textContent=success?'CAPTURA COMPLETADA':'CADA VUELO ENSEÑA';
  $('result-title').textContent=success?'En buenas manos.':'Otro intento, otra idea.';
  $('result-description').textContent=success?'El cohete regresó alineado y con poca velocidad. Los brazos recibieron su movimiento y ahora sostienen su peso.':reasons[state.outcome];
  const speed=Math.hypot(state.capture?.vx??state.impact?.vx??state.vx,state.capture?.vy??state.impact?.vy??state.vy);
  const stats=[['ALTITUD MÁX.',`${Math.round(state.maxAltitude)} m`],['ENCUENTRO',`${number(speed)} m/s`],['COMBUSTIBLE',`${Math.round(state.fuel/CONFIG.initialFuel*100)} %`]];
  $('result-stats').replaceChildren(...stats.map(([label,value])=>{const span=document.createElement('span'),b=document.createElement('b');span.textContent=label;b.textContent=value;span.append(b);return span;}));
  $('result-overlay').hidden=false;
  $('result-secondary-button').hidden = state.mode === 'practice';
  $('result-secondary-button').textContent = automatic ? 'Ver decisiones de OpenAI' : 'Practicar aproximación';
  // Announce the result without moving focus away from the pilot's controls.
  updateUI();
  updateFlightControls();
  updateAutomaticUI();
}

function frame(now) {
  const delta=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;
  if(!paused && !automatic?.request && !automatic?.error && !$('about-dialog').open && active()){
    accumulator+=delta;
    const controls={rotation:Number(keys.has('ArrowRight')||keys.has('KeyD')||touches.has('right'))-Number(keys.has('ArrowLeft')||keys.has('KeyA')||touches.has('left')),
      throttleDelta:(Number(keys.has('ArrowUp')||keys.has('KeyW'))-Number(keys.has('ArrowDown')||keys.has('KeyS')))*.45,
      cut:keys.has('KeyX')};
    while(accumulator>=CONFIG.fixedStep && active()){
      let appliedControls = controls;
      if (automatic?.engaged) {
        const stage = nextDecisionStage(state, automatic.index);
        if (stage) {
          chooseManeuver(automatic, stage);
          break;
        }
        appliedControls = automaticControls(state, automatic.profile);
      }
      const previous={onPad:state.onPad,vy:state.vy,milestone:state.milestone};
      step(state,appliedControls);observeFlight(previous);accumulator-=CONFIG.fixedStep;
    }
  }
  uiElapsed+=delta;
  if(uiElapsed>.08){updateUI();uiElapsed=0;}
  renderer.draw(state,vectors,state.time);
  requestAnimationFrame(frame);
}

document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>reset(button.dataset.mode)));
$('throttle').addEventListener('input',event=>{if(canPilot()){state.throttle=Number(event.target.value)/100;updateUI();}});
$('pause-button').addEventListener('click',()=>setPaused(!paused));
$('resume-button').addEventListener('click',()=>setPaused(false));
$('reset-button').addEventListener('click',()=>reset());
$('retry-button').addEventListener('click',()=>reset());
$('inspect-result').addEventListener('click',()=>{$('result-overlay').hidden=true;$('reset-button').focus();});
$('result-secondary-button').addEventListener('click', () => {
  if (automatic) {
    $('automatic-title').focus({ preventScroll: true });
    $('automatic-panel').scrollIntoView({ block: 'start' });
  } else {
    reset('practice');
  }
});
$('vector-button').addEventListener('click',setVectors);
$('takeover-button').addEventListener('click',takeManualControl);
$('overlay-takeover').addEventListener('click',takeManualControl);

for(const button of document.querySelectorAll('.hold-button')){
  button.addEventListener('pointerdown',event=>{
    if(!canPilot())return;
    event.preventDefault();button.setPointerCapture(event.pointerId);
    pointerControls.set(event.pointerId,button.dataset.control);touches.add(button.dataset.control);button.classList.add('held');
  });
  const release=event=>{
    pointerControls.delete(event.pointerId);
    touches=new Set(pointerControls.values());
    button.classList.toggle('held',touches.has(button.dataset.control));
  };
  button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
}

document.addEventListener('keydown',event=>{
  if($('about-dialog').open || event.ctrlKey || event.metaKey || event.altKey)return;
  const editable=event.target.matches('textarea,select,[contenteditable="true"],input:not([type="range"])') || (event.target.matches('input[type="range"]') && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space'].includes(event.code));
  if(editable)return;
  const handled=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyS','KeyA','KeyD','KeyX','KeyP','Space','KeyR','KeyV'];
  if(!handled.includes(event.code))return;
  if(event.code==='Space' && event.target.closest('button,a'))return;
  event.preventDefault();
  if(event.repeat)return;
  if(event.code==='KeyP'||event.code==='Space')setPaused(!paused);
  else if(event.code==='KeyR')reset();
  else if(event.code==='KeyV')setVectors();
  else if(canPilot()){
    keys.add(event.code);
    if(event.code==='KeyX'){state.throttle=0;updateUI();}
  }
});
document.addEventListener('keyup',event=>keys.delete(event.code));
window.addEventListener('blur',()=>{clearInput();if(active()&&!state.onPad)setPaused(true);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearInput();if(active()&&!state.onPad)setPaused(true);}});

function openAbout(){
  dialogPaused=paused;if(active())setPaused(true);$('about-dialog').showModal();
}
for(const id of ['about-button','footer-about'])$(id).addEventListener('click',openAbout);
for(const id of ['close-about','about-done'])$(id).addEventListener('click',()=>$('about-dialog').close());
$('about-dialog').addEventListener('close',()=>{if(active()&&!dialogPaused)setPaused(false);});

reset();requestAnimationFrame(frame);
