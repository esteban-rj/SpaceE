import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, createState, step } from '../src/physics.js';
import { automaticControls, DECISION_STAGES, decisionTelemetry, nextDecisionStage, PROFILES } from '../src/autopilot.js';
import { decisionRequest, requestDecision } from '../scripts/decisions.mjs';

const profileIds = Object.keys(PROFILES);
const firstTelemetry = () => decisionTelemetry(createState('automatic'), DECISION_STAGES[0], null);

test('las 81 secuencias despegan, superan la cota y llegan a los brazos con cuatro decisiones', () => {
  const sequences = DECISION_STAGES.reduce(
    options => options.flatMap(sequence => profileIds.map(profile => [...sequence, profile])),
    [[]],
  );
  const captures = new Map();
  for (const profiles of sequences) {
    const flight = createState('automatic');
    assert.equal(flight.onPad, true);
    assert.equal(flight.milestone, false);
    assert.equal(flight.fuel, CONFIG.initialFuel);
    const stages = [];
    let profile = null;
    for (let i = 0; i < 60 / CONFIG.fixedStep; i++) {
      if (flight.status !== 'ready' && flight.status !== 'flying') break;
      const stage = nextDecisionStage(flight, stages.length);
      if (stage) {
        assert.doesNotThrow(() => decisionRequest(decisionTelemetry(flight, stage, profile)));
        if (stage.id === 'launch') assert.equal(flight.time, 0);
        else assert.ok(flight.milestone && flight.vy < 0);
        profile = profiles[stages.length];
        stages.push(stage.id);
      }
      step(flight, automaticControls(flight, profile));
    }
    assert.equal(flight.status, 'captured', profiles.join(', '));
    assert.ok(flight.maxAltitude >= CONFIG.missionAltitude);
    assert.deepEqual(stages, ['launch', 'approach', 'brake', 'capture']);
    assert.ok(Math.abs(flight.capture.vy) <= CONFIG.maxCaptureVerticalSpeed);
    captures.set(profiles.join(','), flight.capture.vy);
  }
  assert.ok(Math.abs(captures.get('balanced,balanced,balanced,precision')) < Math.abs(captures.get('balanced,balanced,balanced,economy')));
});

test('Decisions solicita una elección a gpt-6-luna y calcula el coste con los tokens devueltos', async () => {
  const result = await requestDecision(firstTelemetry(), {
    apiKey: 'clave-de-prueba',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/decisions');
      assert.equal(options.headers.Authorization, 'Bearer clave-de-prueba');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-6-luna');
      assert.match(body.input, /"stage":"launch"/);
      assert.equal(body.questions[0].type, 'choice');
      assert.match(body.questions[0].choices[0].description, /Ascent speed/);
      assert.deepEqual(body.questions[0].choices.map(choice => choice.value), profileIds);
      return Response.json({
        answers: [{ name: 'landing_profile', type: 'choice', choice: 'precision' }],
        usage: { input_tokens: 310, output_tokens: 20 },
      });
    },
  });
  assert.equal(result.profile, 'precision');
  assert.equal(result.usage.inputTokens, 310);
  assert.equal(result.usage.estimatedUsd.toFixed(6), '0.000031');
});

test('la ruta rechaza telemetría inválida y solo incluye los campos de vuelo permitidos', () => {
  assert.throws(() => decisionRequest({ ...firstTelemetry(), altitude: 9999 }), { status: 400 });
  assert.throws(() => decisionRequest({ ...firstTelemetry(), previousProfile: ['precision'] }), { status: 400 });
  const request = decisionRequest({ ...firstTelemetry(), extra: 'no enviar este texto' });
  assert.doesNotMatch(request.input, /no enviar/);
});

test('una respuesta fuera de catálogo no mueve el cohete y conserva el consumo reportado', async () => {
  const result = await requestDecision(firstTelemetry(), {
    apiKey: 'clave-de-prueba',
    fetchImpl: async () => Response.json({
      answers: [{ name: 'landing_profile', type: 'choice', choice: ['precision'] }],
      usage: { input_tokens: 300 },
    }),
  });
  assert.equal(result.profile, null);
  assert.match(result.error, /maniobra válida/);
  assert.equal(result.usage.inputTokens, 300);
});

test('sin clave no se consulta a OpenAI y los errores del proveedor no se exponen', async () => {
  await assert.rejects(requestDecision(firstTelemetry(), {
    fetchImpl: () => assert.fail('No debe consultar a OpenAI'),
  }), { status: 503, message: /OPENAI_API_KEY/ });
  await assert.rejects(requestDecision(firstTelemetry(), {
    apiKey: 'clave-de-prueba', fetchImpl: async () => new Response('Detalle privado', { status: 401 }),
  }), { status: 503, message: /rechazó la clave/ });
});
