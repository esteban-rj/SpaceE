import { CONFIG, clamp, forcesOf } from './physics.js';

const palette = {thrust:'#c6ed88',weight:'#f3aa77',drag:'#81c8df'};
const seeded = n => { const x = Math.sin(n * 134.37 + 11) * 43758.5453; return x - Math.floor(x); };

export class FlightRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0; this.height = 0; this.cameraX = -28; this.bottom = -24;
    this.scale = 2;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width; this.height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = Math.min(3.35, Math.max(1.48, rect.width / 280));
  }
  reset() { this.cameraX = -28; this.bottom = -24; }
  point(x,y) { return {x:this.width / 2 + (x-this.cameraX)*this.scale,y:this.height - (y-this.bottom)*this.scale}; }
  line(x1,y1,x2,y2,color,width=1) {
    const c=this.ctx; c.beginPath(); c.moveTo(x1,y1); c.lineTo(x2,y2); c.strokeStyle=color; c.lineWidth=width; c.stroke();
  }
  text(text,x,y,color='#a7c4bd',size=8,align='left') {
    const c=this.ctx; c.font=`${size}px ui-monospace, SFMono-Regular, monospace`; c.fillStyle=color; c.textAlign=align; c.fillText(text,x,y);
  }
  draw(state, vectors, elapsed=0) {
    if (!this.width || !this.height) return;
    const worldH=this.height/this.scale;
    const targetBottom=Math.max(-24,state.y-worldH*.62);
    const targetX=state.x < -130 || state.x > 85 ? state.x : -28;
    this.bottom += (targetBottom-this.bottom)*.07;
    this.cameraX += (targetX-this.cameraX)*.06;
    this.drawBackground();
    this.drawGrid(state);
    this.drawLandscape();
    this.drawTarget(state,elapsed);
    this.drawTower(state,elapsed);
    this.drawPad();
    this.drawRocket(state,elapsed);
    if (vectors && state.status !== 'crashed') this.drawForces(state);
    if (state.status === 'crashed') this.drawImpact(state,elapsed);
    this.drawRocketReadout(state);
  }
  drawBackground() {
    const c=this.ctx,w=this.width,h=this.height;
    const sky=c.createLinearGradient(0,0,0,h);
    sky.addColorStop(0,'#142a35'); sky.addColorStop(.6,'#23434b'); sky.addColorStop(1,'#54746d');
    c.fillStyle=sky;c.fillRect(0,0,w,h);
    const glow=c.createRadialGradient(w*.75,h*.85,0,w*.75,h*.85,w*.85);
    glow.addColorStop(0,'#74998324'); glow.addColorStop(1,'#365d6d00');c.fillStyle=glow;c.fillRect(0,0,w,h);
    for(let i=0;i<45;i++){
      const x=seeded(i)*w,y=seeded(i+100)*h*.73;
      c.fillStyle=`rgba(199,223,212,${.12+seeded(i+88)*.35})`;c.fillRect(x,y,seeded(i+50)>.9?1.5:1,1);
    }
    // A soft moon and an orbital arc give the scene depth without external assets.
    const moonX=w*.77,moonY=h*.19;
    c.fillStyle='#a1b8a815';c.beginPath();c.arc(moonX,moonY,22,0,Math.PI*2);c.fill();
    c.fillStyle='#bdcec31c';c.beginPath();c.arc(moonX,moonY,16,0,Math.PI*2);c.fill();
    c.strokeStyle='#a6c1b008';c.lineWidth=1;c.beginPath();c.ellipse(w*.67,h*.42,w*.7,h*.64,-.2,Math.PI,Math.PI*1.83);c.stroke();
  }
  drawGrid(s) {
    const c=this.ctx;
    const minY=Math.max(0,Math.ceil(this.bottom/50)*50),maxY=this.bottom+this.height/this.scale;
    for(let y=minY;y<maxY;y+=50){
      const p=this.point(0,y);
      this.line(0,p.y,this.width,p.y,'#c7decc0c');
      this.line(0,p.y,5,p.y,'#c7decc44');
      if(p.y>124 && p.y<this.height-86) this.text(`${y} m`,11,p.y-7,'#9eb9b277',7);
    }
    const minX=this.cameraX-this.width/this.scale/2;
    for(let x=Math.floor(minX/50)*50;x<minX+this.width/this.scale;x+=50){
      const p=this.point(x,0);this.line(p.x,120,p.x,this.height-90,'#c7decc05');
    }
    if(!s.milestone && s.mode==='mission'){
      const p=this.point(0,CONFIG.missionAltitude);
      if(p.y>115 && p.y<this.height-85){
        c.setLineDash([3,7]);this.line(0,p.y,this.width,p.y,'#c6ed8822');c.setLineDash([]);
        this.text('160 m · COTA DE MISIÓN',this.width-15,p.y-7,'#b6d69c88',7,'right');
      }
    }
  }
  drawLandscape() {
    const c=this.ctx,w=this.width,h=this.height,ground=this.point(0,0).y;
    if(ground>h+100)return;
    const y=Math.min(ground,h+160);
    // Distant coastal silhouettes, all anchored to the ground plane.
    c.fillStyle='#496960';c.beginPath();c.moveTo(0,y-35);
    for(let i=0;i<=22;i++)c.lineTo(i*w/22,y-24-seeded(i+250)*22);
    c.lineTo(w,h+100);c.lineTo(0,h+100);c.fill();
    c.fillStyle='#34564d';c.beginPath();c.moveTo(0,y-18);
    for(let i=0;i<=20;i++)c.lineTo(i*w/20,y-14-seeded(i+330)*13);
    c.lineTo(w,h+100);c.lineTo(0,h+100);c.fill();
    c.fillStyle='#29483f';c.fillRect(0,y,w,h-y+1);
    this.line(0,y,w,y,'#8fa69355');
    for(let i=0;i<32;i++){
      const x=seeded(i+444)*w, yy=y+7+seeded(i+551)*Math.max(1,h-y-10);
      this.line(x,yy,x+3+seeded(i)*10,yy,'#8ba49022');
    }
    const roadY=y+15;this.line(0,roadY,w,roadY,'#92ab9233',3);
    c.setLineDash([9,14]);this.line(0,roadY,w,roadY,'#b8c7a82a');c.setLineDash([]);
  }
  drawPad() {
    const c=this.ctx,p=this.point(CONFIG.launchX,0),z=this.scale;
    c.fillStyle='#172f31';c.fillRect(p.x-17*z,p.y,34*z,3*z);
    c.fillStyle='#76897b';c.fillRect(p.x-11*z,p.y-1.2*z,22*z,1.5*z);
    this.line(p.x-9*z,p.y-1.3*z,p.x+9*z,p.y-1.3*z,'#b5bea144');
    if(p.y<this.height-5 && p.y>0)this.text('PLATAFORMA 01',p.x,p.y+22,'#90aa95',6,'center');
  }
  drawTarget(s,t) {
    const c=this.ctx,z=this.scale,p=this.point(0,CONFIG.targetY);
    if(p.y<110 || p.y>this.height-80 || p.x<30 || p.x>this.width-55){
      const x=clamp(p.x,55,this.width-75),y=clamp(p.y,142,this.height-95);
      this.text(`${p.y>this.height-80?'↓':'↑'} BRAZOS · 100 m`,x,y,'#c7edaa',7,'center');return;
    }
    const glow=c.createRadialGradient(p.x,p.y,2,p.x,p.y,26*z);
    glow.addColorStop(0,'#c6ed8810');glow.addColorStop(1,'#c6ed8800');c.fillStyle=glow;c.fillRect(p.x-26*z,p.y-26*z,52*z,52*z);
    c.setLineDash([3,5]);this.line(p.x-22*z,p.y,p.x+22*z,p.y,'#cbf1a15e');c.setLineDash([]);
    c.strokeStyle=s.status==='captured'?'#d7ffa6':'#c6ed8899';c.lineWidth=1;
    const left=p.x-CONFIG.captureHalfWidth*z,right=p.x+CONFIG.captureHalfWidth*z;
    for(const x of [left,right]){
      c.beginPath();c.moveTo(x+(x===left?5:-5),p.y-10);c.lineTo(x,p.y-10);c.lineTo(x,p.y+10);c.lineTo(x+(x===left?5:-5),p.y+10);c.stroke();
    }
    this.text('CAPTURA',p.x-24*z,p.y-11,'#c5dfad',7,'right');
    this.text('100 m',p.x-24*z,p.y+2,'#b1cda2aa',7,'right');
  }
  drawTower(s,t) {
    const c=this.ctx,z=this.scale,base=this.point(CONFIG.towerLeft,0),top=this.point(CONFIG.towerLeft,CONFIG.towerHeight),w=(CONFIG.towerRight-CONFIG.towerLeft)*z;
    const left=base.x,right=left+w,ground=base.y;
    if(left>this.width+80 || right< -80)return;
    c.fillStyle='#0b22299c';c.fillRect(left+3,top.y+6,w,ground-top.y);
    c.fillStyle='#263e42';c.fillRect(left,top.y,w,ground-top.y);
    c.fillStyle='#4e6461';c.fillRect(left,top.y,2.5*z,ground-top.y);c.fillRect(right-2.5*z,top.y,2.5*z,ground-top.y);
    for(let y=0;y<CONFIG.towerHeight;y+=12){
      const a=this.point(CONFIG.towerLeft,y),b=this.point(CONFIG.towerRight,y+12);
      this.line(a.x+2*z,a.y,b.x-2*z,b.y,'#69807499',1.2*z);
      this.line(a.x+2*z,b.y,b.x-2*z,a.y,'#69807477',1.2*z);
      this.line(a.x,a.y,b.x,a.y,'#8c9e8844',1.2*z);
    }
    c.fillStyle='#9aab91';c.fillRect(left-1.4*z,top.y-2*z,w+2.8*z,2*z);
    c.fillStyle='#213a3b';c.fillRect(left+3*z,top.y+2*z,w-6*z,8*z);
    for(let y=15;y<130;y+=12){const p=this.point(CONFIG.towerRight-4,y);c.fillStyle='#a4c69677';c.fillRect(p.x,p.y,2,2);}
    const mast=this.point(CONFIG.towerRight-3,CONFIG.towerHeight+7);
    this.line(mast.x,mast.y,mast.x,top.y,'#a3b39a88',1);
    c.fillStyle='#f5aa7f';c.beginPath();c.arc(mast.x,mast.y,1.8,0,Math.PI*2);c.fill();
    // Two arms sit at different visual depths, flanking the capture corridor.
    const p=this.point(0,CONFIG.targetY),armRoot=this.point(CONFIG.towerLeft,CONFIG.targetY);
    const armColor=s.status==='captured'?'#d9f6a9':'#a8c196';
    c.fillStyle='#3a5651';c.fillRect(armRoot.x-2*z,p.y-5*z,6*z,14*z);
    this.line(armRoot.x,p.y-2.4*z,p.x-11*z,p.y-2.4*z,'#768f7a',2.5*z);
    this.line(armRoot.x,p.y+3*z,p.x-11*z,p.y+3*z,armColor,2.5*z);
    this.line(p.x-11*z,p.y-2.4*z,p.x-11*z,p.y-6*z,'#b4c99b',1.5*z);
    this.line(p.x-11*z,p.y+3*z,p.x-11*z,p.y-1*z,'#c6dfab',1.5*z);
    this.line(armRoot.x,p.y+2*z,armRoot.x-6*z,p.y-10*z,'#637f6c',1.1*z);
    if(ground<this.height+20)this.text('TORRE DE CAPTURA',left+w/2,ground+21,'#90aa95',6,'center');
  }
  drawRocket(s,t) {
    const c=this.ctx,p=this.point(s.x,s.y),z=this.scale,h=CONFIG.rocketHeight*z,w=CONFIG.rocketRadius*2*z;
    c.save();c.translate(p.x,p.y);c.rotate(s.angle);
    const power=s.fuel>0 && !['crashed','captured'].includes(s.status)?s.throttle:0;
    if(power>.01){
      const flicker=this.reduced?1:1+Math.sin(t*49)*.09+Math.sin(t*73)*.06;
      const len=(8+power*21)*z*flicker;
      const glow=c.createRadialGradient(0,h/2+7*z,0,0,h/2+7*z,len*1.1);
      glow.addColorStop(0,`rgba(245,158,85,${power*.27})`);glow.addColorStop(1,'#f5a55000');c.fillStyle=glow;c.fillRect(-len,h/2-len/2,len*2,len*2);
      const flame=c.createLinearGradient(0,h/2,0,h/2+len);
      flame.addColorStop(0,'#fff5cd');flame.addColorStop(.25,'#ffcf8a');flame.addColorStop(.7,'#e6925588');flame.addColorStop(1,'#d7863d00');
      c.fillStyle=flame;c.beginPath();c.moveTo(-w*.36,h/2-2);c.quadraticCurveTo(-w*.5,h/2+len*.4,0,h/2+len);c.quadraticCurveTo(w*.5,h/2+len*.4,w*.36,h/2-2);c.closePath();c.fill();
      c.fillStyle='#ffffe5';c.beginPath();c.moveTo(-w*.15,h/2-2);c.lineTo(0,h/2+len*.57);c.lineTo(w*.15,h/2-2);c.fill();
    }
    c.fillStyle='#263d43';c.beginPath();c.moveTo(-w*.45,h*.15);c.lineTo(-w*.95,h*.41);c.lineTo(-w*.45,h*.37);c.fill();
    c.beginPath();c.moveTo(w*.45,h*.15);c.lineTo(w*.95,h*.41);c.lineTo(w*.45,h*.37);c.fill();
    const body=c.createLinearGradient(-w/2,0,w/2,0);body.addColorStop(0,'#839997');body.addColorStop(.24,'#d9e4d9');body.addColorStop(.49,'#f1f3e6');body.addColorStop(.7,'#c2cfc5');body.addColorStop(1,'#6d8787');
    c.fillStyle=body;c.beginPath();c.moveTo(-w/2,h/2-3*z);c.lineTo(-w/2,-h*.28);c.quadraticCurveTo(-w*.48,-h*.41,0,-h/2);c.quadraticCurveTo(w*.48,-h*.41,w/2,-h*.28);c.lineTo(w/2,h/2-3*z);c.closePath();c.fill();
    c.fillStyle='#233c43';c.beginPath();c.moveTo(-w/2,-h*.28);c.quadraticCurveTo(-w*.48,-h*.41,0,-h/2);c.quadraticCurveTo(w*.48,-h*.41,w/2,-h*.28);c.fill();
    this.line(-w*.5,-h*.23,w*.5,-h*.23,'#49636366',.7);
    for(let i=0;i<6;i++)this.line(-w*.5,h*.38-i*h*.085,w*.5,h*.38-i*h*.085,'#425f5d30',.5);
    c.fillStyle='#273e43';c.fillRect(-w*.51,h/2-4*z,w*1.02,2*z);
    c.fillStyle='#99aaa0';c.fillRect(-w*.35,h/2-2*z,w*.7,2*z);
    for(const side of [-1,1]){
      c.fillStyle='#233c42';c.fillRect(side<0?-w*.9:w*.44,-h*.26,w*.46,2.6*z);
      this.line(side*w*.45,-h*.225,side*w*.87,-h*.225,'#aabdae66',.7);
      c.fillStyle='#c8e298';c.fillRect(side<0?-w*.63:w*.42,-1*z,w*.21,1.5*z);
    }
    c.save();c.rotate(-Math.PI/2);c.font=`${Math.max(4,1.65*z)}px ui-monospace, monospace`;c.textAlign='center';c.fillStyle='#3b5355';c.fillText('S P A C E E',-h*.02,w*.16);c.restore();
    c.restore();
  }
  arrow(origin,dx,dy,color,label) {
    const c=this.ctx,length=Math.hypot(dx,dy);if(length<3)return;
    const x=origin.x+dx,y=origin.y-dy,a=Math.atan2(-dy,dx);
    this.line(origin.x,origin.y,x,y,color,1.4);
    c.fillStyle=color;c.beginPath();c.moveTo(x,y);c.lineTo(x-6*Math.cos(a-.42),y-6*Math.sin(a-.42));c.lineTo(x-6*Math.cos(a+.42),y-6*Math.sin(a+.42));c.fill();
    this.text(label,x+(dx<0?-7:7),y+(dy>0?-1:8),color,7,dx<0?'right':'left');
  }
  drawForces(s) {
    const p=this.point(s.x,s.y),f=forcesOf(s),factor=this.width<500?.0011:.0016;
    this.arrow(p,f.tx*factor,f.ty*factor,palette.thrust,'T');
    this.arrow(p,0,-f.weight*factor,palette.weight,'mg');
    this.arrow(p,f.dx*factor,f.dy*factor,palette.drag,'D');
    if(s.onPad)this.arrow({x:p.x-12,y:p.y},0,f.normal*factor,'#bfcab9','N');
    if(s.status==='captured')this.arrow({x:p.x-12,y:p.y},0,f.weight*factor,'#bfcab9','N');
  }
  drawImpact(s,t) {
    const c=this.ctx,p=this.point(s.x,s.y),age=Math.max(0,t);
    c.strokeStyle='#efb98544';c.lineWidth=1;c.beginPath();c.arc(p.x,p.y,24,0,Math.PI*2);c.stroke();
    for(let i=0;i<12;i++){
      const a=i*Math.PI/6,len=12+seeded(i+80)*20;
      this.line(p.x+Math.cos(a)*len,p.y+Math.sin(a)*len,p.x+Math.cos(a)*(len+5),p.y+Math.sin(a)*(len+5),'#eac29799');
    }
  }
  drawRocketReadout(s) {
    if(['crashed','captured'].includes(s.status))return;
    const p=this.point(s.x,s.y),x=p.x+CONFIG.rocketRadius*this.scale+17;
    if(p.y<128 || p.y>this.height-85 || x>this.width-55)return;
    this.text(`${s.y.toFixed(1)} m`,x,p.y-9,'#dcebd9',8);
    this.text(`${s.vy>=0?'↑':'↓'} ${Math.abs(s.vy).toFixed(1)} m/s`,x,p.y+5,'#a1bdb1',7);
  }
}
