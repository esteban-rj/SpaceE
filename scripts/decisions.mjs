import { DECISION_STAGES, PROFILES } from '../src/autopilot.js';
import { CONFIG } from '../src/physics.js';

const MODEL = 'gpt-6-luna';
const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
const TOKEN_PRICE = 0.10 / 1_000_000;
const QUESTION = 'landing_profile';

export class DecisionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function decisionRequest(telemetry) {
  const stage = DECISION_STAGES.find(item => item.id === telemetry?.stage);
  const previousProfile = telemetry?.previousProfile;
  if (!stage || (previousProfile !== null && (typeof previousProfile !== 'string' || !Object.hasOwn(PROFILES, previousProfile)))) {
    throw new DecisionError(400, 'La fase o maniobra anterior no es válida.');
  }
  const launching = stage.id === 'launch';
  const launchOffset = CONFIG.launchX - CONFIG.targetX;
  const limits = {
    altitude: launching ? [stage.altitude, stage.altitude] : [100, 144],
    offset: launching ? [launchOffset, launchOffset] : [-50, 50],
    verticalSpeed: [-30, 10], horizontalSpeed: [-20, 20], angle: [-45, 45], fuel: [0, CONFIG.initialFuel],
  };

  const readings = {};
  for (const [field, [min, max]] of Object.entries(limits)) {
    const value = telemetry[field];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new DecisionError(400, 'La telemetría del vuelo no es válida.');
    }
    readings[field] = Number(value.toFixed(2));
  }

  return {
    model: MODEL,
    input: `Educational 2D rocket game. Simulated telemetry in SI units, angle in degrees: ${JSON.stringify({stage: stage.id, previousProfile, ...readings})}. ` +
      `The mission must reach ${CONFIG.missionAltitude} m before returning to the tower. Catch at ${CONFIG.targetY} m while descending at 0–${CONFIG.maxCaptureVerticalSpeed} m/s, offset within ±${CONFIG.captureHalfWidth} m, lateral speed at most ${CONFIG.maxCaptureHorizontalSpeed} m/s and tilt within ±12 degrees. Positive vertical speed is upward.`,
    questions: [{
      type: 'choice',
      name: QUESTION,
      instructions: launching
        ? 'Choose the ascent profile from the launch pad. Favor precision for low starting fuel or an unstable start, economy for a steady launch with ample fuel, and balanced otherwise. The game controller climbs above the mission altitude and steers back to the tower.'
        : 'Choose a profile for this flight segment. Favor precision when near the arms, moving sideways quickly, or off center. Favor economy farther from the arms if already aligned and steady. Use balanced otherwise. The local controller will track the chosen profile and slow down as it nears the arms.',
      choices: Object.entries(PROFILES).map(([value, profile]) => ({
        value,
        description: launching
          ? `Ascent speed target up to ${profile.ascentSpeed} m/s and lateral correction gain ${profile.alignment}. ${profile.label}.`
          : `Descend at up to ${profile.cruiseSpeed} m/s, target ${profile.captureSpeed} m/s at the arms, lateral correction gain ${profile.alignment}. ${profile.label}.`,
      })),
    }],
  };
}

export async function requestDecision(telemetry, { apiKey, signal, fetchImpl = fetch } = {}) {
  const body = decisionRequest(telemetry);
  if (!apiKey) {
    throw new DecisionError(503, 'Agrega OPENAI_API_KEY al archivo .env de SpaceE y reinicia el servidor.');
  }

  let response;
  try {
    response = await fetchImpl(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
  } catch {
    throw new DecisionError(502, 'No se recibió respuesta de OpenAI. Revisa la conexión o toma el control manual.');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new DecisionError(503, 'OpenAI rechazó la clave. Revisa OPENAI_API_KEY en el archivo .env de SpaceE y reinicia el servidor.');
    }
    if (response.status === 403 || response.status === 404) {
      throw new DecisionError(503, 'Revisa que tu proyecto tenga acceso a Decisions (gpt-6-luna).');
    }
    if (response.status === 429) {
      throw new DecisionError(503, 'OpenAI alcanzó un límite de uso. Revisa la cuota del proyecto.');
    }
    throw new DecisionError(502, 'OpenAI no pudo procesar la decisión. Puedes tomar el control manual.');
  }

  const data = await response.json().catch(() => null);
  const tokens = data?.usage?.input_tokens;
  const usage = Number.isSafeInteger(tokens) && tokens >= 0
    ? { inputTokens: tokens, estimatedUsd: tokens * TOKEN_PRICE }
    : null;
  const answer = Array.isArray(data?.answers) && data.answers.find(item => item?.name === QUESTION);
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(PROFILES, answer.choice)) {
    return { profile: null, usage, error: 'OpenAI no devolvió una maniobra válida. Puedes tomar el control manual.' };
  }
  return { profile: answer.choice, usage };
}
