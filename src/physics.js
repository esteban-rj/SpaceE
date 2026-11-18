// Units: metres, seconds, kilograms, newtons. Positive y is upward.
export const CONFIG = Object.freeze({
  gravity: 9.81, dryMass: 1800, initialFuel: 1200, maxThrust: 60000,
  specificImpulse: 230, seaLevelDensity: 1.225, scaleHeight: 8500,
  dragArea: 3.2, rocketHeight: 24, rocketRadius: 3.2, launchX: -75,
  targetX: 0, targetY: 100, captureHalfWidth: 8,
  maxCaptureVerticalSpeed: 6, maxCaptureHorizontalSpeed: 3.5,
  maxCaptureAngle: 12 * Math.PI / 180, maxCaptureAngularSpeed: 20 * Math.PI / 180,
  missionAltitude: 160, towerLeft: 23, towerRight: 40, towerHeight: 135,
  attitudeAcceleration: 1.1, attitudeDamping: 3.6, maxAngularSpeed: 0.5,
  maxAltitude: 1600, worldLimit: 1000, fixedStep: 1 / 120,
});
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const normalizeAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
export const massOf = state => CONFIG.dryMass + state.fuel;

export function createState(mode = 'mission') {
  const practice = mode === 'practice';
  const altitude = practice ? 143 : CONFIG.rocketHeight / 2;
  const state = {
    mode, x: practice ? -3 : CONFIG.launchX, y: altitude,
    vx: practice ? 0.3 : 0, vy: practice ? -4 : 0,
    angle: 0, omega: 0, fuel: practice ? 800 : CONFIG.initialFuel,
    throttle: practice ? 0.42 : 0, time: 0, status: practice ? 'flying' : 'ready',
    maxAltitude: altitude, milestone: practice,
    ax: 0, ay: 0, outcome: null, impact: null, capture: null,
    onPad: !practice, lifted: practice,
  };
  const f = forcesOf(state);
  state.ax = f.ax;
  state.ay = state.onPad ? 0 : f.ay;
  return state;
}

export function forcesOf(state) {
  const mass = massOf(state);
  const thrust = state.fuel > 0 ? clamp(state.throttle, 0, 1) * CONFIG.maxThrust : 0;
  const tx = Math.sin(state.angle) * thrust;
  const ty = Math.cos(state.angle) * thrust;
  const density = CONFIG.seaLevelDensity * Math.exp(-Math.max(0, state.y) / CONFIG.scaleHeight);
  const speed = Math.hypot(state.vx, state.vy);
  const dragFactor = 0.5 * density * CONFIG.dragArea * speed;
  const dx = -dragFactor * state.vx;
  const dy = -dragFactor * state.vy;
  const weight = mass * CONFIG.gravity;
  const normal = state.onPad || state.status === 'captured' ? Math.max(0, weight - ty - dy) : 0;
  return {mass, thrust, tx, ty, dx, dy, weight, normal,
    ax: (tx + dx) / mass, ay: (ty + dy - weight + normal) / mass,
    flow: thrust / (CONFIG.specificImpulse * CONFIG.gravity), density};
}

export function captureConditions(state) {
  return {
    position: Math.abs(state.x - CONFIG.targetX) <= CONFIG.captureHalfWidth,
    vertical: state.vy <= 0 && state.vy >= -CONFIG.maxCaptureVerticalSpeed,
    horizontal: Math.abs(state.vx) <= CONFIG.maxCaptureHorizontalSpeed,
    angle: Math.abs(normalizeAngle(state.angle)) <= CONFIG.maxCaptureAngle,
    rotation: Math.abs(state.omega) <= CONFIG.maxCaptureAngularSpeed,
    milestone: state.milestone,
  };
}

function finish(state, status, reason) {
  state.status = status;
  state.outcome = reason;
  state.throttle = 0;
}

