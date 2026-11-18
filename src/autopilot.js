import { CONFIG, clamp, forcesOf } from './physics.js';

export const DECISION_STAGES = [
  { id: 'launch', altitude: CONFIG.rocketHeight / 2, label: 'Despegue' },
  { id: 'approach', altitude: 143, label: 'Aproximación' },
  { id: 'brake', altitude: 125, label: 'Frenado' },
  { id: 'capture', altitude: 110, label: 'Captura final' },
];

export const PROFILES = {
  precision: { label: 'Precisión', ascentSpeed: 17, cruiseSpeed: 4.4, captureSpeed: 2.2, alignment: 0.36 },
  balanced: { label: 'Equilibrio', ascentSpeed: 21, cruiseSpeed: 6.2, captureSpeed: 3.0, alignment: 0.30 },
  economy: { label: 'Ahorro de combustible', ascentSpeed: 24, cruiseSpeed: 8.0, captureSpeed: 4.0, alignment: 0.26 },
};

const TURN_ALTITUDE = CONFIG.missionAltitude + 30;

export function nextDecisionStage(state, index) {
  const stage = DECISION_STAGES[index];
  if (!stage) return null;
  if (stage.id === 'launch') return state.onPad ? stage : null;
  return state.milestone && state.vy < 0 && state.y <= stage.altitude ? stage : null;
}

export function decisionTelemetry(state, stage, previousProfile) {
  const round = value => Number(value.toFixed(2));
  return {
    stage: stage.id,
    previousProfile,
    altitude: round(state.y),
    offset: round(state.x - CONFIG.targetX),
    verticalSpeed: round(state.vy),
    horizontalSpeed: round(state.vx),
    angle: round(state.angle * 180 / Math.PI),
    fuel: round(state.fuel),
  };
}

// Track the selected speed and alignment profile through the ordinary flight controls.
export function automaticControls(state, profileId) {
  const profile = PROFILES[profileId];
  const ascending = state.maxAltitude < TURN_ALTITUDE;
  const height = state.y - CONFIG.targetY;
  const blend = clamp((height - 4) / 22, 0, 1);
  const descentSpeed = profile.captureSpeed + blend * (profile.cruiseSpeed - profile.captureSpeed);
  const targetVy = ascending ? clamp((TURN_ALTITUDE + 9 - state.y) * 0.32, 4, profile.ascentSpeed) : -descentSpeed;
  const lateralLimit = ascending ? 9 : 4;
  const targetVx = clamp((CONFIG.targetX - state.x) * profile.alignment, -lateralLimit, lateralLimit);
  const targetAx = clamp((targetVx - state.vx) * 1.2, -2.5, 2.5);
  const targetAy = clamp((targetVy - state.vy) * 1.8, -4.5, 5.5);
  const { mass, dx, dy, weight } = forcesOf(state);
  const thrustX = mass * targetAx - dx;
  const thrustY = weight + mass * targetAy - dy;
  const targetAngle = clamp(Math.atan2(thrustX, thrustY), -0.27, 0.27);
  const throttle = clamp(thrustY / (CONFIG.maxThrust * Math.max(0.8, Math.cos(state.angle))), 0, 1);
  const rotation = state.onPad ? 0 : clamp((targetAngle - state.angle) * 15 - state.omega * 3, -1, 1);
  return { throttleDelta: (throttle - state.throttle) / CONFIG.fixedStep, rotation };
}
