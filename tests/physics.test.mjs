import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG as C,createState,forcesOf,massOf,step,captureConditions,lessonFor,clamp} from '../src/physics.js';

const close=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected} (±${tolerance})`);
const flying=(changes={})=>Object.assign(createState('practice'),{x:-60,y:200,vx:0,vy:0,throttle:0,...changes});
const crossing=(changes={})=>flying({x:0,y:100.015,vy:-3,milestone:true,...changes});

test('el suelo equilibra el peso antes del despegue',()=>{
  const s=createState(),f=forcesOf(s);close(f.normal,f.weight);close(f.ay,0);
  for(let i=0;i<600;i++)step(s);
  close(s.y,12);close(s.vy,0);close(s.fuel,C.initialFuel);assert.equal(s.status,'ready');
});
test('el empuje insuficiente consume combustible sin atravesar el suelo',()=>{
  const s=createState();s.throttle=.2;
  for(let i=0;i<120;i++)step(s);
  close(s.y,12);close(s.vy,0);assert.ok(s.fuel<C.initialFuel);assert.equal(s.onPad,true);
});
test('el empuje que supera al peso produce despegue',()=>{
  const s=createState();s.throttle=1;step(s);
  assert.equal(s.status,'flying');assert.ok(s.vy>0);assert.ok(s.ay>0);assert.equal(s.onPad,false);
});
test('caída libre desde reposo: a = −g sin resistencia inicial',()=>{
  const s=flying(),f=forcesOf(s);close(f.ay,-C.gravity);step(s);close(s.vy,-C.gravity*C.fixedStep);
});
test('el motor apagado no anula la velocidad ascendente',()=>{
  const s=flying({vy:15});step(s);assert.ok(s.vy>0 && s.vy<15);assert.ok(s.ay<0);assert.ok(s.y>200);
  assert.equal(lessonFor(s).id,'03');
});
test('consumo según impulso específico y reducción de masa',()=>{
  const s=flying({throttle:.7}),initial=massOf(s);step(s);
  const expected=.7*C.maxThrust/(C.specificImpulse*C.gravity)*C.fixedStep;
  close(initial-massOf(s),expected);close(s.fuel,800-expected);
});
test('sin combustible el motor no produce fuerza aunque se solicite potencia',()=>{
  const s=flying({fuel:0,throttle:1});close(forcesOf(s).thrust,0);step(s);close(s.fuel,0);close(s.vy,-C.gravity*C.fixedStep);
});
test('el último paso limita el impulso al combustible disponible',()=>{
  const s=flying({fuel:.01,throttle:1});step(s);
  assert.equal(s.fuel,0);assert.ok(s.vy < 0);assert.ok(s.vy> -C.gravity*C.fixedStep);
  step(s);assert.equal(s.fuel,0);
});
test('menos masa implica más aceleración con el mismo empuje',()=>{
  const heavy=flying({fuel:1000,throttle:.7}),light=flying({fuel:100,throttle:.7});
  assert.ok(forcesOf(light).ay>forcesOf(heavy).ay);
});
test('orientar el cohete descompone el empuje correctamente',()=>{
  const s=flying({angle:Math.PI/6,throttle:1}),f=forcesOf(s);
  close(f.tx,30000);close(f.ty,60000*Math.cos(Math.PI/6));
  close(Math.hypot(f.tx,f.ty),60000);
});
test('el aire siempre se opone al movimiento y pierde intensidad con la altura',()=>{
  for(const [vx,vy] of [[5,12],[-5,-12],[0,25],[18,0]]){
    const f=forcesOf(flying({vx,vy}));assert.ok(f.dx*vx+f.dy*vy<0);
  }
  assert.ok(Math.abs(forcesOf(flying({y:1000,vy:20})).dy)<Math.abs(forcesOf(flying({y:100,vy:20})).dy));
});
test('una aceleración hacia arriba puede frenar un descenso',()=>{
  const s=flying({vy:-8,throttle:.7});step(s);assert.ok(s.vy<0 && s.vy> -8);assert.ok(s.ay>0);assert.equal(lessonFor(s).id,'05');
});
test('el giro tiene inercia amortiguada y no vuelve solo a la vertical',()=>{
  const s=flying({throttle:.5});for(let i=0;i<120;i++)step(s,{rotation:1});
  assert.ok(s.angle>0);const angle=s.angle;
  for(let i=0;i<120;i++)step(s);
  assert.ok(s.angle>angle);assert.ok(Math.abs(s.omega)<.02);
});
test('captura suave descendente entre los brazos',()=>{
  const s=crossing();step(s);assert.equal(s.status,'captured');close(s.x,0);close(s.y,100);close(s.vy,0);assert.ok(s.capture.vy<0);
});
test('los brazos no capturan al cruzar hacia arriba',()=>{
  const s=crossing({y:99.99,vy:3});step(s);assert.equal(s.status,'flying');
});
for(const [label,changes,reason] of [
  ['demasiado rápido',{vy:-8},'vertical'],
  ['velocidad lateral alta',{vx:4},'horizontal'],
  ['inclinado',{angle:.3},'angle'],
  ['aún girando',{omega:.5},'angle'],
  ['sin cota de misión',{mode:'mission',milestone:false},'milestone'],
])test(`rechaza captura: ${label}`,()=>{
  const s=crossing(changes);step(s);assert.equal(s.status,'crashed');assert.equal(s.outcome,reason);
});
test('pasar lejos de los brazos no produce una captura invisible',()=>{
  const s=crossing({x:-30});step(s);assert.equal(s.status,'flying');
});
test('el contacto con un brazo fuera del corredor termina en colisión',()=>{
  const s=crossing({x:10});step(s);assert.equal(s.status,'crashed');assert.equal(s.outcome,'alignment');
});
test('la torre equilibra el peso después de una captura',()=>{
  const s=crossing();step(s);const f=forcesOf(s);close(f.ay,0);close(f.normal,f.weight);
});
test('los umbrales de captura aceptan el límite y rechazan el exceso',()=>{
  const s=crossing({x:8,vy:-6,vx:3.5,angle:C.maxCaptureAngle,omega:C.maxCaptureAngularSpeed});
  assert.ok(Object.values(captureConditions(s)).every(Boolean));
  assert.equal(captureConditions({...s,x:8.001}).position,false);
  assert.equal(captureConditions({...s,vy:-6.001}).vertical,false);
  assert.equal(captureConditions({...s,vx:3.501}).horizontal,false);
  assert.equal(captureConditions({...s,omega:C.maxCaptureAngularSpeed+.001}).rotation,false);
});
test('sin motor, la resistencia disipa energía mecánica',()=>{
  const s=flying({vx:5,vy:20});
  const energy=()=>massOf(s)*(C.gravity*s.y+.5*(s.vx*s.vx+s.vy*s.vy));
  const initial=energy();for(let i=0;i<120;i++)step(s);
  assert.ok(energy()<initial);
});
test('salir de la región jugable finaliza el intento',()=>{
  const s=flying({x:C.worldLimit+1});step(s);assert.equal(s.status,'crashed');assert.equal(s.outcome,'range');
});
test('la colisión considera el volumen del cohete y la estructura',()=>{
  const ground=flying({y:12.001,vy:-2});step(ground);assert.equal(ground.outcome,'ground');
  const tower=flying({x:21,y:90,vx:3});step(tower);assert.equal(tower.outcome,'tower');
});
test('los estados finales no consumen combustible ni siguen integrando',()=>{
  const s=crossing();step(s);const copy=structuredClone(s);for(let i=0;i<100;i++)step(s,{rotation:1,throttleDelta:1});assert.deepEqual(s,copy);
});
test('los controles limitan la potencia al intervalo físico',()=>{
  const s=flying({throttle:1});step(s,{throttleDelta:100});assert.equal(s.throttle,1);
  step(s,{throttleDelta:-1000});assert.equal(s.throttle,0);
});

// This test-only pilot uses the same throttle/attitude inputs as a player.
// No position, velocity, fuel or capture state is overwritten during the flight.
function flyScenario(mode) {
  const s=createState(mode);let returning=mode==='practice',steps=0;
  while(['ready','flying'].includes(s.status) && steps++<120*100){
    if(!returning && s.milestone && Math.abs(s.x)<2 && Math.abs(s.vx)<1 && s.y>195)returning=true;
    const desiredVx=clamp((0-s.x)*.22,-7,7);
    const ax=clamp((desiredVx-s.vx)*.9,-3.2,3.2);
    const desiredVy=returning?-clamp((s.y-C.targetY)*.22,2.4,9):clamp((220-s.y)*.28,-9,24);
    const ay=clamp((desiredVy-s.vy)*1.25,-6,8);
    const f=forcesOf(s),theta=Math.atan2(ax,ay+C.gravity);
    const rotation=clamp((theta-s.angle)*16-s.omega*4,-1,1);
    s.throttle=clamp((f.mass*(ay+C.gravity)-f.dy)/(C.maxThrust*Math.cos(s.angle)),0,1);
    step(s,{rotation});
  }
  return s;
}
test('una misión completa alcanza 160 m y regresa con captura válida y combustible',()=>{
  const s=flyScenario('mission');
  assert.equal(s.status,'captured',JSON.stringify({status:s.status,outcome:s.outcome,x:s.x,y:s.y,vy:s.vy,time:s.time,fuel:s.fuel}));
  assert.ok(s.maxAltitude>=C.missionAltitude);assert.ok(s.fuel>0);assert.ok(s.capture.time>10);
});
test('la aproximación inicial también permite completar una captura',()=>{
  const s=flyScenario('practice');assert.equal(s.status,'captured',JSON.stringify(s));assert.ok(s.fuel>0);
});
test('la simulación es determinista con los mismos controles y pasos',()=>{
  assert.deepEqual(flyScenario('mission'),flyScenario('mission'));
});