// Integrates in-place. Call at the fixed timestep; rendering never alters state.
export function step(state, controls = {}, dt = CONFIG.fixedStep) {
  if (!['ready', 'flying'].includes(state.status) || dt <= 0) return state;
  const previous = {x: state.x, y: state.y, vx: state.vx, vy: state.vy,
    angle: state.angle, omega: state.omega};
  if (controls.throttleDelta) state.throttle = clamp(state.throttle + controls.throttleDelta * dt, 0, 1);
  if (controls.cut) state.throttle = 0;
  const rotation = clamp(controls.rotation || 0, -1, 1);
  // Idealised attitude jets brake rotation when released; no automatic levelling.
  state.omega += (rotation * CONFIG.attitudeAcceleration - CONFIG.attitudeDamping * state.omega) * dt;
  state.omega = clamp(state.omega, -CONFIG.maxAngularSpeed, CONFIG.maxAngularSpeed);
  state.angle = normalizeAngle(state.angle + state.omega * dt);

  // Average consumed mass over this step; limit thrust by available propellant.
  const demandedThrust = clamp(state.throttle, 0, 1) * CONFIG.maxThrust;
  const demand = demandedThrust / (CONFIG.specificImpulse * CONFIG.gravity) * dt;
  const burned = Math.min(state.fuel, demand);
  const actualThrottle = demandedThrust > 0 && demand > 0 ? state.throttle * burned / demand : 0;
  const f = forcesOf({...state, fuel: state.fuel - burned / 2, throttle: actualThrottle});
  state.fuel = Math.max(0, state.fuel - burned);

  if (state.onPad) {
    // A vertical rail holds the vehicle on the pad until thrust exceeds weight.
    if (f.ty > f.weight) {
      state.onPad = false;
      state.lifted = true;
      state.status = 'flying';
    } else {
      state.ax = 0; state.ay = 0;
      state.angle = 0; state.omega = 0;
      return state;
    }
  }
  state.time += dt;
  state.ax = f.ax;
  state.ay = (f.ty + f.dy - f.weight) / f.mass;
  // Velocity Verlet-like constant-acceleration position step; forces re-evaluated each tick.
  state.x += state.vx * dt + 0.5 * state.ax * dt * dt;
  state.y += state.vy * dt + 0.5 * state.ay * dt * dt;
  state.vx += state.ax * dt;
  state.vy += state.ay * dt;
  state.maxAltitude = Math.max(state.maxAltitude, state.y);
  if (state.maxAltitude >= CONFIG.missionAltitude) state.milestone = true;

  // Swept crossing prevents tunnelling through the thin capture plane.
  if (previous.y > CONFIG.targetY && state.y <= CONFIG.targetY && state.vy < 0) {
    const t = (previous.y - CONFIG.targetY) / (previous.y - state.y);
    const crossing = {...state, y: CONFIG.targetY};
    for (const key of ['x', 'vx', 'vy', 'omega']) crossing[key] = previous[key] + (state[key] - previous[key]) * t;
    crossing.angle = normalizeAngle(previous.angle + normalizeAngle(state.angle - previous.angle) * t);
    const checks = captureConditions(crossing);
    if (checks.position) {
      if (Object.values(checks).every(Boolean)) {
        state.capture = {vx: crossing.vx, vy: crossing.vy, angle: crossing.angle, time: state.time};
        state.x = CONFIG.targetX; state.y = CONFIG.targetY;
        state.vx = 0; state.vy = 0; state.ax = 0; state.ay = 0; state.omega = 0; state.angle = 0;
        finish(state, 'captured', 'captured');
        return state;
      }
      state.impact = {vx: crossing.vx, vy: crossing.vy, angle: crossing.angle};
      state.x = crossing.x; state.y = CONFIG.targetY;
      state.vx = crossing.vx; state.vy = crossing.vy; state.angle = crossing.angle; state.omega = crossing.omega;
      const reason = !checks.milestone ? 'milestone' : !checks.vertical ? 'vertical' :
        !checks.horizontal ? 'horizontal' : !checks.angle || !checks.rotation ? 'angle' : 'arms';
      finish(state, 'crashed', reason);
      return state;
    } else if (crossing.x >= -14 && crossing.x <= CONFIG.towerLeft) {
      state.impact = {vx: crossing.vx, vy: crossing.vy, angle: crossing.angle};
      state.x = crossing.x; state.y = CONFIG.targetY;
      state.vx = crossing.vx; state.vy = crossing.vy; state.angle = crossing.angle; state.omega = crossing.omega;
      finish(state, 'crashed', 'alignment');
      return state;
    }
  }

  // A conservative oriented bounding box detects ground and tower contact.
  const halfWidth = Math.abs(Math.sin(state.angle)) * CONFIG.rocketHeight / 2 + Math.abs(Math.cos(state.angle)) * CONFIG.rocketRadius;
  const halfHeight = Math.abs(Math.cos(state.angle)) * CONFIG.rocketHeight / 2 + Math.abs(Math.sin(state.angle)) * CONFIG.rocketRadius;
  if (state.y - halfHeight <= 0) {
    state.y = halfHeight;
    state.impact = {vx: state.vx, vy: state.vy, angle: state.angle};
    finish(state, 'crashed', 'ground');
  } else if (state.x + halfWidth >= CONFIG.towerLeft && state.x - halfWidth <= CONFIG.towerRight && state.y - halfHeight <= CONFIG.towerHeight) {
    state.impact = {vx: state.vx, vy: state.vy, angle: state.angle};
    finish(state, 'crashed', 'tower');
  } else if (Math.abs(state.x) > CONFIG.worldLimit || state.y > CONFIG.maxAltitude) {
    finish(state, 'crashed', 'range');
  }
  return state;
}

export function lessonFor(s) {
  if (s.status === 'captured') return {id:'09', category:'TRANSFERENCIA DE MOMENTO', symbol:'p', title:'La torre recibe el movimiento.', copy:'Los brazos ejercen una fuerza hacia arriba y frenan el pequeño momento restante del cohete. Al detenerse, la torre sostiene su peso.', equation:'Δp = F · Δt', caption:'Impulso y cantidad de movimiento', note:'La velocidad de encuentro importa: menos momento exige menos impulso de frenado.'};
  if (s.status === 'crashed') return {id:'10', category:'ENERGÍA Y CONTACTO', symbol:'E', title:'El movimiento tiene un coste.', copy:'Un contacto muy rápido concentra el cambio de velocidad en muy poco tiempo. La fuerza del impacto crece con la masa y la velocidad de encuentro.', equation:'Eₖ = ½ m v²', caption:'Energía cinética', note:'Duplicar la velocidad multiplica por cuatro la energía cinética a la misma masa.'};
  if (s.onPad) return {id:'01', category:'FUERZAS EN EQUILIBRIO', symbol:'F', title:'El principio de un viaje.', copy:'La gravedad tira hacia abajo. El suelo responde con una fuerza normal: mientras lo sostiene, la fuerza neta y la aceleración son cero.', equation:'N + Tᵧ − mg = 0', caption:'Equilibrio en la plataforma', note:'El motor expulsa gases hacia abajo y recibe una fuerza opuesta: acción y reacción.'};
  if (Math.abs(s.angle) > 0.13 && s.throttle > 0.12 && s.fuel > 0) return {id:'06', category:'EL EMPUJE ES UN VECTOR', symbol:'θ', title:'Una fuerza, dos direcciones.', copy:'Al inclinarse, el empuje se reparte entre movimiento horizontal y vertical. El motor puede producir la misma fuerza total y sostener menos peso.', equation:'Tₓ = T sen θ · Tᵧ = T cos θ', caption:'Componentes del empuje', note:'La velocidad lateral persiste al volver a la vertical; una fuerza cambia la velocidad, no la posición de golpe.'};
  if (s.fuel <= 0) return {id:'08', category:'CAÍDA Y RESISTENCIA', symbol:'g', title:'Sin gases, no hay empuje.', copy:'El depósito está vacío. La gravedad sigue actuando y el aire se opone a la velocidad; el control de actitud idealizado aún puede orientar el cohete.', equation:'ΣFᵧ = Dᵧ − mg', caption:'Movimiento sin propulsión', note:'El empuje necesita expulsar masa. Un porcentaje de potencia no produce fuerza si no queda combustible.'};
  if (s.vy < -0.8 && s.ay > 0.5) return {id:'05', category:'VELOCIDAD ≠ ACELERACIÓN', symbol:'a', title:'Bajar puede ser frenar.', copy:'El cohete desciende, pero su aceleración apunta hacia arriba. La velocidad y la aceleración tienen signos opuestos: la rapidez de descenso disminuye.', equation:'vᵧ < 0 · aᵧ > 0', caption:'Frenado durante el descenso', note:'La posición sigue bajando hasta que la velocidad vertical alcanza cero.'};
  if (Math.abs(s.vy) < 1.5 && s.y > 40 && s.ay < -2) return {id:'04', category:'EL PUNTO MÁS ALTO', symbol:'h', title:'Quieto, solo un instante.', copy:'Cerca del apogeo, la velocidad vertical pasa por cero. La gravedad no desaparece: la aceleración hacia abajo transforma el ascenso en descenso.', equation:'vᵧ ≈ 0 · aᵧ ≠ 0', caption:'Velocidad cero no significa equilibrio', note:'La energía potencial gravitatoria es máxima cerca de la mayor altura de este vuelo.'};
  if (s.vy > 0.5 && s.throttle < 0.03) return {id:'03', category:'INERCIA Y GRAVEDAD', symbol:'v', title:'El motor calla. El vuelo sigue.', copy:'Sin empuje, el cohete conserva su velocidad ascendente. La gravedad y el aire reducen esa velocidad; apagar el motor no detiene el movimiento de golpe.', equation:'aᵧ ≈ −g + Fₐᵢᵣₑ,ᵧ / m', caption:'Ascenso por inercia', note:'Parte de la energía cinética se convierte en energía potencial al ganar altura.'};
  if (s.vy < -0.8) return {id:'07', category:'GRAVEDAD EN ACCIÓN', symbol:'g', title:s.ay < -0.5 ? 'La Tierra sigue tirando.' : 'Un descenso casi uniforme.', copy:s.ay < -0.5 ? 'La fuerza neta apunta hacia abajo y la velocidad descendente aumenta. La resistencia del aire apunta hacia arriba porque se opone al movimiento.' : 'El empuje y el aire casi equilibran el peso. Una aceleración pequeña conserva una velocidad de descenso que puede ser distinta de cero.', equation:'aᵧ = (Tᵧ + Dᵧ − mg) / m', caption:'Segunda ley de Newton, eje vertical', note:'El peso no depende de si el cohete sube o baja. La resistencia sí cambia con su velocidad.'};
  return {id:'02', category:'SEGUNDA LEY DE NEWTON', symbol:'a', title:'La fuerza cambia el movimiento.', copy:'La aceleración depende de la fuerza neta y de la masa. Si el empuje vertical supera al peso y la resistencia, la velocidad hacia arriba aumenta.', equation:'ΣF = m · a', caption:'Segunda ley de Newton', note:'Al consumir combustible hay menos masa: con el mismo empuje, la aceleración aumenta.'};
}
